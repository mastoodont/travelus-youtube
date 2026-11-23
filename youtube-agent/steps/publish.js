import fs from "node:fs";
import path from "node:path";
import { CHANNELS, DRY, LANGS, env, log, nextSlot } from "../lib/util.js";
import { chapters } from "../lib/render.js";
import { longDescription, shortDescription } from "../lib/meta.js";
import { drop, get } from "../lib/storage.js";
import { sendFile, sendMessage } from "../lib/telegram.js";
import { addToPlaylist, hasCreds, upload } from "../lib/youtube.js";

const syntheticVoice = () => env("VOICE_PROVIDER", "elevenlabs") !== "manual" && env("DISCLOSE_SYNTHETIC", "1") === "1";
const fmtSlot = (iso, tz) => new Date(iso).toLocaleString("ru-RU", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function slots(lang, now = new Date()) {
  const p = CHANNELS.channels[lang].publish;
  const long = nextSlot(now, p.longDay, p.time, p.tz);
  const after = new Date(long);
  return { long, short1: nextSlot(after, p.short1Day, p.time, p.tz), short2: nextSlot(after, p.short2Day, p.time, p.tz), tz: p.tz };
}

// Квота YouTube Data API: 10 000 единиц в сутки на ПРОЕКТ (сбрасывается в полночь по Тихоокеанскому времени).
// Загрузка видео ≈ 1600, субтитры 400, превью 50, плейлист 50. Два канала по 3 видео за раз не влезают,
// поэтому выпуск загружается в два приёма: длинные + первые Shorts, а вторые Shorts — на следующие сутки.
const COST = { long: 2100, short: 1600 };
const DAILY_BUDGET = 9000;
const ptDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());

function spendable(state, cost) {
  const q = (state.quota = state.quota?.day === ptDay() ? state.quota : { day: ptDay(), used: 0 });
  return q.used + cost <= DAILY_BUDGET;
}
const spend = (state, cost) => { state.quota.used += cost; };

/** Автозагрузка через YouTube API (нужен API-проект, прошедший аудит). Можно прерываться и продолжать. */
async function viaApi(state, video, dir) {
  const api = (video.api ||= { ids: {} });
  const tasks = [];
  for (const lang of LANGS) tasks.push({ key: "long", lang });
  for (const lang of LANGS) tasks.push({ key: "short1", lang });
  for (const lang of LANGS) tasks.push({ key: "short2", lang });
  for (const t of tasks) {
    const id = `${t.key}_${t.lang}`, l = video.langs[t.lang], f = l.files, sl = slots(t.lang, new Date(video.readyAt || Date.now()));
    if (api.ids[id]) continue;
    const idx = t.key === "short2" ? 1 : 0;
    if (t.key !== "long" && !f.shorts[idx]) continue;
    const cost = t.key === "long" ? COST.long : COST.short;
    if (!spendable(state, cost)) { log(`квота на сегодня исчерпана, продолжим завтра (${id})`); return "ready"; }
    try {
      let vid;
      if (t.key === "long") {
        vid = await upload({
          lang: t.lang, file: path.join(dir, f.long), title: l.script.title, tags: l.script.tags, publishAt: sl.long, synthetic: syntheticVoice(),
          description: longDescription({ script: l.script, lang: t.lang, slug: video.slug, week: video.week, chapterLines: l.chapters }),
          thumb: path.join(dir, f.thumb), srt: path.join(dir, f.srt),
        });
        await addToPlaylist(t.lang, vid);
      } else {
        const s = f.shorts[idx], short = l.script.shorts[idx];
        vid = await upload({
          lang: t.lang, file: path.join(dir, s.file), title: s.title, tags: l.script.tags, publishAt: idx ? sl.short2 : sl.short1, synthetic: syntheticVoice(),
          description: shortDescription({ script: l.script, short, lang: t.lang, slug: video.slug, week: video.week, longId: api.ids[`long_${t.lang}`] }),
        });
      }
      api.ids[id] = vid; spend(state, cost);
    } catch (e) {
      if (/quota/i.test(e.message)) { log(`YouTube: квота исчерпана (${id}), повтор позже`); state.quota.used = DAILY_BUDGET; return "ready"; }
      throw e;
    }
  }
  const lines = [];
  for (const lang of LANGS) {
    const l = video.langs[lang], sl = slots(lang, new Date(video.readyAt || Date.now()));
    lines.push(`${CHANNELS.channels[lang].handle}: «${l.script.title}» — ${fmtSlot(sl.long, sl.tz)} (ET)`);
    l.files.shorts.forEach((s, i) => lines.push(`   Short ${i + 1}: «${s.title}» — ${fmtSlot(i ? sl.short2 : sl.short1, sl.tz)} (ET)`));
  }
  await sendMessage(`🚀 Всё запланировано на YouTube (${video.slug}):\n${lines.join("\n")}`);
  return "published";
}

/** Без API-аудита: присылаем готовый пакет, загрузка в Studio занимает пару минут */
async function viaPackage(video, dir) {
  for (const lang of LANGS) {
    const l = video.langs[lang], f = l.files, sl = slots(lang);
    const meta = [
      `📦 ${CHANNELS.channels[lang].handle}`, `Название: ${l.script.title}`,
      `Когда выложить: ${fmtSlot(sl.long, sl.tz)} (по Нью-Йорку)`, `Теги: ${l.script.tags.join(", ")}`,
      `\nОписание:\n${longDescription({ script: l.script, lang, slug: video.slug, week: video.week, chapterLines: l.chapters })}`,
      `\nShorts: ${f.shorts.map((s, i) => `«${s.title}» (${fmtSlot(i ? sl.short2 : sl.short1, sl.tz)})`).join("; ")}`,
      `\nВ Studio отметьте «Изменённый или синтетический контент», если голос синтетический (сейчас: ${syntheticVoice() ? "да" : "нет"}).`,
    ].join("\n");
    await sendMessage(meta);
    for (const name of [f.long, f.thumb, f.srt, ...f.shorts.map((s) => s.file)]) {
      const sent = await sendFile(path.join(dir, name), `${CHANNELS.channels[lang].handle} · ${name}`, "document");
      if (sent === null) await sendMessage(`${name}: больше 50 МБ — скачайте из релиза: ${video.storage?.url}`);
    }
  }
  return "delivered";
}

export async function publish(state) {
  for (const video of state.videos.filter((v) => v.status === "ready")) {
    const dir = get(video.id);
    for (const lang of LANGS) {
      const l = video.langs[lang]; l.chapters ||= chapters(l.script, {}, lang);
      if (!fs.existsSync(path.join(dir, l.files.long))) throw new Error(`нет файла ${l.files.long} для ${video.id}`);
    }
    const useApi = env("YT_API_VERIFIED") === "1" && !DRY() && LANGS.every(hasCreds);
    video.readyAt ||= new Date().toISOString();
    video.status = useApi ? await viaApi(state, video, dir) : await viaPackage(video, dir);
    if (video.status !== "ready") video.publishedAt = new Date().toISOString();
    if (video.status === "published") drop(video.id);
    log(`${video.id}: ${video.status}`);
  }
}
