import { CHANNELS, LANGS, log, words } from "../lib/util.js";
import { articleFor, loadArticles } from "../lib/articles.js";
import { askJson, prompt } from "../lib/llm.js";
import { fill, totalWords, validateScript } from "../lib/meta.js";
import { FORMATS } from "../lib/formats.js";
import { sendMessage } from "../lib/telegram.js";

/** Текст для сценария: одна статья (новая/обновлённая) или несколько статей для ролика на общую тему */
function sourceFor(video, articles, lang) {
  if (video.mode !== "general") {
    const a = articles.find((x) => x.slug === video.slug);
    return a ? articleFor(a, lang) : null;
  }
  const parts = (video.sources || []).map((s) => articles.find((x) => x.slug === s)).filter(Boolean)
    .map((a) => articleFor(a, lang)).filter(Boolean);
  if (!parts.length) return null;
  return {
    title: video.plan.topic_title || parts[0].title,
    body: parts.map((p) => `### ${p.title}\n${p.body}`).join("\n\n"),
    adapted: parts.some((p) => p.adapted),
  };
}

function modeNote(video) {
  const site = "Remember: the video is a teaser, and the full answer lives on the site.";
  if (video.mode === "update") {
    const c = video.change || {};
    return `MODE: UPDATED ARTICLE. The article was just updated with a substantive change: ${c.summary || "(see article)"}${c.numbersAdded?.length ? `\nNumbers added: ${c.numbersAdded.join(", ")}` : ""}${c.numbersRemoved?.length ? `\nNumbers removed or replaced: ${c.numbersRemoved.join(", ")}` : ""}\nBuild the hook around WHAT CHANGED and why it matters to the viewer. Give the one key change and what it means in numbers; send viewers to the article for the full updated details. ${site}`;
  }
  if (video.mode === "general") {
    return `MODE: GENERAL THEME OF THE SITE. There is no new article this week. Theme: ${video.plan.topic_title || ""}. The ARTICLE text below combines up to three site articles; use only their facts. Give one real idea on the theme and invite viewers to browse the guides and calculators on roamfact.com (the link goes to the site home page, so do not point to one specific article). ${site}`;
  }
  return `MODE: NEW ARTICLE. The article was just published. Give the single most useful finding and send viewers to the article for the complete guide. ${site}`;
}

async function writeScript({ video, articles, lang }) {
  const ch = CHANNELS.channels[lang], L = CHANNELS.limits;
  const src = sourceFor(video, articles, lang);
  if (!src) throw new Error(`нет текста статьи ${video.slug}`);
  let issues = [], script, factFlags = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const system = fill(prompt("script.md"), {
      LANGUAGE: lang === "en" ? "English" : "Spanish", LANG_CODE: ch.languageCode, AUDIENCE: ch.audience,
      MIN_WORDS: L.longMinWords, LONG_MINUTES: `${Math.round(L.longMinWords/L.wordsPerSecond/6)/10}–${Math.round(L.longMaxWords/L.wordsPerSecond/6)/10}`, SHORTS_COUNT: L.shortsPerWeek === 1 ? "exactly 1" : `1–${L.shortsPerWeek}`, MAX_WORDS: L.longMaxWords, SHORT_WORDS: Math.floor(L.shortMaxSeconds * L.wordsPerSecond * 0.9),
      ADAPT_NOTE: src.adapted ? "NOTE: the article exists only in another language. Do not translate it: write the script natively, reusing its facts." : "",
      MODE: modeNote(video),
      FORMAT: `${FORMATS[video.format || "explainer"].brief}${video.question ? `\nVIEWER QUESTION: ${video.question}` : ""}`,
      ANGLE: `ANGLE for this channel: ${video.plan[`angle_${lang}`] || ""}`,
      REPORT: video.guidance ? `LAST WEEK'S GUIDANCE: ${video.guidance}` : "",
      COMMENT: video.comment ? `THE OWNER ASKED FOR CHANGES TO THE PREVIOUS DRAFT: ${video.comment}\nPrevious draft title: ${video.langs[lang]?.script?.title || ""}` : "",
      ISSUES: issues.length ? `FIX THESE PROBLEMS FROM THE PREVIOUS ATTEMPT:\n- ${issues.join("\n- ")}` : "",
      ARTICLE_TITLE: src.title, ARTICLE_BODY: src.body,
    });
    script = await askJson({ kind: "script", system, user: "Write the script now.", ctx: { lang }, maxTokens: 12000 });
    const errs = validateScript(script);
    if (errs.length) { issues = errs; log(`  [${lang}] структура (${attempt + 1}/3): ${errs.join("; ")}`); continue; }
    const fc = await askJson({
      kind: "factcheck", system: fill(prompt("factcheck.md"), { ARTICLE_BODY: src.body, SCRIPT: JSON.stringify(script) }),
      user: "Check it.", ctx: {}, maxTokens: 3000,
    });
    if (fc.ok) { factFlags = []; break; }
    factFlags = fc.issues || [];
    issues = factFlags.map((i) => `${i.where}: «${i.claim}» — ${i.problem}. Fix: ${i.fix}`);
    log(`  [${lang}] факт-чек (${attempt + 1}/3): ${factFlags.length} замечаний`);
    if (attempt === 2) break;
  }
  if (validateScript(script).length) throw new Error(`[${lang}] сценарий не прошёл проверку структуры после 3 попыток`);
  return { script, factFlags };
}

