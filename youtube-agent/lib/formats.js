/**
 * Форматы выпусков. Чтобы канал не выглядел шаблонным, раз в 4 недели вместо обычного
 * объяснения выходит один из особых форматов (по кругу: сравнение → разбор на примере → ответ на вопрос).
 * Для «ответа на вопрос» нужен вопрос зрителя: пришлите боту `/q текст вопроса`. Если вопросов нет,
 * выходит «разбор на примере».
 */
export const FORMATS = {
  explainer: {
    ru: "обычное объяснение",
    brief: "FORMAT: standard explainer. One clear idea, a worked example with real arithmetic, a short list of what to do.",
  },
  compare: {
    ru: "сравнение двух вариантов",
    brief: "FORMAT: HEAD-TO-HEAD COMPARISON. Build the video around comparing two concrete options from the article (two ways to pay, send or exchange money, two products, two timings). Use at least two \"compare\" scenes with real numbers, state the cost difference for the SAME amount of money, and end with a clear 'choose A if…, choose B if…' rule. Do not recommend a specific company unless the article does.",
  },
  example: {
    ru: "разбор на реальном примере",
    brief: "FORMAT: WORKED CASE STUDY. Walk through ONE concrete traveler situation from start to finish (name no real person; use an everyday persona such as 'a family sending money home' or 'a couple on a week in Mexico'), with real arithmetic at every step, so the viewer can repeat it. Show the 'before' cost and the 'after' cost and what changed it. Use \"steps\" and \"bignumber\" scenes.",
  },
  question: {
    ru: "ответ на вопрос зрителя",
    brief: "FORMAT: ANSWER TO A VIEWER QUESTION. The video answers the question quoted below directly. Open by restating the question in one sentence, answer it in the first 15 seconds, then show the reasoning with a worked calculation from the article, then the caveats ('it depends on…'). If the article cannot fully answer the question, say what it covers and what to check, and never invent figures.",
  },
};

const SPECIAL = ["compare", "example", "question"];

/** Выбирает формат выпуска по номеру выпуска. Каждый 4-й — особый. */
export function pickFormat(state) {
  const n = state.videos.length; // номер нового выпуска, с нуля
  if (n % 4 !== 3) return { format: "explainer" };
  let f = SPECIAL[Math.floor(n / 4) % SPECIAL.length];
  if (f === "question") {
    const q = (state.questions || []).shift();
    if (!q) f = "example";
    else return { format: "question", question: q };
  }
  return { format: f };
}
