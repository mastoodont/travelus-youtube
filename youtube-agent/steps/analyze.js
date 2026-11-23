import { CHANNELS, LANGS, MOCK, DRY, log } from "../lib/util.js";
import { askJson, prompt } from "../lib/llm.js";
import { channelStats, hasCreds } from "../lib/youtube.js";
import { sendMessage } from "../lib/telegram.js";

const pct = (a, b) => `${Math.min(100, Math.round((a / b) * 100))}%`;

/** Пороги YouTube Partner Program для новых каналов с 1 февраля 2027 */
export function progressLines(s) {
  return `${s.handle}: подписчики ${s.subscribers}/1000 (${pct(s.subscribers, 1000)}), часы длинных видео за год ${s.longWatchHours365}/8000 (${pct(s.longWatchHours365, 8000)}), просмотры Shorts за 90 дней ${s.shortsViews90.toLocaleString("en-US")}/20 000 000`;
}

export async function analyze(state) {
  const stats = [];
  for (const lang of LANGS) {
    if (MOCK() || DRY() || !hasCreds(lang)) { log(`аналитика ${lang}: нет доступа к YouTube, пропуск`); continue; }
    try { stats.push(await channelStats(lang)); } catch (e) { log(`аналитика ${lang}: ${e.message}`); }
  }
  if (!stats.length && !MOCK()) { log("аналитики пока нет (каналы не подключены или нет данных)"); return; }
  const res = await askJson({ kind: "report", system: prompt("report.md"), user: JSON.stringify({ stats }), ctx: {}, maxTokens: 2000 });
  const progress = stats.map(progressLines).join("\n");
  state.reports.push({ date: new Date().toISOString().slice(0, 10), stats, report_ru: res.report_ru, guidance: res.guidance });
  state.reports = state.reports.slice(-12);
  await sendMessage(`📊 Отчёт за неделю\n\n${res.report_ru}\n\nПуть к монетизации (порог с 1 февраля 2027):\n${progress || "данных пока нет"}`);
}
