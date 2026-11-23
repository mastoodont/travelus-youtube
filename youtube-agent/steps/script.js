import { CHANNELS, LANGS, log, words } from "../lib/util.js";
import { articleFor, loadArticles } from "../lib/articles.js";
import { askJson, prompt } from "../lib/llm.js";
import { fill, totalWords, validateScript } from "../lib/meta.js";
import { sendMessage } from "../lib/telegram.js";

async function writeScript({ video, article, lang }) {
  const ch = CHANNELS.channels[lang], L = CHANNELS.limits;
  const src = articleFor(article, lang);
  if (!src) throw new Error(`нет текста статьи ${video.slug}`);
  let issues = [], script, factFlags = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const system = fill(prompt("script.md"), {
      LANGUAGE: lang === "en" ? "English" : "Spanish", LANG_CODE: ch.languageCode, AUDIENCE: ch.audience,
      MIN_WORDS: L.longMinWords, LONG_MINUTES: `${Math.round(L.longMinWords/L.wordsPerSecond/6)/10}–${Math.round(L.longMaxWords/L.wordsPerSecond/6)/10}`, SHORTS_COUNT: L.shortsPerWeek === 1 ? "exactly 1" : `1–${L.shortsPerWeek}`, MAX_WORDS: L.longMaxWords, SHORT_WORDS: Math.floor(L.shortMaxSeconds * L.wordsPerSecond * 0.9),
      ADAPT_NOTE: src.adapted ? "NOTE: the article exists only in another language. Do not translate it: write the script natively, reusing its facts." : "",
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
  const out = [`📝 Сценарии на неделю ${video.week}\nТема: ${video.slug}\n${video.plan.reason ? "Почему: " + video.plan.reason : ""}`];
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
    const article = articles.find((a) => a.slug === video.slug);
    if (!article) { log(`статья ${video.slug} пропала с сайта`); continue; }
    video.guidance = last?.guidance || "";
    for (const lang of LANGS) {
      log(`сценарий ${video.slug} (${lang})…`);
      const { script, factFlags } = await writeScript({ video, article, lang });
      video.langs[lang] = { ...(video.langs[lang] || {}), script, factFlags };
    }
    video.comment = ""; video.status = "scripted";
    await sendMessage(scriptMessage(video));
    const mid = await sendMessage("Утвердить оба сценария? Если нужны правки — нажмите «Правка» и ответьте текстом на сообщение бота.", [[
      { text: "✅ Утвердить оба", data: `ok:${video.id}` }, { text: "✏️ Правка", data: `edit:${video.id}` }]]);
    state.tg.messages[mid] = { video: video.id, kind: "script" };
  }
}
