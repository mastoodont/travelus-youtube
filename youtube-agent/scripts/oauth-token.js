#!/usr/bin/env node
/**
 * Получение refresh-токена для канала (один раз на канал):
 *   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… node scripts/oauth-token.js en
 * Откроется ссылка → войдите в аккаунт, которому принадлежит канал, и ВЫБЕРИТЕ нужный канал.
 * Токен напечатается в консоли — сохраните его в секрет YT_REFRESH_TOKEN_EN (или _ES).
 */
import http from "node:http";
import { google } from "googleapis";

const lang = (process.argv[2] || "").toLowerCase();
if (!["en", "es"].includes(lang)) { console.error("укажите язык канала: en или es"); process.exit(2); }
const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret } = process.env;
if (!id || !secret) { console.error("задайте GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET"); process.exit(2); }

const PORT = 53682, redirect = `http://localhost:${PORT}`;
const client = new google.auth.OAuth2(id, secret, redirect);
const url = client.generateAuthUrl({
  access_type: "offline", prompt: "consent",
  scope: ["https://www.googleapis.com/auth/youtube", "https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/yt-analytics.readonly"],
});
console.log(`\nОткройте в браузере и разрешите доступ (канал: ${lang === "en" ? "@roamfact_en" : "@roamfact_es"}):\n\n${url}\n`);

http.createServer(async (req, res) => {
  const code = new URL(req.url, redirect).searchParams.get("code");
  if (!code) { res.end("нет кода"); return; }
  try {
    const { tokens } = await client.getToken(code);
    res.end("Готово, можно закрыть вкладку и вернуться в консоль.");
    console.log(tokens.refresh_token
      ? `\nYT_REFRESH_TOKEN_${lang.toUpperCase()}=${tokens.refresh_token}\n`
      : "\nGoogle не вернул refresh_token. Отзовите доступ на myaccount.google.com/permissions и повторите.\n");
  } catch (e) { res.end("ошибка"); console.error(e.message); }
  process.exit(0);
}).listen(PORT);
