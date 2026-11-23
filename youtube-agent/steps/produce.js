import fs from "node:fs";
import path from "node:path";
import { CHANNELS, LANGS, env, log } from "../lib/util.js";
import { synthesize } from "../lib/tts.js";
import { chapters, renderLong, renderShort, renderThumb } from "../lib/render.js";
import { dirFor, put } from "../lib/storage.js";
import { sendFile, sendMessage } from "../lib/telegram.js";

async function produceOne(video) {
  const dir = dirFor(video.id); fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const lang of LANGS) {
    const l = video.langs[lang], script = l.script;
    log(`озвучка ${lang}…`);
    const { audio, durs } = await synthesize({ id: video.id, lang, scenes: script.scenes, dir: path.join(dir, `audio_${lang}`) });
    log(`видео 16:9 ${lang}…`);
    const long = renderLong({ script, lang, audio, durs, dir });
    const shorts = script.shorts.slice(0, CHANNELS.limits.shortsPerWeek || 2).map((sh, i) => {
      log(`Short ${i + 1} ${lang}…`);
      return { ...renderShort({ script, short: sh, idx: i + 1, lang, audio, durs, dir }), title: sh.title, hook: sh.hook };
    });
    const thumb = renderThumb({ script, lang, file: path.join(dir, `thumb_${lang}.png`) });
    l.files = {
      long: path.basename(long.file), srt: path.basename(long.srtFile), thumb: path.basename(thumb),
      shorts: shorts.map((s) => ({ file: path.basename(s.file), title: s.title, hook: s.hook, duration: Math.round(s.duration) })),
    };
    l.duration = Math.round(long.duration);
    l.chapters = chapters(script, durs, lang);
    files.push(long.file, long.srtFile, thumb, ...shorts.map((s) => s.file));
  }
  return { dir, files };
}

export async function produce(state) {
  for (const video of state.videos.filter((v) => v.status === "approved")) {
    let made;
    try { made = await produceOne(video); }
    catch (e) {
      log(`не удалось собрать ${video.id}: ${e.message}`);
      if (video.lastError !== e.message) { video.lastError = e.message; await sendMessage(`⚠️ Не удалось собрать видео (${video.slug}):\n${e.message}`); }
      continue;
    }
    video.lastError = "";
    const stored = put(video.id, made.files);
    video.storage = stored;
    for (const lang of LANGS) {
      const l = video.langs[lang], f = path.join(made.dir, l.files.long);
      const cap = `${CHANNELS.channels[lang].handle} · ${l.script.title} · ${Math.floor(l.duration / 60)}:${String(l.duration % 60).padStart(2, "0")}`;
      const sent = await sendFile(f, cap, "video");
      if (sent === null) await sendMessage(`${cap}\nФайл больше 50 МБ для Telegram — скачайте из релиза: ${stored.url}`);
    }
    const mid = await sendMessage(`🎬 Видео готовы (${video.slug}): по одному длинному на канал и ${LANGS.map((x) => video.langs[x].files.shorts.length).join("+")} Shorts. Shorts и превью — в релизе: ${stored.url}\nПубликовать?`, [[
      { text: "✅ Публиковать", data: `vok:${video.id}` }, { text: "✏️ Исправить", data: `vno:${video.id}` }]]);
    state.tg.messages[mid] = { video: video.id, kind: "video" };
    video.status = "rendered";
  }
}
