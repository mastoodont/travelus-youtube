import { CHANNELS, MOCK, articleUrl, words } from "./util.js";

const TYPES = ["title", "cards", "bignumber", "compare", "steps", "outro"];

export function fill(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ""));
}

/** Проверка структуры сценария. Возвращает список проблем (пусто = всё хорошо). */
export function validateScript(sc) {
  const L = CHANNELS.limits, errs = [];
  const minW = MOCK() ? 100 : L.longMinWords;
  if (!sc || typeof sc !== "object") return ["ответ не объект"];
  if (!sc.title || sc.title.length > 70) errs.push("title обязателен и не длиннее 70 символов");
  if (!sc.description) errs.push("нет description");
  if (!Array.isArray(sc.tags) || sc.tags.length < 5) errs.push("нужно не меньше 5 tags");
  if (!Array.isArray(sc.scenes) || sc.scenes.length < 6) return [...errs, "нужно минимум 6 сцен"];
  const ids = new Set();
  sc.scenes.forEach((s, i) => {
    if (!TYPES.includes(s.type)) errs.push(`сцена ${s.id}: неизвестный type ${s.type}`);
    if (!s.id || ids.has(s.id)) errs.push(`сцена №${i + 1}: id пустой или повторяется`);
    ids.add(s.id);
    if (!s.narration || !s.narration.trim()) errs.push(`сцена ${s.id}: нет narration`);
    if (s.type === "cards" && !(s.cards?.length >= 2 && s.cards.length <= 3)) errs.push(`сцена ${s.id}: cards должно быть 2–3`);
    if (s.type === "steps" && !(s.steps?.length >= 3 && s.steps.length <= 4)) errs.push(`сцена ${s.id}: steps должно быть 3–4`);
    if (s.type === "bignumber" && !s.number) errs.push(`сцена ${s.id}: нет number`);
    if (s.type === "compare" && !(s.left?.value && s.right?.value)) errs.push(`сцена ${s.id}: нет left/right`);
  });
  if (sc.scenes[0]?.type !== "title") errs.push("первая сцена должна быть title");
  if (sc.scenes.at(-1)?.type !== "outro") errs.push("последняя сцена должна быть outro");
  const total = sc.scenes.reduce((n, s) => n + words(s.narration), 0);
  if (total < minW) errs.push(`озвучка слишком короткая: ${total} слов, нужно ${minW}–${L.longMaxWords}`);
  if (total > L.longMaxWords) errs.push(`озвучка слишком длинная: ${total} слов, нужно ${minW}–${L.longMaxWords}`);
  const shortWords = Math.floor(L.shortMaxSeconds * L.wordsPerSecond * 0.9);
  if (!Array.isArray(sc.shorts) || !sc.shorts.length || sc.shorts.length > (L.shortsPerWeek || 2)) errs.push(`нужно Shorts: от 1 до ${L.shortsPerWeek || 2}`);
  for (const sh of sc.shorts || []) {
    const sel = (sh.scene_ids || []).map((id) => sc.scenes.find((s) => s.id === id));
    if (!sel.length || sel.some((s) => !s)) errs.push(`Short «${sh.title}»: неверные scene_ids`);
    else if (sel.reduce((n, s) => n + words(s.narration), 0) > shortWords) errs.push(`Short «${sh.title}»: больше ${shortWords} слов`);
  }
  return errs;
}

export function totalWords(sc) {
  return sc.scenes.reduce((n, s) => n + words(s.narration), 0);
}

const hashtags = (tags) => tags.slice(0, 3).map((t) => "#" + t.replace(/[^\p{L}\p{N}]+/gu, "")).filter((t) => t.length > 1).join(" ");

export function longDescription({ script, lang, slug, week, chapterLines }) {
  const ch = CHANNELS.channels[lang];
  return [
    script.description.trim(),
    `${ch.fullGuide}: ${articleUrl(lang, slug, `${week}-${slug}`, "video")}`,
    chapterLines.length ? chapterLines.join("\n") : "",
    CHANNELS.disclosure[lang],
    hashtags(script.tags),
  ].filter(Boolean).join("\n\n");
}

export function shortDescription({ script, short, lang, slug, week, longId }) {
  const ch = CHANNELS.channels[lang];
  return [
    short.hook ? `${short.hook}` : script.description.split(/(?<=[.!?])\s/)[0],
    longId ? `${ch.fullVideo}: https://youtu.be/${longId}` : "",
    `${ch.fullGuide}: ${articleUrl(lang, slug, `${week}-${slug}-short`, "short")}`,
    CHANNELS.disclosure[lang],
    `${hashtags(script.tags)} #Shorts`.trim(),
  ].filter(Boolean).join("\n\n");
}
