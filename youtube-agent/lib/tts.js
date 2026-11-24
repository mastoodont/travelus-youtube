/**
 * Озвучка. Провайдер (переменная VOICE_PROVIDER):
 *   elevenlabs — ElevenLabs API, по сцене на запрос (длительности сцен точные);
 *   google     — Google Cloud Text-to-Speech (бесплатный лимит в месяц), ключ GOOGLE_TTS_API_KEY;
 *   manual     — вы сами записали голос: положите файл data/manual/<id>_<lang>.mp3 (или .m4a/.wav),
 *                длительности сцен распределяются по числу слов;
 *   silent     — тишина нужной длины (только для проверки конвейера).
 * Результат: { audio: файл, durs: { sceneId: секунды } }
 */
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, DATA, DRY, env, log, sh, words } from "./util.js";

const GAP = 0.45; // пауза после сцены, сек
const WPS = CHANNELS.limits.wordsPerSecond;

export const probeDuration = (file) =>
  parseFloat(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]));

function silence(file, sec) {
  sh("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", sec.toFixed(2), "-c:a", "libmp3lame", "-b:a", "96k", file]);
}

async function elevenlabs(text, voiceId, prev, next, file) {
  const key = env("ELEVENLABS_API_KEY");
  if (!key) throw new Error("нет ELEVENLABS_API_KEY");
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      text, model_id: env("ELEVEN_MODEL", "eleven_multilingual_v2"),
      previous_text: prev || undefined, next_text: next || undefined,
      voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.1 },
    }),
  });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 200)}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

const GOOGLE_VOICE = { en: ["en-US", "en-US-Neural2-J"], es: ["es-US", "es-US-Neural2-B"] };

async function google(text, lang, file) {
  const key = env("GOOGLE_TTS_API_KEY");
  if (!key) throw new Error("нет GOOGLE_TTS_API_KEY");
  const [languageCode, def] = GOOGLE_VOICE[lang];
  const name = env(`GOOGLE_VOICE_${lang.toUpperCase()}`, def);
  const r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: { text }, voice: { languageCode, name },
      audioConfig: { audioEncoding: "MP3", sampleRateHertz: 44100, speakingRate: Number(env("GOOGLE_SPEAKING_RATE", "1")) },
    }),
  });
  if (!r.ok) throw new Error(`Google TTS ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  if (!j.audioContent) throw new Error("Google TTS: пустой ответ");
  fs.writeFileSync(file, Buffer.from(j.audioContent, "base64"));
}

/** Склеивает куски в один файл: нормализация + пауза после каждой сцены */
function concat(parts, dir, out) {
  const norm = parts.map((p, i) => {
    const f = path.join(dir, `n${i}.wav`);
    sh("ffmpeg", ["-v", "error", "-y", "-i", p, "-af", `apad=pad_dur=${GAP}`, "-ar", "44100", "-ac", "1", f]);
    return f;
  });
  const list = path.join(dir, "list.txt");
  fs.writeFileSync(list, norm.map((f) => `file '${f}'`).join("\n"));
  sh("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "160k", out]);
  return norm.map((f) => probeDuration(f));
}

export async function synthesize({ id, lang, scenes, dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const provider = env("VOICE_PROVIDER", "elevenlabs");
  const out = path.join(dir, `voice_${lang}.m4a`);
  const timed = scenes.filter((s) => s.narration && s.narration.trim());

  if (provider === "manual") {
    const base = path.join(DATA, "manual", `${id}_${lang}`);
    const src = ["mp3", "m4a", "wav", "aac"].map((e) => `${base}.${e}`).find((f) => fs.existsSync(f));
    if (!src) throw new Error(`нет вашей записи: положите файл ${path.relative(process.cwd(), base)}.mp3`);
    sh("ffmpeg", ["-v", "error", "-y", "-i", src, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "160k", out]);
    const total = probeDuration(out);
    const totalWords = timed.reduce((n, s) => n + words(s.narration), 0) || 1;
    const durs = {};
    for (const s of scenes) durs[s.id] = s.narration ? (total * words(s.narration)) / totalWords : 0;
    return { audio: out, durs };
  }

  const parts = [];
  for (let i = 0; i < timed.length; i++) {
    const s = timed[i];
    const f = path.join(dir, `scene_${s.id}.mp3`);
    if (provider === "silent" || DRY() && provider !== "elevenlabs") silence(f, Math.max(1.5, words(s.narration) / WPS));
    else if (provider === "google") {
      await google(s.narration, lang, f);
      log(`  озвучена сцена ${s.id} (${lang}, google)`);
    } else {
      const voice = env(CHANNELS.channels[lang].voiceEnv);
      if (!voice) throw new Error(`нет ${CHANNELS.channels[lang].voiceEnv} (ID голоса ElevenLabs)`);
      await elevenlabs(s.narration, voice, timed[i - 1]?.narration?.slice(-200), timed[i + 1]?.narration?.slice(0, 200), f);
      log(`  озвучена сцена ${s.id} (${lang})`);
    }
    parts.push(f);
  }
  const lens = concat(parts, dir, out);
  const durs = {};
  timed.forEach((s, i) => (durs[s.id] = lens[i]));
  return { audio: out, durs };
}
