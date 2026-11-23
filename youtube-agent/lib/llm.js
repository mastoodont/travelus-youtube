import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { ROOT, MOCK, env, log } from "./util.js";
import { mockLlm } from "./mock.js";

export const prompt = (name) => fs.readFileSync(path.join(ROOT, "prompts", name), "utf8");

let client;
const MODEL = () => env("CLAUDE_MODEL", "claude-sonnet-5-5");

function extractJson(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error("в ответе нет JSON");
  return JSON.parse(t.slice(a, b + 1));
}

/**
 * Запрос к Claude, ответ — JSON-объект.
 * kind — для режима MOCK_LLM (заготовки); ctx — данные для заготовки.
 */
export async function askJson({ kind, system, user, ctx = {}, maxTokens = 8000 }) {
  if (MOCK()) return mockLlm(kind, ctx);
  if (!env("ANTHROPIC_API_KEY")) throw new Error("нет ANTHROPIC_API_KEY");
  client ||= new Anthropic();
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const msg = await client.messages.create({
      model: MODEL(),
      max_tokens: maxTokens,
      system: system + "\n\nОтвечай ТОЛЬКО одним JSON-объектом, без пояснений и без markdown.",
      messages: [{ role: "user", content: attempt ? user + `\n\n(Прошлый ответ не разобрался как JSON: ${lastErr.message}. Верни корректный JSON.)` : user }],
    });
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    try { return extractJson(text); } catch (e) { lastErr = e; log(`[llm:${kind}] ответ не JSON, повтор`); }
  }
  throw lastErr;
}