function scriptMessage(video) {
  const modeRu = { new: "🆕 новая статья (1-й приоритет)", update: `🔄 существенное обновление статьи (1-й приоритет)${video.change?.summary ? ": " + video.change.summary : ""}`, general: "🌐 общая тема сайта (2-й приоритет, новых и обновлённых статей нет)" }[video.mode || "new"];
  const out = [`📝 Сценарии на неделю ${video.week}\nТема: ${video.mode === "general" ? (video.plan.topic_title || video.slug) : video.slug}\nПричина: ${modeRu}\nФормат: ${FORMATS[video.format || "explainer"].ru}${video.question ? ` (вопрос: «${video.question}»)` : ""}\n${video.plan.reason ? "Почему: " + video.plan.reason : ""}`];
  for (const lang of LANGS) {
    const l = video.langs[lang]; if (!l) continue;
    out.push(`\n━━ ${CHANNELS.channels[lang].handle} ━━\n«${l.script.title}»  (${totalWords(l.script)} слов ≈ ${Math.round(totalWords(l.script) / CHANNELS.limits.wordsPerSecond / 60 * 10) / 10} мин)`);
    for (const s of l.script.scenes) out.push(`\n[${s.id}] ${s.heading || s.type}\n${s.narration}`);
    out.push(`\nShorts: ${l.script.shorts.map((x) => `«${x.title}» (${x.scene_ids.join("+")})`).join("; ")}`);
    if (l.factFlags?.length) out.push(`\n⚠️ Факт-чек оставил замечания:\n${l.factFlags.map((i) => `• ${i.where}: ${i.claim} — ${i.problem}`).join("\n")}`);
  }
  return out.join("\n");
}

export async function scriptStep(state) {
  const todo = state.videos.filter((v) => v.status === "planned");
  if (!todo.length) return;
  const articles = await loadArticles();
  const last = state.reports.at(-1);
  for (const video of todo) {
    const ids = video.mode === "general" ? video.sources : [video.slug];
    if (!ids.every((s) => articles.some((a) => a.slug === s))) { log(`статья для ${video.slug} пропала с сайта`); continue; }
    video.guidance = last?.guidance || "";
    for (const lang of LANGS) {
      log(`сценарий ${video.slug} (${lang})…`);
      const { script, factFlags } = await writeScript({ video, articles, lang });
      video.langs[lang] = { ...(video.langs[lang] || {}), script, factFlags };
    }
    video.comment = ""; video.status = "scripted";
    await sendMessage(scriptMessage(video));
    const mid = await sendMessage("Утвердить оба сценария?\nПрежде чем жать, проверьте: (1) в ролике есть свой расчёт с цифрами из статьи; (2) вы сами досмотрели бы его до конца; (3) он не похож на прошлый выпуск. Слабое — правьте.\nЕсли нужны правки — нажмите «Правка» и ответьте текстом на сообщение бота.", [[
      { text: "✅ Утвердить оба", data: `ok:${video.id}` }, { text: "✏️ Правка", data: `edit:${video.id}` }]]);
    state.tg.messages[mid] = { video: video.id, kind: "script" };
  }
}
