import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./util.js";

/** Заготовки для MOCK_LLM=1: проверка всего конвейера без ключей Claude */
export function mockLlm(kind, ctx) {
  switch (kind) {
    case "plan":
      return { slug: ctx.candidates[0].slug, reason: "mock", angle_en: "mock angle", angle_es: "ángulo de prueba" };
    case "plan_general":
      return { topic_title: "mock general theme", sources: [ctx.candidates[0].slug], reason: "mock", angle_en: "mock angle", angle_es: "ángulo de prueba" };
    case "change":
      return { significant: !!ctx.numbersChanged, summary: ctx.numbersChanged ? "mock: numbers changed" : "" };
    case "script":
      return JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", `script.${ctx.lang}.json`), "utf8"));
    case "factcheck":
      return { ok: true, issues: [] };
    case "report":
      return { report_ru: "Тестовый отчёт (MOCK_LLM): данных за неделю нет.", guidance: "No data yet. Keep videos 3-6 minutes with a worked example." };
    default:
      throw new Error(`mock: неизвестный kind ${kind}`);
  }
}
