import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, nextSlot, parseCsv, sentences, zonedToUtc } from "../lib/util.js";
import { parseLlms } from "../lib/articles.js";
import { validateScript } from "../lib/meta.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok -", name); };

t("CSV: кавычки, запятые и переносы внутри ячейки", () => {
  const rows = parseCsv('slug,lang,body\na,en,"one, two\n\nthree ""q"""\nb,es,x\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].body, 'one, two\n\nthree "q"');
});
t("предложения для субтитров", () => {
  assert.deepEqual(sentences("Hello there. Is it ok? Yes!"), ["Hello there.", "Is it ok?", "Yes!"]);
  assert.deepEqual(sentences("¿Cuánto cuesta? Mucho."), ["¿Cuánto cuesta?", "Mucho."]);
});
t("llms.txt сайта разбирается", () => {
  const txt = "## Analysis (English)\n\n- [Why rates differ](https://www.roamfact.com/en/analysis/rate-vs-market/index.md): excerpt here\n- [Otra](https://www.roamfact.com/es/analysis/rate-vs-market/index.md): resumen\n";
  const r = parseLlms(txt);
  assert.equal(r.length, 2);
  assert.deepEqual([r[0].lang, r[0].slug, r[1].lang], ["en", "rate-vs-market", "es"]);
});
t("пятница 11:00 по Нью-Йорку = 16:00 UTC зимой и 15:00 UTC летом", () => {
  assert.equal(zonedToUtc(2026, 11, 27, 11, 0, "America/New_York"), "2026-11-27T16:00:00.000Z");
  assert.equal(zonedToUtc(2026, 7, 10, 11, 0, "America/New_York"), "2026-07-10T15:00:00.000Z");
});
t("слот публикации: ближайшая пятница после понедельника", () => {
  assert.equal(nextSlot(new Date("2026-11-23T05:00:00Z"), 5, "11:00", "America/New_York"), "2026-11-27T16:00:00.000Z");
});
t("слот не раньше чем через 3 часа", () => {
  assert.equal(nextSlot(new Date("2026-11-27T14:00:00Z"), 5, "11:00", "America/New_York"), "2026-12-04T16:00:00.000Z");
});
t("заготовки сценариев проходят проверку структуры (MOCK)", () => {
  process.env.MOCK_LLM = "1";
  for (const l of ["en", "es"]) {
    const s = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", `script.${l}.json`), "utf8"));
    assert.deepEqual(validateScript(s), []);
  }
});
t("плохой сценарий отклоняется", () => {
  process.env.MOCK_LLM = "1";
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", "script.en.json"), "utf8"));
  s.scenes[2].narration = ""; s.shorts[0].scene_ids = ["zz"]; s.scenes.pop();
  const errs = validateScript(s);
  assert.ok(errs.length >= 3, errs.join("; "));
});
{
  const { pickFormat } = await import("../lib/formats.js");
  const mk = (n, questions = []) => ({ videos: Array.from({ length: n }, () => ({})), questions });
  assert.equal(pickFormat(mk(0)).format, "explainer");
  assert.equal(pickFormat(mk(3)).format, "compare");
  assert.equal(pickFormat(mk(7)).format, "example");
  assert.equal(pickFormat(mk(11)).format, "example"); // вопросов нет → разбор на примере
  const withQ = mk(11, ["Is it cheaper to exchange at home?"]);
  const r = pickFormat(withQ); assert.equal(r.format, "question"); assert.equal(withQ.questions.length, 0);
  n++; console.log("ok - форматы выпусков по кругу, вопрос зрителя берётся из очереди");
}
{
  // ---------- новые и обновлённые статьи, приоритеты ----------
  process.env.MOCK_LLM = "1";
  const { scanChanges, extractNumbers, snapshot } = await import("../lib/changes.js");
  const art = (slug, body, extra = {}) => ({ slug, tags: "", date: "2026-01-01", updated: "", langs: { en: { title: slug, excerpt: "", body } }, ...extra });
  const base = "Sending money costs a fee. The fee is $4 for $500. Compare providers before you send. The rate matters too.";
  const NOW = new Date("2026-11-25T00:00:00Z");
  t("цифры: «$1,000» = «$1000», проценты и даты", () => {
    assert.deepEqual(extractNumbers("Pay $1,000 or $1000 (2.5%) by 2026"), ["$1000", "2.5%", "2026"].sort());
  });
  const st = { videos: [], reports: [] };
  await scanChanges(st, [art("a", base), art("b", base)], NOW);
  assert.deepEqual(Object.keys(st.pending), []); // первый запуск: архив не считается новым
  assert.equal(Object.keys(st.articles).length, 2); n++; console.log("ok - первый запуск: снимок есть, очередь пуста");

  await scanChanges(st, [art("a", base), art("b", base.replace("Compare providers", "Compare  providers,").toUpperCase())], NOW);
  assert.deepEqual(Object.keys(st.pending), []); n++; console.log("ok - регистр, пробелы и запятые — не изменение");

  await scanChanges(st, [art("a", base.replace("Compare providers", "Compare provders")), art("b", base)], NOW);
  assert.deepEqual(Object.keys(st.pending), []); n++; console.log("ok - опечатка игнорируется");

  await scanChanges(st, [art("a", base.replace("$4 for $500", "$6 for $500")), art("b", base)], NOW);
  assert.equal(st.pending.a?.kind, "update");
  assert.ok(st.pending.a.numbersAdded.includes("$6") && st.pending.a.numbersRemoved.includes("$4"));
  n++; console.log("ok - изменились цифры → существенное обновление");

  const fresh = art("c", base, { date: "2026-11-20" }), oldNew = art("d", base, { date: "2025-01-01" });
  await scanChanges(st, [art("a", base.replace("$4 for $500", "$6 for $500")), art("b", base), fresh, oldNew], NOW);
  assert.equal(st.pending.c?.kind, "new"); assert.equal(st.pending.d?.kind, "new"); // не в снимке → новые
  n++; console.log("ok - статья, которой не было в снимке → новая");

  const st2 = { videos: [], reports: [] };
  await scanChanges(st2, [art("x", base, { date: "2026-11-20" }), art("y", base, { date: "2024-01-01" })], NOW);
  assert.deepEqual(Object.keys(st2.pending), ["x"]); n++; console.log("ok - первый запуск: «новой» считается только свежая статья");

  await scanChanges(st, [art("a", "gone")].slice(0, 0).concat([art("b", base)]), NOW);
  assert.deepEqual(Object.keys(st.pending), []); n++; console.log("ok - удалённые с сайта темы уходят из очереди");

  // ---------- выбор темы недели ----------
  process.env.DRY_RUN = "1";
  const { plan } = await import("../steps/plan.js");
  const csv = path.join(ROOT, "fixtures", "articles.csv");
  process.env.ARTICLES_CSV_PATH = csv;
  const s1 = { videos: [], reports: [], questions: [], tg: { messages: {} } };
  const v1 = await plan(s1);
  assert.equal(v1.mode, "general"); assert.ok(v1.slug.startsWith("general-")); assert.ok(v1.sources.length);
  n++; console.log("ok - нет новых/обновлённых статей → ролик на общую тему (2-й приоритет)");
  const { articleUrl } = await import("../lib/util.js");
  assert.match(articleUrl("en", v1.slug, "c"), /roamfact\.com\/en\/\?utm_source=youtube/);
  n++; console.log("ok - ролик на общую тему ведёт на главную страницу языка");

  const s2 = { videos: [], reports: [], questions: [], tg: { messages: {} } };
  const rows = parseCsv(fs.readFileSync(csv, "utf8"));
  const s2a = await (await import("../lib/articles.js")).loadArticles();
  await scanChanges(s2, s2a, NOW);
  s2.articles[s2a[0].slug].hash = "x"; s2.articles[s2a[0].slug].nums = ["$999"]; s2.articles[s2a[0].slug].sent = [];
  const v2 = await plan(s2);
  assert.equal(v2.mode, "update"); assert.equal(v2.format, "explainer"); assert.deepEqual(Object.keys(s2.pending), []);
  n++; console.log("ok - обновлённая статья → ролик 1-го приоритета, тема уходит из очереди");
  const v3 = await plan(s2);
  assert.equal(v3, null); n++; console.log("ok - второй выпуск на ту же неделю не создаётся");
  delete process.env.DRY_RUN; delete process.env.ARTICLES_CSV_PATH;
}
console.log(`\nвсе проверки пройдены: ${n}`);

// ---------- Telegram: кнопки и правки (fetch подменён) ----------
process.env.TELEGRAM_BOT_TOKEN = "T"; process.env.TELEGRAM_CHAT_ID = "42"; delete process.env.DRY_RUN;
const sent = []; let queue = []; let mid = 100;
globalThis.fetch = async (url, opts) => {
  const method = String(url).split("/").pop();
  const body = typeof opts?.body === "string" ? JSON.parse(opts.body) : {};
  if (method === "getUpdates") { const r = queue; queue = []; return { json: async () => ({ ok: true, result: r }) }; }
  sent.push({ method, body });
  return { json: async () => ({ ok: true, result: { message_id: ++mid } }) };
};
const { poll } = await import("../steps/approval.js");
const mkState = (status) => ({ videos: [{ id: "v1", slug: "s", week: "w", status }], tg: { offset: 0, messages: {} }, reports: [] });

{
  const st = mkState("scripted");
  queue = [{ update_id: 1, callback_query: { id: "c", data: "ok:v1", message: { chat: { id: 42 } } } }];
  await poll(st);
  assert.equal(st.videos[0].status, "approved"); assert.equal(st.tg.offset, 2); n++; console.log("ok - кнопка «Утвердить» → approved");
}
{
  const st = mkState("scripted");
  queue = [{ update_id: 5, callback_query: { id: "c", data: "ok:v1", message: { chat: { id: 999 } } } }];
  await poll(st);
  assert.equal(st.videos[0].status, "scripted"); n++; console.log("ok - чужой чат игнорируется");
}
{
  const st = mkState("scripted");
  queue = [{ update_id: 1, callback_query: { id: "c", data: "edit:v1", message: { chat: { id: 42 } } } }];
  await poll(st);
  const promptId = Number(Object.keys(st.tg.messages).find((k) => st.tg.messages[k].kind === "editprompt"));
  queue = [{ update_id: 2, message: { chat: { id: 42 }, text: "Сделай короче", reply_to_message: { message_id: promptId } } }];
  await poll(st);
  assert.equal(st.videos[0].status, "planned"); assert.equal(st.videos[0].comment, "Сделай короче");
  n++; console.log("ok - «Правка» + ответ текстом → сценарий на переписывание");
}
{
  const st = mkState("rendered");
  queue = [{ update_id: 1, callback_query: { id: "c", data: "vok:v1", message: { chat: { id: 42 } } } }];
  await poll(st);
  assert.equal(st.videos[0].status, "ready"); n++; console.log("ok - кнопка «Публиковать» → ready");
}
{
  const { pickFormat } = await import("../lib/formats.js");
  const mk = (n, questions = []) => ({ videos: Array.from({ length: n }, () => ({})), questions });
  assert.equal(pickFormat(mk(0)).format, "explainer");
  assert.equal(pickFormat(mk(3)).format, "compare");
  assert.equal(pickFormat(mk(7)).format, "example");
  assert.equal(pickFormat(mk(11)).format, "example"); // вопросов нет → разбор на примере
  const withQ = mk(11, ["Is it cheaper to exchange at home?"]);
  const r = pickFormat(withQ); assert.equal(r.format, "question"); assert.equal(withQ.questions.length, 0);
  n++; console.log("ok - форматы выпусков по кругу, вопрос зрителя берётся из очереди");
}
{
  const st = mkState("scripted"); st.questions = [];
  queue = [{ update_id: 1, message: { chat: { id: 42 }, text: "/q Как дешевле отправить деньги домой?" } }];
  await poll(st);
  assert.deepEqual(st.questions, ["Как дешевле отправить деньги домой?"]); n++; console.log("ok - /q сохраняет вопрос зрителя");
}
console.log(`\nвсе проверки пройдены: ${n}`);
