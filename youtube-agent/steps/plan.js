import { LANGS, log, mondayOf } from "../lib/util.js";
import { loadArticles } from "../lib/articles.js";
import { askJson, prompt } from "../lib/llm.js";
import { pickFormat, FORMATS } from "../lib/formats.js";
import { sendMessage } from "../lib/telegram.js";

export async function plan(state) {
  const week = mondayOf();
  if (state.videos.some((v) => v.week === week)) { log(`на неделю ${week} выпуск уже запланирован`); return null; }
  const articles = await loadArticles();
  const used = new Set(state.videos.map((v) => v.slug));
  const strict = articles.filter((a) => !used.has(a.slug) && LANGS.every((l) => a.langs[l]?.body));
  const cand = strict.length ? strict : articles.filter((a) => !used.has(a.slug) && Object.keys(a.langs).length);
  if (!cand.length) {
    await sendMessage("⚠️ Новых статей для видео не осталось. Добавьте статьи на сайт — агент возьмёт следующую.");
    return null;
  }
  const res = await askJson({
    kind: "plan", system: prompt("plan.md"), ctx: { candidates: cand },
    user: JSON.stringify({
      today: new Date().toISOString().slice(0, 10), used: [...used], last_report: state.reports.at(-1)?.guidance || "",
      candidates: cand.map((a) => ({ slug: a.slug, title: a.langs.en?.title || Object.values(a.langs)[0]?.title, excerpt: a.langs.en?.excerpt || "", tags: a.tags })),
    }),
    maxTokens: 1500,
  });
  const slug = cand.some((a) => a.slug === res.slug) ? res.slug : cand[0].slug;
  const video = { id: `${week}-${slug}`, week, slug, status: "planned", plan: { ...res, slug }, createdAt: new Date().toISOString(), langs: {} };
  Object.assign(video, pickFormat(state));
  state.videos.push(video);
  log(`выбрана тема недели: ${slug} — ${res.reason || ""}; формат: ${FORMATS[video.format].ru}`);
  return video;
}
