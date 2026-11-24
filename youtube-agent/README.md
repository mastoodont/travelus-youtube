# YouTube-агент RoamFact

Раз в неделю делает выпуск для двух каналов — **@roamfact_en** и **@roamfact_es**: видео 16:9 (около 1,5 минуты, 200–290 слов) и один Short 9:16 по статье с roamfact.com. Работает на GitHub Actions, отдельный сервер не нужен. Вы участвуете дважды в неделю: утверждаете сценарии и смотрите готовые видео (кнопками в Telegram).

```
Пн  Аналитика → тема недели → сценарии EN+ES → факт-чек → Telegram
Вт  Вы: «✅ Утвердить» или «✏️ Правка» (текстом) → озвучка → сборка видео → Telegram
Чт  Вы: смотрите видео, «✅ Публиковать» → загрузка на YouTube по расписанию (видео пт 11:00 ET, Short вс)
```

Состояние хранится в `youtube-agent/data/state.json` (коммитится само), файлы видео — во временных GitHub Releases (удаляются после публикации).

## Быстрая проверка без ключей

```bash
cd youtube-agent
npm install
npm test        # проверки логики и Telegram-кнопок
npm run demo    # весь конвейер на тестовых данных → data/out/<выпуск>/ (нужен ffmpeg)
```

## Подключение (один раз, ~40 минут)

Скопируйте в корень репозитория папки `youtube-agent/` и `.github/`.

### 1. Telegram-бот
1. В Telegram откройте **@BotFather** → `/newbot` → получите токен → секрет `TELEGRAM_BOT_TOKEN`.
2. Напишите своему боту любое сообщение и откройте `https://api.telegram.org/bot<ТОКЕН>/getUpdates` — найдите `"chat":{"id":…}` → секрет `TELEGRAM_CHAT_ID`. Бот отвечает только на этот чат.

### 2. Claude
Ключ с console.anthropic.com → секрет `ANTHROPIC_API_KEY`. Модель по умолчанию `claude-sonnet-5-5`, меняется переменной `CLAUDE_MODEL`.

