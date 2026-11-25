import { LANGS, log, mondayOf } from "../lib/util.js";
import { loadArticles } from "../lib/articles.js";
import { scanChanges } from "../lib/changes.js";
import { askJson, prompt } from "../lib/llm.js";
import { pickFormat, FORMATS } from "../lib/formats.js";
import { sendMessage } from "../lib/telegram.js";

const hasText = (a) => a && Object.values(a.langs).some((x) => x?.body);
const title = (a) => a.langs.en?.title || Object.values(a.langs)[0]?.title || a.slug;
const daysSince = (iso) => Math.max(0, Math.round((Date.now() - new Date(iso)) / 86400000));

/** Сколько раз и когда по статье уже был выпуск (как основная или как источник общего ролика) */
function coverage(state, slug) {
  const vs = state.videos.filter((v) => v.slug === slug || v.sources?.includes(slug));
  return { times_covered: vs.length, last_covered: vs.at(-1)?.week || "never" };
}

const recentTopics = (state) => state.videos.slice(-5).map((v) => v.plan?.topic_title || v.slug);

/**
 * Тема недели. Один выпуск в неделю, как и раньше.
 *  1-й приоритет: новая или существенно обновлённая статья (если таких несколько — Claude выбирает
 *     по важности и SEO, остальные ждут своей очереди в state.pending);
 *  2-й приоритет: нет ни новых, ни обновлённых — ролик на общую тему сайта.
 */
export async function plan(state) {
  const week = mondayOf();
  if (state.videos.some((v) => v.week === week)) { log(`на неделю ${week} выпуск уже запланирован`); return null; }
  const articles = await loadArticles();
  const bySlug = new Map(articles.map((a) => [a.slug, a]));
  await scanChanges(state, articles);

  const today = new Date().toISOString().slice(0, 10);
  const guidance = state.reports.at(-1)?.guidance || "";
  const queue = Object.entries(state.pending || {}).filter(([slug]) => hasText(bySlug.get(slug)));

  if (queue.length) return planArticle(state, week, queue, bySlug, today, guidance);
  return planGeneral(state, week, articles.filter(hasText), today, guidance);
}

async function planArticle(state, week, queue, bySlug, today, guidance) {
  const candidates = queue.map(([slug, p]) => {
    const a = bySlug.get(slug);
    return {
      slug, title: title(a), excerpt: a.langs.en?.excerpt || "", tags: a.tags, kind: p.kind,
      change_summary: p.summary || "", numbers_added: p.numbersAdded || [], numbers_removed: p.numbersRemoved || [],
      days_waiting: daysSince(p.detectedAt), ...coverage(state, slug),
    };
  });
  const res = await askJson({
    kind: "plan", system: prompt("plan.md"), ctx: { candidates },
    user: JSON.stringify({ today, recent: recentTopics(state), last_report: guidance, candidates }),
    maxTokens: 1500,
  });
  const slug = candidates.some((c) => c.slug === res.slug) ? res.slug : candidates[0].slug;
  const p = state.pending[slug];
  const video = {
    id: `${week}-${slug}`, week, slug, mode: p.kind, status: "planned", createdAt: new Date().toISOString(), langs: {},
    plan: { ...res, slug },
    change: p.kind === "update" ? { summary: p.summary, numbersAdded: p.numbersAdded || [], numbersRemoved: p.numbersRemoved || [] } : null,
  };
  // ролик об обновлении — всегда объяснение «что изменилось»; особые форматы только для остальных выпусков
  Object.assign(video, p.kind === "update" ? { format: "explainer" } : pickFormat(state));
  delete state.pending[slug];
  state.videos.push(video);
  const left = Object.keys(state.pending).length;
  log(`1-й приоритет: ${p.kind === "new" ? "новая статья" : "обновление"} ${slug} — ${res.reason || ""}; формат: ${FORMATS[video.format].ru}; в очереди осталось: ${left}`);
  return video;
}

async function planGeneral(state, week, articles, today, guidance) {
  if (!articles.length) {
    await sendMessage("⚠️ На сайте не нашлось статей для видео. Проверьте ARTICLES_CSV_URL / SITE_URL.");
    return null;
  }
  const candidates = articles.map((a) => ({
    slug: a.slug, title: title(a), excerpt: a.langs.en?.excerpt || "", tags: a.tags, ...coverage(state, a.slug),
  }));
  const res = await askJson({
    kind: "plan_general", system: prompt("plan-general.md"), ctx: { candidates },
    user: JSON.stringify({ today, recent: recentTopics(state), last_report: guidance, candidates }),
    maxTokens: 1500,
  });
  const valid = (res.sources || []).filter((s) => candidates.some((c) => c.slug === s)).slice(0, 3);
  const sources = valid.length ? valid : [candidates.sort((a, b) => a.times_covered - b.times_covered)[0].slug];
  const slug = `general-${week}`;
  const video = {
    id: `${week}-${slug}`, week, slug, mode: "general", sources, status: "planned", createdAt: new Date().toISOString(), langs: {},
    plan: { ...res, sources },
  };
  Object.assign(video, pickFormat(state));
  state.videos.push(video);
  log(`2-й приоритет (новых и обновлённых статей нет): ролик на общую тему «${res.topic_title || sources[0]}», источники: ${sources.join(", ")}; формат: ${FORMATS[video.format].ru}`);
  return video;
}
