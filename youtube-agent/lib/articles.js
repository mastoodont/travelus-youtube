/**
 * Источник статей сайта. Порядок:
 *  1. ARTICLES_CSV_URL — опубликованный CSV листа «articles» (та же таблица, что у сайта:
 *     колонки slug, lang, title, excerpt, body, tags, minutes, status, published_at);
 *  2. ARTICLES_CSV_PATH — CSV-файл в репозитории;
 *  3. опубликованный сайт: SITE_URL/llms.txt → страницы …/index.md (их строит build.mjs).
 * Результат: [{ slug, tags, date, updated, langs: { en: {title, excerpt, body}, es: {...} } }]
 */
import fs from "node:fs";
import { CHANNELS, LANGS, env, log, parseCsv } from "./util.js";

async function get(url) {
  const r = await fetch(url, { headers: { "user-agent": "roamfact-youtube-agent" } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.text();
}

function fromRows(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!r.slug || !r.lang || !LANGS.includes(r.lang)) continue;
    if (r.status && r.status.trim() && r.status.trim().toLowerCase() !== "published") continue;
    const a = map.get(r.slug) || { slug: r.slug, tags: r.tags || "", date: "", updated: "", langs: {} };
    a.langs[r.lang] = { title: r.title, excerpt: r.excerpt, body: r.body };
    const d = (r.published_at || "").trim().slice(0, 10), u = (r.updated_at || "").trim().slice(0, 10);
    if (d && (!a.date || d < a.date)) a.date = d;
    if (u && u > a.updated) a.updated = u;
    map.set(r.slug, a);
  }
  return [...map.values()];
}

/** Разбор llms.txt, который собирает build.mjs: «- [Заголовок](…/en/analysis/slug/index.md): анонс» */
export function parseLlms(text) {
  const out = [];
  const re = /^- \[(.+?)\]\((https?:\/\/[^)\s]+?\/([a-z]{2})\/analysis\/([^/\s)]+)\/)index\.md\)(?::\s*(.*))?$/gm;
  let m;
  while ((m = re.exec(text))) out.push({ title: m[1], base: m[2], lang: m[3], slug: m[4], excerpt: m[5] || "" });
  return out;
}

async function fromSite() {
  const site = env("SITE_URL", CHANNELS.siteUrl).replace(/\/$/, "");
  const llms = parseLlms(await get(`${site}/llms.txt`));
  const map = new Map();
  for (const e of llms) {
    if (!LANGS.includes(e.lang)) continue;
    const md = await get(`${e.base}index.md`);
    const pub = (md.match(/^(?:Published|Опубликовано|Publicado):\s*(\d{4}-\d{2}-\d{2})/m) || [])[1] || "";
    const body = md.split("\n").filter((l) => !/^#\s|^>\s|^(Источник|Source|Fuente):|^(Опубликовано|Published|Publicado):/.test(l)).join("\n").trim();
    const a = map.get(e.slug) || { slug: e.slug, tags: "", date: "", updated: "", langs: {} };
    a.langs[e.lang] = { title: e.title, excerpt: e.excerpt, body };
    if (pub && (!a.date || pub < a.date)) a.date = pub;
    map.set(e.slug, a);
  }
  return [...map.values()];
}

export async function loadArticles() {
  let list = [];
  const url = env("ARTICLES_CSV_URL"), file = env("ARTICLES_CSV_PATH");
  if (url) list = fromRows(parseCsv(await get(url)));
  else if (file && fs.existsSync(file)) list = fromRows(parseCsv(fs.readFileSync(file, "utf8")));
  else list = await fromSite();
  log(`статей на сайте: ${list.length}`);
  return list;
}

/** Текст статьи на нужном языке; если нет — на другом (сценарист адаптирует) */
export function articleFor(article, lang) {
  const own = article.langs[lang];
  if (own && own.body) return { ...own, adapted: false };
  const other = Object.values(article.langs).find((x) => x && x.body);
  return other ? { ...other, adapted: true } : null;
}
