import fs from "node:fs";
import path from "node:path";
import { DRY, env, log } from "./util.js";

const TOKEN = () => env("TELEGRAM_BOT_TOKEN");
const CHAT = () => env("TELEGRAM_CHAT_ID");
export const TG_FILE_LIMIT = 49 * 1024 * 1024;

async function call(method, body, isForm = false) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN()}/${method}`, isForm
    ? { method: "POST", body }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description || r.status}`);
  return j.result;
}

const disabled = () => DRY() || !TOKEN() || !CHAT();
let fake = 1000;

function chunks(text, n = 3900) {
  const out = [];
  let rest = String(text);
  while (rest.length > n) {
    let cut = rest.lastIndexOf("\n", n);
    if (cut < n / 2) cut = n;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  out.push(rest);
  return out;
}

/** buttons: [[{text, data}]] — inline-кнопки. Возвращает id последнего сообщения. */
export async function sendMessage(text, buttons) {
  if (disabled()) { log(`[telegram:dry]\n${text}${buttons ? "\n   кнопки: " + buttons.flat().map((b) => b.text).join(" | ") : ""}`); return ++fake; }
  const parts = chunks(text);
  let id;
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const res = await call("sendMessage", {
      chat_id: CHAT(), text: parts[i], disable_web_page_preview: true,
      ...(last && buttons ? { reply_markup: { inline_keyboard: buttons.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))) } } : {}),
    });
    id = res.message_id;
  }
  return id;
}

export async function sendFile(file, caption, kind = "video", buttons) {
  const size = fs.statSync(file).size;
  if (disabled()) { log(`[telegram:dry] файл ${path.basename(file)} (${(size / 1e6).toFixed(1)} МБ) — ${caption}`); return ++fake; }
  if (size > TG_FILE_LIMIT) return null;
  const form = new FormData();
  form.set("chat_id", CHAT());
  form.set("caption", String(caption).slice(0, 1000));
  if (buttons) form.set("reply_markup", JSON.stringify({ inline_keyboard: buttons.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))) }));
  form.set(kind === "video" ? "video" : "document", new Blob([fs.readFileSync(file)]), path.basename(file));
  if (kind === "video") form.set("supports_streaming", "true");
  const res = await call(kind === "video" ? "sendVideo" : "sendDocument", form, true);
  return res.message_id;
}

export async function getUpdates(offset) {
  if (!TOKEN() || DRY()) return [];
  return call("getUpdates", { offset, timeout: 0, allowed_updates: ["message", "callback_query"] });
}

export async function answerCallback(id, text = "") {
  if (disabled()) return;
  try { await call("answerCallbackQuery", { callback_query_id: id, text }); } catch { /* старые кнопки */ }
}

export const allowedChat = (chatId) => String(chatId) === String(CHAT());
