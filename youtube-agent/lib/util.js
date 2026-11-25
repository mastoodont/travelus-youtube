import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA = path.join(ROOT, "data");
export const OUT = path.join(DATA, "out");
export const CHANNELS = JSON.parse(fs.readFileSync(path.join(ROOT, "channels.json"), "utf8"));
export const LANGS = Object.keys(CHANNELS.channels);

export const env = (k, d = "") => (process.env[k] ?? d);
/** DRY_RUN=1: ничего не отправляется наружу (Telegram, YouTube), только лог */
export const DRY = () => env("DRY_RUN") === "1";
/** MOCK_LLM=1: вместо Claude используются готовые заготовки (для проверки конвейера без ключей) */
export const MOCK = () => env("MOCK_LLM") === "1";

export function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

export function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28, ...opts });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const words = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).length;

/** Делит текст озвучки на предложения (для субтитров и раскрытия карточек) */
export function sentences(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  return t.split(/(?<=[.!?…]["»”)]?)\s+/).map((s) => s.trim()).filter(Boolean);
}

/** CSV по RFC 4180: кавычки, запятые и переносы внутри ячейки */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false, i = 0;
  text = String(text).replace(/^﻿/, "");
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const head = (rows.shift() || []).map((h) => h.trim());
  return rows.filter((r) => r.some((x) => x.trim() !== "")).map((r) => Object.fromEntries(head.map((h, k) => [h, r[k] ?? ""])));
}

// ---------- состояние (data/state.json, коммитится в репозиторий workflow-ом) ----------
const STATE_FILE = () => env("STATE_FILE", path.join(DATA, "state.json"));

export function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE(), "utf8"));
    s.videos ||= []; s.tg ||= {}; s.tg.offset ||= 0; s.tg.messages ||= {}; s.reports ||= [];
    return s;
  } catch {
    return { videos: [], tg: { offset: 0, messages: {} }, reports: [], questions: [] };
  }
}

export function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
  fs.writeFileSync(STATE_FILE(), JSON.stringify(s, null, 2) + "\n");
}

export function mondayOf(d = new Date()) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay() + 6) % 7;
  x.setUTCDate(x.getUTCDate() - dow);
  return x.toISOString().slice(0, 10);
}

export function articleUrl(lang, slug, campaign, medium = "video") {
  const ch = CHANNELS.channels[lang];
  // ролик на общую тему сайта (slug «general-…») ведёт на главную страницу языка, а не на одну статью
  if (String(slug).startsWith("general-")) {
    return `${CHANNELS.siteUrl}/${ch.siteLang}/?${new URLSearchParams({ utm_source: "youtube", utm_medium: medium, utm_campaign: campaign })}`;
  }
  const p = CHANNELS.articlePath.replace("{lang}", ch.siteLang).replace("{slug}", slug);
  const q = new URLSearchParams({ utm_source: "youtube", utm_medium: medium, utm_campaign: campaign });
  return `${CHANNELS.siteUrl}${p}?${q}`;
}

export function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------- расписание публикаций ----------
/** Местное время в часовом поясе tz → момент UTC (ISO). Без внешних библиотек. */
export function zonedToUtc(y, mo, d, h, mi, tz) {
  let t = Date.UTC(y, mo - 1, d, h, mi);
  for (let k = 0; k < 3; k++) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
        .formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    t += Date.UTC(y, mo - 1, d, h, mi) - asUtc;
  }
  return new Date(t).toISOString();
}

/** Ближайший день недели (0=вс … 6=сб) строго после `after`, в указанное местное время */
export function nextSlot(after, dow, time, tz) {
  const [h, mi] = time.split(":").map(Number);
  const base = new Date(after.getTime());
  for (let i = 0; i < 15; i++) {
    const day = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + i));
    if (day.getUTCDay() !== dow) continue;
    const iso = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, mi, tz);
    if (new Date(iso) > new Date(after.getTime() + 3 * 3600 * 1000)) return iso;
  }
  throw new Error("не найден слот публикации");
}
