#!/usr/bin/env node
/**
 * Точка входа агента.  node run.js <команда>
 *   weekly  — понедельник: отчёт → тема недели → сценарии → Telegram на утверждение
 *   tick    — каждый час: читает ответы в Telegram → переписывает/собирает видео → публикует
 *   status  — что с выпусками
 *   demo    — проверка всей цепочки без ключей (тестовые данные, ничего не отправляется)
 */
import fs from "node:fs";
import path from "node:path";
import { DATA, DRY, log, loadState, saveState, ROOT } from "./lib/util.js";
import { analyze } from "./steps/analyze.js";
import { plan } from "./steps/plan.js";
import { scriptStep } from "./steps/script.js";
import { poll, statusText } from "./steps/approval.js";
import { produce } from "./steps/produce.js";
import { publish } from "./steps/publish.js";
import { sendMessage } from "./lib/telegram.js";

const cmd = process.argv[2] || "status";

async function guarded(state, name, fn) {
  try { await fn(state); }
  catch (e) {
    log(`✗ ${name}: ${e.stack || e.message}`);
    try { await sendMessage(`⚠️ Агент: ошибка на шаге «${name}»\n${e.message}`); } catch { /* без Telegram */ }
    state._failed = true;
  }
  saveState(state); // сохраняем после каждого шага, чтобы не потерять прогресс
}

async function main() {
  if (cmd === "demo") return demo();
  const state = loadState();
  if (cmd === "weekly") {
    await guarded(state, "аналитика", analyze);
    await guarded(state, "тема недели", plan);
    await guarded(state, "сценарии", scriptStep);
  } else if (cmd === "tick") {
    await guarded(state, "Telegram", poll);
    await guarded(state, "сценарии", scriptStep);
    await guarded(state, "сборка видео", produce);
    await guarded(state, "публикация", publish);
  } else if (cmd === "status") {
    console.log(statusText(state));
  } else { console.log("команды: weekly | tick | status | demo"); process.exit(2); }
  if (state._failed) process.exit(1);
}

async function demo() {
  const d = path.join(DATA, "demo"); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true });
  Object.assign(process.env, {
    MOCK_LLM: "1", DRY_RUN: "1", VOICE_PROVIDER: "silent", STORAGE: "local",
    STATE_FILE: path.join(d, "state.json"), ARTICLES_CSV_PATH: path.join(ROOT, "fixtures", "articles.csv"),
  });
  const mod = await import("./lib/util.js");
  log("— ДЕМО: тестовые данные, внешние сервисы не вызываются —");
  const state = mod.loadState();
  await analyze(state); await plan(state); await scriptStep(state);
  state.videos[0].status = "approved"; log("(имитация: вы нажали «Утвердить»)");
  await produce(state);
  state.videos[0].status = "ready"; log("(имитация: вы нажали «Публиковать»)");
  await publish(state);
  mod.saveState(state);
  log(`готово. Файлы: ${path.join(DATA, "out", state.videos[0].id)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
