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
console.log(`\nвсе проверки пройдены: ${n}`);
