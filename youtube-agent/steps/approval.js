import { DRY, log } from "../lib/util.js";
import { allowedChat, answerCallback, getUpdates, sendMessage } from "../lib/telegram.js";

const STATUS_RU = { planned: "в работе у сценариста", scripted: "ждёт вашего утверждения сценария", approved: "делается видео", rendered: "ждёт вашей проверки видео", ready: "утверждено, ждёт публикации", published: "опубликовано", delivered: "пакет отправлен вам" };

export function statusText(state) {
  const rows = state.videos.slice(-6).map((v) => `• ${v.week} ${v.slug}: ${STATUS_RU[v.status] || v.status}`);
  return `Статус выпусков:\n${rows.join("\n") || "пока пусто"}`;
}

/** Читает ответы из Telegram: кнопки и текстовые правки. Возвращает число обработанных действий. */
export async function poll(state) {
  const updates = await getUpdates(state.tg.offset);
  let acted = 0;
  const byId = (id) => state.videos.find((v) => v.id === id);
  for (const u of updates) {
    state.tg.offset = u.update_id + 1;
    const cq = u.callback_query;
    if (cq) {
      if (!allowedChat(cq.message?.chat?.id)) continue;
      const [action, ...rest] = String(cq.data).split(":"), v = byId(rest.join(":"));
      if (!v) { await answerCallback(cq.id, "Выпуск не найден"); continue; }
      if (action === "ok" && v.status === "scripted") { v.status = "approved"; acted++; await answerCallback(cq.id, "Утверждено"); await sendMessage(`✅ Сценарии утверждены (${v.slug}). Делаю озвучку и видео, пришлю на проверку.`); }
      else if (action === "vok" && v.status === "rendered") { v.status = "ready"; acted++; await answerCallback(cq.id, "Принято"); await sendMessage(`✅ Видео приняты (${v.slug}). Публикую по расписанию.`); }
      else if (action === "edit" || action === "vno") {
        await answerCallback(cq.id);
        const mid = await sendMessage(`✏️ Что изменить (${v.slug})? Ответьте на это сообщение текстом — сценарии будут переписаны, и я пришлю их снова.`);
        state.tg.messages[mid] = { video: v.id, kind: "editprompt" };
      } else await answerCallback(cq.id, "Это действие уже не актуально");
      continue;
    }
    const m = u.message;
    if (!m || !allowedChat(m.chat?.id) || !m.text) continue;
    const text = m.text.trim();
    if (text === "/status" || text === "/start") { await sendMessage(statusText(state)); continue; }
    const target = m.reply_to_message && state.tg.messages[m.reply_to_message.message_id];
    if (target && (target.kind === "editprompt" || target.kind === "script")) {
      const v = byId(target.video);
      if (v && ["scripted", "rendered"].includes(v.status)) {
        v.comment = text; v.status = "planned"; acted++;
        await sendMessage(`Принято, переписываю сценарии (${v.slug}).`);
      }
    }
  }
  if (updates.length) log(`Telegram: обновлений ${updates.length}, действий ${acted}`);
  return acted;
}