### 3. Голос
- **ElevenLabs:** ключ → `ELEVENLABS_API_KEY`; ID двух голосов (английский и испанский, по одному на канал) → `ELEVEN_VOICE_EN`, `ELEVEN_VOICE_ES`. Один и тот же голос на канале держите всегда.
- **Google Cloud TTS (бесплатный лимит, около 1 млн символов в месяц для голосов Neural2; нужен включённый биллинг):** в проекте Google Cloud включите **Cloud Text-to-Speech API**, создайте ключ (Credentials → Create credentials → API key) → секрет `GOOGLE_TTS_API_KEY`; переменная `VOICE_PROVIDER=google`. Голоса по умолчанию: `en-US-Neural2-J` и `es-US-Neural2-B`; сменить можно переменными `GOOGLE_VOICE_EN` / `GOOGLE_VOICE_ES` (список: https://cloud.google.com/text-to-speech/docs/voices), скорость речи — `GOOGLE_SPEAKING_RATE` (по умолчанию 1).
- **Свой голос (надёжнее для монетизации):** переменная `VOICE_PROVIDER=manual`. Агент пришлёт сценарий, вы записываете его и кладёте файл `youtube-agent/data/manual/<id выпуска>_<en|es>.mp3` в репозиторий (id и путь агент напишет в Telegram). Длительности сцен распределяются по числу слов.

### 4. YouTube (самый длинный шаг)
1. console.cloud.google.com → новый проект → включить **YouTube Data API v3** и **YouTube Analytics API**.
2. «Экран согласия OAuth»: тип *External*, добавьте себя в тестовые пользователи, затем **обязательно нажмите «Опубликовать приложение» (In production)**. В режиме Testing токены умирают через 7 дней, и агент перестанет работать.
3. «Учётные данные» → *OAuth client ID* → тип *Desktop app* → секреты `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
4. Для каждого канала выполните локально:
   ```bash
   cd youtube-agent && npm install
   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… node scripts/oauth-token.js en
   ```
   Откройте ссылку, войдите в аккаунт канала и **выберите канал @roamfact_en**. Токен из консоли → секрет `YT_REFRESH_TOKEN_EN`. Так же для `es` → `YT_REFRESH_TOKEN_ES` (канал @roamfact_es). Google покажет предупреждение «приложение не проверено» — для своих каналов это нормально («Дополнительно» → «Перейти»).
5. Для своих превью каналы должны быть подтверждены по телефону (youtube.com/verify).
6. Необязательно: плейлисты серий → переменные `YT_PLAYLIST_EN`, `YT_PLAYLIST_ES` (ID плейлиста).

### 5. Статьи сайта
Агент читает статьи в таком порядке: `ARTICLES_CSV_URL` (опубликованный CSV листа `articles` — тот же, что у сайта; колонки `slug, lang, title, excerpt, body, tags, status`) → `ARTICLES_CSV_PATH` → `llms.txt` опубликованного сайта (`SITE_URL`, по умолчанию https://www.roamfact.com). Нужны версии статьи на обоих языках (`en` и `es`).

### 6. Секреты и переменные репозитория
GitHub → Settings → Secrets and variables → Actions.

| Секреты | Переменные (Variables) |
|---|---|
| `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | `ARTICLES_CSV_URL` (если есть) |
| `GOOGLE_TTS_API_KEY` (если google), `ELEVENLABS_API_KEY`, `ELEVEN_VOICE_EN`, `ELEVEN_VOICE_ES` | `VOICE_PROVIDER` (`google`, `elevenlabs`, `manual` или `silent`), `GOOGLE_VOICE_EN/ES` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `YT_API_VERIFIED` (`1` после аудита, см. ниже) |
| `YT_REFRESH_TOKEN_EN`, `YT_REFRESH_TOKEN_ES` | `YT_PLAYLIST_EN`, `YT_PLAYLIST_ES`, `SITE_URL`, `CLAUDE_MODEL`, `DISCLOSE_SYNTHETIC` |

Также Settings → Actions → General → Workflow permissions → **Read and write permissions** (нужно, чтобы агент сохранял состояние и создавал релизы).

### 7. Первый запуск
Actions → «YouTube-агент — неделя» → *Run workflow*. Через несколько минут в Telegram придут сценарии. Дальше всё идёт само: каждый час запускается «YouTube-агент — каждый час» и читает ваши ответы. Команда `/status` в боте показывает, на каком шаге выпуски.

## Важно знать

**Загрузка через API и аудит.** Видео, загруженные через API из непроверенного проекта, YouTube блокирует как приватные, пока проект не пройдёт аудит. Поэтому по умолчанию агент **присылает готовый пакет** в Telegram: видео, Shorts, превью, субтитры (SRT), название, описание с главами, теги и время публикации — загрузка в YouTube Studio занимает 2 минуты. Подайте заявку на аудит: [форма](https://support.google.com/youtube/contact/yt_api_form). Когда одобрят — поставьте `YT_API_VERIFIED=1`, и агент начнёт загружать и планировать публикации сам. Лимит API — 10 000 единиц в сутки на проект, а загрузка видео стоит около 1 600–2 100, агент считает квоту сам и при нехватке догружает на следующие сутки.

**Монетизация.** Реклама YouTube для новых каналов с 1 февраля 2027 требует 1000 подписчиков и 8000 часов просмотра длинных видео за 365 дней (или 20 млн просмотров Shorts за 90 дней). Часы Shorts в порог по часам не идут. Прогресс к порогу агент присылает в понедельничном отчёте. Правила канала: без AI-ведущих, у каждого выпуска своя конкретика и свой расчёт; факт-чек не пропускает цифры, которых нет в статье.

**Синтетический голос.** При синтетическом голосе (`google`, `elevenlabs`) агент ставит у видео флажок «изменённый или синтетический контент» (`DISCLOSE_SYNTHETIC=0` отключает; решение остаётся за вами и правилами YouTube).

**Минуты GitHub Actions.** Почасовой запуск тратит около 700 минут в месяц плюс сборка видео. У приватных репозиториев бесплатный лимит 2000 минут, у публичных минуты бесплатны. Нужно реже — поменяйте cron в `agent-tick.yml`.

## Структура

```
youtube-agent/
├── run.js                  weekly | tick | status | demo
├── channels.json           настройки каналов, расписание, ссылки, раскрытие партнёрских ссылок
├── prompts/                инструкции для Claude: plan, script, factcheck, report
├── steps/                  analyze → plan → script → approval → produce → publish
├── lib/                    llm, telegram, tts (озвучка), render (видео), youtube, storage, articles
├── assets/fonts/           шрифты (Lora, Poppins, DejaVu Sans; свободные лицензии)
├── scripts/oauth-token.js  получение токена канала
├── fixtures/, tests/       тестовые данные и проверки
└── data/state.json         состояние (создаётся само)
.github/workflows/          agent-weekly.yml, agent-tick.yml
```

Свой стиль видео меняется в `lib/render.js` (цвета в `C`, фон в `background()`), тексты и тон — в `prompts/script.md`.


**Объём выпуска.** Задаётся в `channels.json` → `limits`: `longMinWords`/`longMaxWords` (слов в озвучке; 2,5 слова ≈ 1 секунда) и `shortsPerWeek` (1 или 2). Сейчас 200–290 слов и один Short. Озвучка двух каналов — около 20 000 символов в месяц, хватает тарифа ElevenLabs Starter.
