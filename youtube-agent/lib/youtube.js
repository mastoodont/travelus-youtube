import fs from "node:fs";
import { google } from "googleapis";
import { CHANNELS, env, log } from "./util.js";

function auth(lang) {
  const o = new google.auth.OAuth2(env("GOOGLE_CLIENT_ID"), env("GOOGLE_CLIENT_SECRET"));
  const token = env(CHANNELS.channels[lang].refreshTokenEnv);
  if (!token) throw new Error(`нет ${CHANNELS.channels[lang].refreshTokenEnv} (токен канала ${CHANNELS.channels[lang].handle})`);
  o.setCredentials({ refresh_token: token });
  return o;
}
export const yt = (lang) => google.youtube({ version: "v3", auth: auth(lang) });
const ya = (lang) => google.youtubeAnalytics({ version: "v2", auth: auth(lang) });
export const hasCreds = (lang) => !!(env("GOOGLE_CLIENT_ID") && env("GOOGLE_CLIENT_SECRET") && env(CHANNELS.channels[lang].refreshTokenEnv));

/** Загрузка с отложенной публикацией (publishAt). Возвращает id видео. */
export async function upload({ lang, file, title, description, tags, publishAt, thumb, srt, synthetic }) {
  if (env("YT_FAKE") === "1") { log(`  [yt:fake] ${CHANNELS.channels[lang].handle}: ${title} → ${publishAt}`); return `fake_${lang}_${Math.random().toString(36).slice(2, 8)}`; }
  const ch = CHANNELS.channels[lang], y = yt(lang);
  const res = await y.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: { title, description, tags, categoryId: ch.categoryId, defaultLanguage: ch.languageCode, defaultAudioLanguage: ch.languageCode },
      status: { privacyStatus: "private", publishAt, selfDeclaredMadeForKids: false, containsSyntheticMedia: !!synthetic },
    },
    media: { body: fs.createReadStream(file) },
  });
  const id = res.data.id;
  log(`  загружено ${ch.handle}: ${id} (публикация ${publishAt})`);
  if (thumb) { try { await y.thumbnails.set({ videoId: id, media: { body: fs.createReadStream(thumb) } }); } catch (e) { log(`  превью не поставлено: ${e.message}`); } }
  if (srt) { try { await y.captions.insert({ part: ["snippet"], requestBody: { snippet: { videoId: id, language: ch.languageCode, name: "", isDraft: false } }, media: { body: fs.createReadStream(srt) } }); } catch (e) { log(`  субтитры не загружены: ${e.message}`); } }
  return id;
}

export async function addToPlaylist(lang, videoId) {
  const playlistId = env(CHANNELS.channels[lang].playlistEnv);
  if (!playlistId) return;
  try {
    await yt(lang).playlistItems.insert({ part: ["snippet"], requestBody: { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } } });
  } catch (e) { log(`  плейлист: ${e.message}`); }
}

const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5);

/** Цифры канала: прогресс к порогам монетизации + неделя по видео + свежие комментарии */
export async function channelStats(lang) {
  const y = yt(lang), a = ya(lang);
  const chn = (await y.channels.list({ part: ["statistics", "snippet"], mine: true })).data.items?.[0];
  if (!chn) throw new Error("канал не найден");
  const byType = async (days) => {
    const r = await a.reports.query({ ids: "channel==MINE", startDate: iso(daysAgo(days)), endDate: iso(new Date()), metrics: "views,estimatedMinutesWatched", dimensions: "creatorContentType" });
    return Object.fromEntries((r.data.rows || []).map((x) => [x[0], { views: x[1], minutes: x[2] }]));
  };
  const y365 = await byType(365), y90 = await byType(90);
  const week = await a.reports.query({
    ids: "channel==MINE", startDate: iso(daysAgo(7)), endDate: iso(new Date()), dimensions: "video", sort: "-views", maxResults: 10,
    metrics: "views,estimatedMinutesWatched,averageViewPercentage,subscribersGained",
  });
  const rows = week.data.rows || [];
  let titles = {};
  if (rows.length) {
    const v = await y.videos.list({ part: ["snippet"], id: rows.map((r) => r[0]) });
    titles = Object.fromEntries((v.data.items || []).map((i) => [i.id, i.snippet.title]));
  }
  let comments = [];
  try {
    const c = await y.commentThreads.list({ part: ["snippet"], allThreadsRelatedToChannelId: chn.id, maxResults: 30, order: "time" });
    comments = (c.data.items || []).map((i) => i.snippet.topLevelComment.snippet.textDisplay.slice(0, 200));
  } catch { /* комментарии выключены */ }
  return {
    lang, handle: CHANNELS.channels[lang].handle,
    subscribers: +chn.statistics.subscriberCount,
    longWatchHours365: Math.round(((y365.VIDEO_ON_DEMAND?.minutes || 0) / 60) * 10) / 10,
    shortsViews90: y90.SHORTS?.views || 0,
    week: rows.map((r) => ({ title: titles[r[0]] || r[0], views: r[1], minutes: r[2], avgViewPct: Math.round(r[3]), subsGained: r[4] })),
    comments,
  };
}
