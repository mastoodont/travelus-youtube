/**
 * Отслеживание новых и обновлённых статей сайта.
 *
 * В state.articles хранится «снимок» каждой статьи: хеш текста, короткие хеши предложений и
 * список цифр (суммы, проценты, даты). Сам текст не хранится, чтобы state.json оставался маленьким.
 * При каждом еженедельном запуске снимок сравнивается с сайтом:
 *  - статьи нет в снимке → «новая»;
 *  - изменились цифры → «существенное обновление» (без вопросов);
 *  - изменились только формулировки → Claude решает, поменялись ли правила/факты
 *    или это опечатки и стиль (опечатки игнорируются);
 *  - изменились только пробелы/регистр/пунктуация → ничего не происходит.
 * Найденное копится в state.pending (очередь тем 1-го приоритета) до выпуска видео по статье.
 */
import crypto from "node:crypto";
import { log, sentences } from "./util.js";
import { askJson, prompt } from "./llm.js";

/** Сколько дней новая статья считается «новой» при самом первом запуске (до первого снимка) */
export const FIRST_RUN_NEW_DAYS = 14;
/** Через сколько дней непрогодившаяся тема из очереди устаревает */
export const PENDING_TTL_DAYS = 42;

const DAY = 86400000;
const sha = (s, n = 40) => crypto.createHash("sha1").update(s).digest("hex").slice(0, n);

/** Текст для сравнения: без markdown, регистра, лишних пробелов */
export function normalize(text) {
  return String(text || "")
    .replace(/[#>*_`|[\]()]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Текст «без пунктуации»: правка запятой или кавычек не должна считаться изменением */
const bare = (t) => normalize(t).replace(/[^\p{L}\p{N}$€£%]+/gu, " ").replace(/\s+/g, " ").trim();

/** Все цифры статьи: суммы, проценты, годы, даты. «$1,000» и «$1000» — одно и то же. */
export function extractNumbers(text) {
  const out = new Set();
  const re = /(?:[$€£]\s?)?\d+(?:[.,]\d+)*(?:\s?%)?/g;
  for (const m of String(text || "").matchAll(re)) {
    let x = m[0].replace(/\s+/g, "");
    x = x.replace(/(\d),(?=\d{3}\b)/g, "$1"); // разделитель тысяч
    out.add(x);
  }
  return [...out].sort();
}

/** Предложения статьи (по строкам и по точкам), уже без пунктуации */
function sentenceList(body) {
  return String(body || "").split(/\n+/).flatMap((l) => sentences(l)).map((s) => ({ raw: s.trim(), key: bare(s) })).filter((s) => s.key.length > 3);
}

/** Основной язык статьи для сравнения: английский, если есть, иначе первый с текстом */
function mainText(article) {
  const l = article.langs.en?.body ? article.langs.en : Object.values(article.langs).find((x) => x?.body);
  return l?.body || "";
}

export function snapshot(article) {
  const body = mainText(article);
  return {
    hash: sha(bare(body)),
    sent: [...new Set(sentenceList(body).map((s) => sha(s.key, 8)))],
    nums: extractNumbers(body),
    updated: article.updated || "",
  };
}

/** Что изменилось между снимком и текущей статьёй (без Claude) */
export function diff(prev, article) {
  const body = mainText(article);
  const now = snapshot(article);
  if (prev.hash === now.hash) return null;
  const old = new Set(prev.sent || []);
  const changed = sentenceList(body).filter((s) => !old.has(sha(s.key, 8))).map((s) => s.raw);
  const cur = new Set(now.sent);
  const removed = (prev.sent || []).filter((h) => !cur.has(h)).length;
  const pn = new Set(prev.nums || []), nn = new Set(now.nums);
  return {
    now,
    changed,
    removed,
    numbersAdded: now.nums.filter((x) => !pn.has(x)),
    numbersRemoved: [...pn].filter((x) => !nn.has(x)),
  };
}

/** Claude: существенная ли правка (правила/факты) или косметика (опечатки, стиль) */
async function judge(article, d) {
  const title = article.langs.en?.title || Object.values(article.langs)[0]?.title || article.slug;
  const numbersChanged = d.numbersAdded.length > 0 || d.numbersRemoved.length > 0;
  const res = await askJson({
    kind: "change", system: prompt("change.md"), ctx: { numbersChanged },
    user: JSON.stringify({
      article_title: title,
      new_or_edited_sentences: d.changed.slice(0, 40),
      sentences_removed: d.removed,
      numbers_added: d.numbersAdded,
      numbers_removed: d.numbersRemoved,
    }),
    maxTokens: 800,
  });
  return {
    // изменение цифр существенно всегда, даже если Claude считает иначе
    significant: numbersChanged || !!res.significant,
    summary: String(res.summary || "").trim(),
  };
}

/**
 * Сравнивает статьи с прошлым снимком, обновляет state.articles и пополняет state.pending.
 * Возвращает список новых записей очереди (для лога).
 */
export async function scanChanges(state, articles, now = new Date()) {
  const firstRun = !state.articles;
  state.articles ||= {};
  state.pending ||= {};
  const used = new Set(state.videos.map((v) => v.slug));
  const found = [];

  for (const a of articles) {
    const prev = state.articles[a.slug];
    if (!prev) {
      state.articles[a.slug] = snapshot(a);
      // при первом запуске «новыми» считаются только свежие статьи без видео,
      // остальное — уже существующий архив сайта (материал для роликов на общую тему)
      const fresh = !firstRun || (!used.has(a.slug) && a.date && now - new Date(a.date) <= FIRST_RUN_NEW_DAYS * DAY);
      if (fresh && !used.has(a.slug)) {
        state.pending[a.slug] = { kind: "new", detectedAt: now.toISOString(), summary: "" };
        found.push({ slug: a.slug, kind: "new" });
      }
      continue;
    }
    const d = diff(prev, a);
    if (!d) continue;
    state.articles[a.slug] = d.now; // следующую правку сравниваем уже с этой версией
    if (!d.changed.length && !d.numbersAdded.length && !d.numbersRemoved.length && !d.removed) continue;
    const j = await judge(a, d);
    if (!j.significant) { log(`  ${a.slug}: правка несущественная (опечатки/стиль) — пропускаю`); continue; }
    const p = state.pending[a.slug];
    if (p?.kind === "new") { log(`  ${a.slug}: обновлена, но видео по ней ещё не было — остаётся «новой»`); continue; }
    state.pending[a.slug] = {
      kind: "update",
      detectedAt: p?.detectedAt || now.toISOString(),
      summary: [p?.summary, j.summary].filter(Boolean).join(" "),
      numbersAdded: [...new Set([...(p?.numbersAdded || []), ...d.numbersAdded])],
      numbersRemoved: [...new Set([...(p?.numbersRemoved || []), ...d.numbersRemoved])],
    };
    found.push({ slug: a.slug, kind: "update", summary: j.summary });
  }

  // статья удалена с сайта или тема слишком долго ждёт в очереди → убираем
  const live = new Set(articles.map((a) => a.slug));
  for (const [slug, p] of Object.entries(state.pending)) {
    if (!live.has(slug) || now - new Date(p.detectedAt) > PENDING_TTL_DAYS * DAY) delete state.pending[slug];
  }
  if (firstRun) log(`первый запуск: снимок ${articles.length} статей сохранён`);
  for (const f of found) log(`  ${f.kind === "new" ? "новая статья" : "существенное обновление"}: ${f.slug}${f.summary ? " — " + f.summary : ""}`);
  return found;
}
