/**
 * Сборка видео в фирменном стиле RoamFact: закатный фон, карточки, крупные субтитры.
 * Кадры рисуются на canvas (@napi-rs/canvas), склейка и звук — ffmpeg.
 * Один сценарий → длинное видео 16:9 (1920×1080) и Shorts 9:16 (1080×1920) + превью 1280×720 + SRT.
 */
import fs from "node:fs";
import path from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { CHANNELS, ROOT, fmtTime, log, sentences, sh } from "./util.js";

// ---------- шрифты ----------
const FD = path.join(ROOT, "assets", "fonts");
for (const [file, name] of [["Lora-Variable.ttf", "Lora"], ["Poppins-Regular.ttf", "Poppins"], ["Poppins-Medium.ttf", "Poppins"], ["Poppins-Bold.ttf", "Poppins"], ["DejaVuSans.ttf", "DejaVu Sans"]]) {
  const p = path.join(FD, file);
  if (fs.existsSync(p)) GlobalFonts.registerFromPath(p, name);
}
const SERIF = 'Lora, "DejaVu Serif", serif';
const SANS = 'Poppins, "DejaVu Sans", sans-serif';
const font = (weight, px, fam = SANS) => `${weight} ${Math.round(px)}px ${fam}`;

const C = {
  cream: "#f7f0e3", ink: "#1d2433", muted: "#6b7385", teal: "#1f8a70", coral: "#e2674a", blue: "#3b5fa8",
  gold: "#f2b45f", white: "#ffffff", red: "#e53935", green: "#2e9e6b",
};
const ACCENTS = [C.teal, C.blue, C.coral];
const GLYPH = { dollar: "$", swap: "⇄", home: "⌂", card: "▭", wifi: "◉", umbrella: "☂", percent: "%", plane: "✈", check: "✓" };

// ---------- фон ----------
const bgCache = new Map();
function background(W, H) {
  const key = `${W}x${H}`;
  if (bgCache.has(key)) return bgCache.get(key);
  const cv = createCanvas(W, H), g = cv.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#0f1a3a"); grad.addColorStop(0.45, "#2b2b5c"); grad.addColorStop(0.7, "#80507a");
  grad.addColorStop(0.86, "#e68c5c"); grad.addColorStop(1, "#f3b56c");
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 90; i++) {
    g.fillStyle = `rgba(255,255,255,${0.25 + rnd() * 0.5})`;
    g.beginPath(); g.arc(rnd() * W, rnd() * H * 0.55, 0.8 + rnd() * 2, 0, 7); g.fill();
  }
  const unit = Math.min(W, H);
  g.fillStyle = "rgba(255,226,180,0.92)"; g.beginPath(); g.arc(W * 0.82, H * 0.8, unit * 0.045, 0, 7); g.fill();
  const layers = [[0.86, "rgba(96,78,128,0.95)", 0.05, 3], [0.91, "rgba(70,60,112,0.97)", 0.045, 5], [0.96, "rgba(44,42,88,1)", 0.04, 7]];
  for (const [base, color, amp, f] of layers) {
    g.fillStyle = color; g.beginPath(); g.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) {
      const t = x / W;
      g.lineTo(x, H * base - H * amp * (0.55 * Math.sin(t * f * 3 + f) + 0.3 * Math.sin(t * f * 7.3 + 2 * f) + 0.15 * Math.sin(t * 19 + f)));
    }
    g.lineTo(W, H); g.closePath(); g.fill();
  }
  bgCache.set(key, cv);
  return cv;
}

// ---------- текст ----------
function wrap(ctx, text, maxW) {
  const out = []; let line = "";
  for (const w of String(text).split(/\s+/)) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t;
  }
  if (line) out.push(line);
  return out;
}
function fitFont(ctx, text, weight, px, fam, maxW, minPx) {
  let s = px;
  do { ctx.font = font(weight, s, fam); if (ctx.measureText(text).width <= maxW) break; s -= 2; } while (s > minPx);
  return s;
}
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }

function centerText(ctx, text, cx, y, weight, px, fam, color, maxW) {
  ctx.font = font(weight, px, fam); ctx.fillStyle = color; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  const lines = maxW ? wrap(ctx, text, maxW) : [text];
  lines.forEach((l, i) => ctx.fillText(l, cx, y + i * px * 1.18));
  return lines.length;
}

// ---------- элементы ----------
function logo(ctx, L) {
  ctx.textAlign = "left"; ctx.fillStyle = "rgba(255,255,255,0.92)"; ctx.font = font(500, 28 * L.u);
  ctx.fillText("◍ roamfact.com", 40 * L.u, 56 * L.u);
}

function heading(ctx, L, text) {
  const px = L.vertical ? 80 : 68;
  ctx.font = font(700, px, SERIF);
  const lines = wrap(ctx, text, L.col.w);
  ctx.fillStyle = C.white; ctx.textAlign = "center";
  lines.forEach((l, i) => { ctx.shadowColor = "rgba(0,0,0,.35)"; ctx.shadowBlur = 12; ctx.fillText(l, L.cx, L.headY + i * px * 1.15); });
  ctx.shadowBlur = 0;
  return L.headY + (lines.length - 1) * px * 1.15;
}

function card(ctx, L, x, y, w, h, o) {
  ctx.shadowColor = "rgba(0,0,0,.30)"; ctx.shadowBlur = 26; ctx.shadowOffsetY = 8;
  ctx.fillStyle = C.cream; rr(ctx, x, y, w, h, 20); ctx.fill();
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  ctx.fillStyle = o.accent; rr(ctx, x, y, 12, h, [20, 0, 0, 20]); ctx.fill();
  const ir = L.vertical ? 42 : 38, ix = x + 34 + ir;
  ctx.fillStyle = o.accent; ctx.beginPath(); ctx.arc(ix, y + h / 2, ir, 0, 7); ctx.fill();
  ctx.fillStyle = C.white; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = font(700, ir * 1.0, '"DejaVu Sans", Poppins, sans-serif');
  ctx.fillText(o.num ? String(o.num) : (GLYPH[o.icon] || GLYPH.check), ix, y + h / 2 + 2);
  ctx.textBaseline = "alphabetic";
  const tx = ix + ir + 28, tw = w - (tx - x) - (o.done ? 120 : 40);
  const tpx = L.vertical ? 44 : 42, spx = L.vertical ? 30 : 28;
  ctx.font = font(700, tpx); const tl = wrap(ctx, o.title, tw).slice(0, 2);
  const block = tl.length * tpx * 1.15 + (o.sub ? spx * 1.4 : 0);
  let ty = y + (h - block) / 2 + tpx * 0.95;
  ctx.textAlign = "left"; ctx.fillStyle = C.ink; ctx.font = font(700, tpx);
  tl.forEach((l, i) => ctx.fillText(l, tx, ty + i * tpx * 1.15));
  if (o.sub) { ctx.fillStyle = C.muted; ctx.font = font(400, spx); ctx.fillText(wrap(ctx, o.sub, tw)[0], tx, ty + tl.length * tpx * 1.15 + spx * 0.2); }
  if (o.done) {
    ctx.fillStyle = C.green; ctx.beginPath(); ctx.arc(x + w - 64, y + h / 2, 30, 0, 7); ctx.fill();
    ctx.fillStyle = C.white; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = font(700, 34, '"DejaVu Sans", sans-serif');
    ctx.fillText("✓", x + w - 64, y + h / 2 + 2); ctx.textBaseline = "alphabetic";
  }
}

function captionBox(ctx, L, text) {
  if (!text) return;
  const px = L.vertical ? 46 : 38;
  ctx.font = font(500, px);
  const lines = wrap(ctx, text, L.capW).slice(0, 4);
  const lh = px * 1.3, padX = 30, padY = 20;
  const w = Math.min(L.capW, Math.max(...lines.map((l) => ctx.measureText(l).width))) + padX * 2;
  const h = lines.length * lh + padY * 2 - 8;
  const x = L.cx - w / 2, y = L.capY - h;
  ctx.fillStyle = "rgba(10,14,28,0.82)"; rr(ctx, x, y, w, h, 16); ctx.fill();
  ctx.fillStyle = C.white; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  lines.forEach((l, i) => ctx.fillText(l, L.cx, y + padY + px * 0.9 + i * lh - 4));
}

function dots(ctx, L, idx, total) {
  if (L.vertical || total < 2) return;
  const gap = 26, x0 = L.cx - ((total - 1) * gap) / 2, y = L.capY + 36;
  for (let i = 0; i < total; i++) {
    ctx.fillStyle = i === idx ? C.gold : "rgba(255,255,255,0.35)";
    ctx.beginPath(); ctx.arc(x0 + i * gap, y, i === idx ? 8 : 6, 0, 7); ctx.fill();
  }
}

// ---------- сцены ----------
function drawScene(ctx, L, scene, st) {
  const { shown, ch } = st;
  if (!["title", "outro", "cta"].includes(scene.type) && scene.heading) heading(ctx, L, scene.heading);

  if (scene.type === "title") {
    const w = L.col.w, h = L.vertical ? 760 : 520, x = L.cx - w / 2, y = L.vertical ? 420 : 250;
    ctx.shadowColor = "rgba(0,0,0,.35)"; ctx.shadowBlur = 36; ctx.shadowOffsetY = 12;
    ctx.fillStyle = C.cream; rr(ctx, x, y, w, h, 26); ctx.fill(); ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.fillStyle = C.teal; rr(ctx, x, y, w, 84, [26, 26, 0, 0]); ctx.fill();
    ctx.fillStyle = C.white; ctx.textAlign = "left"; ctx.font = font(700, 32); ctx.fillText(String(scene.badge || "").toUpperCase(), x + 40, y + 54);
    ctx.textAlign = "right"; ctx.fillText("roamfact.com", x + w - 40, y + 54);
    const px = L.vertical ? 96 : 92; ctx.font = font(700, px, SERIF);
    const lines = wrap(ctx, scene.heading || "", w - 100);
    ctx.fillStyle = C.ink; ctx.textAlign = "left";
    lines.forEach((l, i) => ctx.fillText(l, x + 50, y + 200 + i * px * 1.1));
    ctx.fillStyle = C.muted; ctx.font = font(500, 32);
    ctx.fillText(CHANNELS.channels[st.lang].tagline, x + 50, y + h - 50);
  } else if (scene.type === "cards" || scene.type === "steps") {
    const items = scene.type === "cards" ? scene.cards : scene.steps;
    const n = Math.min(shown, items.length);
    const gap = 24, y0 = L.listY, baseH = L.vertical ? 190 : 140;
    const h = Math.min(baseH, Math.floor((L.capY - 150 - y0 - (items.length - 1) * gap) / items.length));
    for (let i = 0; i < n; i++) {
      const y = y0 + i * (h + gap), done = i < n - 1 || n === items.length && st.last;
      if (scene.type === "cards") card(ctx, L, L.cx - L.col.w / 2, y, L.col.w, h, { ...items[i], accent: ACCENTS[i % 3], done });
      else card(ctx, L, L.cx - L.col.w / 2, y, L.col.w, h, { title: items[i], sub: "", icon: null, accent: ACCENTS[i % 3], done, num: i + 1 });
    }
  } else if (scene.type === "bignumber") {
    const big = String(scene.number || "");
    let px = L.vertical ? 260 : 230; ctx.font = font(700, px, SERIF);
    while (ctx.measureText(big).width > L.col.w && px > 80) { px -= 8; ctx.font = font(700, px, SERIF); }
    const y = L.vertical ? 860 : 560;
    ctx.fillStyle = C.gold; ctx.textAlign = "center"; ctx.shadowColor = "rgba(0,0,0,.4)"; ctx.shadowBlur = 20;
    ctx.fillText(big, L.cx, y); ctx.shadowBlur = 0;
    centerText(ctx, scene.caption || "", L.cx, y + 90, 500, L.vertical ? 52 : 46, SANS, C.white, L.col.w);
  } else if (scene.type === "compare") {
    const sides = [scene.left, scene.right], gap = 40;
    const w = L.vertical ? L.col.w : (L.col.w - gap) / 2, h = L.vertical ? 300 : 340;
    sides.forEach((s, i) => {
      const x = L.vertical ? L.cx - w / 2 : L.cx - L.col.w / 2 + i * (w + gap);
      const y = L.vertical ? L.listY + i * (h + gap) : L.listY;
      ctx.shadowColor = "rgba(0,0,0,.30)"; ctx.shadowBlur = 26; ctx.shadowOffsetY = 8;
      ctx.fillStyle = C.cream; rr(ctx, x, y, w, h, 22); ctx.fill(); ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      ctx.fillStyle = i ? C.coral : C.teal; rr(ctx, x, y, w, 14, [22, 22, 0, 0]); ctx.fill();
      centerText(ctx, s.label, x + w / 2, y + 90, 500, 34, SANS, C.muted, w - 60);
      const vpx = fitFont(ctx, s.value, 700, L.vertical ? 62 : 56, SERIF, w - 60, 30);
      centerText(ctx, s.value, x + w / 2, y + h / 2 + 50, 700, vpx, SERIF, C.ink, w - 60);
    });
  } else if (scene.type === "outro") {
    const y = L.vertical ? 760 : 380;
    ctx.font = font(700, L.vertical ? 110 : 118, SERIF); ctx.fillStyle = C.white; ctx.textAlign = "center";
    ctx.shadowColor = "rgba(0,0,0,.4)"; ctx.shadowBlur = 16; ctx.fillText("roamfact.com", L.cx, y); ctx.shadowBlur = 0;
    centerText(ctx, CHANNELS.channels[st.lang].tagline, L.cx, y + 80, 400, 40, SERIF, "rgba(255,255,255,.88)", L.col.w);
    if (scene.heading) centerText(ctx, scene.heading, L.cx, y + 170, 700, L.vertical ? 56 : 48, SANS, C.gold, L.col.w);
    const bw = 380, bh = 84, bx = L.cx - bw / 2, by = y + (scene.heading ? 270 : 190);
    ctx.fillStyle = C.red; rr(ctx, bx, by, bw, bh, 42); ctx.fill();
    ctx.fillStyle = C.white; ctx.textAlign = "center"; ctx.font = font(700, 34);
    ctx.fillText(`▶  ${ch.subscribe.toUpperCase()}`, bx + bw / 2, by + 54);
  } else if (scene.type === "cta") {
    ctx.font = font(700, 110, SERIF); ctx.fillStyle = C.white; ctx.textAlign = "center";
    ctx.fillText("roamfact.com", L.cx, 860);
    centerText(ctx, scene.heading, L.cx, 980, 700, 56, SANS, C.gold, L.col.w);
    const bw = 380, bh = 84, bx = L.cx - bw / 2, by = 1100;
    ctx.fillStyle = C.red; rr(ctx, bx, by, bw, bh, 42); ctx.fill();
    ctx.fillStyle = C.white; ctx.font = font(700, 34); ctx.fillText(`▶  ${ch.subscribe.toUpperCase()}`, L.cx, by + 54);
  }
}

function layout(W, H) {
  const vertical = H > W;
  return {
    W, H, vertical, u: vertical ? 1 : 1, cx: W / 2,
    col: vertical ? { w: 960 } : { w: 1160 },
    headY: vertical ? 330 : 190,
    listY: vertical ? 520 : 290,
    capY: vertical ? H - 300 : H - 110,
    capW: vertical ? 900 : 1500,
  };
}

function frameFor(L, scene, st) {
  const cv = createCanvas(L.W, L.H), ctx = cv.getContext("2d");
  ctx.drawImage(background(L.W, L.H), 0, 0);
  logo(ctx, L);
  drawScene(ctx, L, scene, st);
  if (st.dotsTotal) dots(ctx, L, st.dotsIdx, st.dotsTotal);
  captionBox(ctx, L, st.caption);
  return cv.toBuffer("image/png");
}

/** Кадры одной сцены: по одному на предложение озвучки (карточки раскрываются по ходу речи) */
function sceneFrames(L, scene, dur, st0) {
  const sents = sentences(scene.narration);
  const items = scene.type === "cards" ? scene.cards?.length : scene.type === "steps" ? scene.steps?.length : 0;
  const list = sents.length ? sents : [""];
  const total = list.reduce((n, s) => n + Math.max(8, s.length), 0);
  return list.map((s, i) => {
    const shown = items ? Math.max(1, Math.min(items, list.length === 1 ? items : Math.ceil((i * items) / (list.length - 1)))) : 0;
    return {
      caption: s, dur: (dur * Math.max(8, s.length)) / total,
      png: frameFor(L, scene, { ...st0, shown, caption: s, last: i === list.length - 1 }),
    };
  });
}

// ---------- ffmpeg ----------
function encode(frames, audio, out, tmp, totalDur) {
  fs.mkdirSync(tmp, { recursive: true });
  const lines = [];
  frames.forEach((f, i) => {
    const p = path.join(tmp, `f${String(i).padStart(4, "0")}.png`);
    fs.writeFileSync(p, f.png);
    lines.push(`file '${p}'`, `duration ${f.dur.toFixed(3)}`);
  });
  lines.push(`file '${path.join(tmp, `f${String(frames.length - 1).padStart(4, "0")}.png`)}'`);
  const list = path.join(tmp, "frames.txt");
  fs.writeFileSync(list, lines.join("\n"));
  sh("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-i", audio, "-vf", "fps=30,format=yuv420p",
    "-af", "apad", "-t", totalDur.toFixed(3), "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out]);
}

function cut(audio, from, len, out) {
  sh("ffmpeg", ["-v", "error", "-y", "-ss", from.toFixed(3), "-t", len.toFixed(3), "-i", audio, "-ar", "44100", "-ac", "1", out]);
}

const srtTime = (t) => {
  const ms = Math.round(t * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};

// ---------- публичный API ----------
export function timeline(scenes, durs) {
  const starts = {}; let t = 0;
  for (const s of scenes) { starts[s.id] = t; t += durs[s.id] || 0; }
  return { starts, total: t };
}

/** Главы для описания: «0:00 …», не короче 10 секунд, минимум три */
export function chapters(script, durs, lang) {
  const ui = CHANNELS.channels[lang].ui, { starts, total } = timeline(script.scenes, durs);
  const marks = [{ t: 0, name: ui.intro }];
  for (const s of script.scenes) {
    if (s.type === "title") continue;
    const name = s.type === "outro" ? ui.outro : s.heading;
    if (!name) continue;
    if (starts[s.id] - marks.at(-1).t < 10) { if (marks.length > 1) marks.at(-1).name = marks.at(-1).name; continue; }
    if (total - starts[s.id] < 10) continue;
    marks.push({ t: starts[s.id], name });
  }
  return marks.length >= 3 ? marks.map((m) => `${fmtTime(m.t)} ${m.name}`) : [];
}

export function renderLong({ script, lang, audio, durs, dir }) {
  const L = layout(1920, 1080), ch = CHANNELS.channels[lang];
  const mid = script.scenes.filter((s) => s.type !== "title" && s.type !== "outro");
  const frames = [], srt = []; let t = 0, n = 1;
  for (const scene of script.scenes) {
    const dur = durs[scene.id] || 0;
    if (!dur) continue;
    const idx = mid.indexOf(scene);
    const fr = sceneFrames(L, scene, dur, { lang, ch, dotsTotal: idx >= 0 ? mid.length : 0, dotsIdx: idx });
    for (const f of fr) {
      frames.push(f);
      if (f.caption) srt.push(`${n++}\n${srtTime(t)} --> ${srtTime(t + f.dur - 0.05)}\n${f.caption}\n`);
      t += f.dur;
    }
  }
  const file = path.join(dir, `long_${lang}.mp4`);
  encode(frames, audio, file, path.join(dir, `tmp_long_${lang}`), t);
  const srtFile = path.join(dir, `subs_${lang}.srt`);
  fs.writeFileSync(srtFile, srt.join("\n"));
  fs.rmSync(path.join(dir, `tmp_long_${lang}`), { recursive: true, force: true });
  return { file, srtFile, duration: t };
}

export function renderShort({ script, short, idx, lang, audio, durs, dir }) {
  const L = layout(1080, 1920), ch = CHANNELS.channels[lang], max = CHANNELS.limits.shortMaxSeconds - 2.5;
  const { starts } = timeline(script.scenes, durs);
  const frames = [], parts = []; let t = 0;
  const tmp = path.join(dir, `tmp_short${idx}_${lang}`); fs.mkdirSync(tmp, { recursive: true });
  for (const id of short.scene_ids) {
    const scene = script.scenes.find((s) => s.id === id), dur = durs[id] || 0;
    if (!scene || !dur) continue;
    if (t + dur > max && parts.length) { log(`  Short ${idx}: сцена ${id} не влезает в ${CHANNELS.limits.shortMaxSeconds} с, пропущена`); break; }
    const part = path.join(tmp, `a_${id}.wav`); cut(audio, starts[id], dur, part); parts.push(part);
    frames.push(...sceneFrames(L, scene, dur, { lang, ch }));
    t += dur;
  }
  // финальная карточка: ссылка на полное видео
  const tail = 2.5;
  frames.push({ caption: "", dur: tail, png: frameFor(L, { type: "cta", heading: ch.fullVideo }, { lang, ch, caption: "" }) });
  const list = path.join(tmp, "a.txt"); fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n"));
  const audioFile = path.join(tmp, "short.wav");
  sh("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", audioFile]);
  const file = path.join(dir, `short${idx}_${lang}.mp4`);
  encode(frames, audioFile, file, path.join(tmp, "v"), t + tail);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { file, duration: t + tail };
}

export function renderThumb({ script, lang, file }) {
  const W = 1280, H = 720, cv = createCanvas(W, H), ctx = cv.getContext("2d");
  ctx.drawImage(background(W, H), 0, 0);
  ctx.fillStyle = "rgba(8,12,28,0.35)"; ctx.fillRect(0, 0, W, H);
  const text = script.thumbnail_text || script.title;
  let px = 150; ctx.font = font(700, px, SERIF);
  let lines = wrap(ctx, text, W - 160);
  while (lines.length > 3 && px > 70) { px -= 10; ctx.font = font(700, px, SERIF); lines = wrap(ctx, text, W - 160); }
  ctx.textAlign = "left"; ctx.fillStyle = C.white; ctx.strokeStyle = "rgba(0,0,0,.55)"; ctx.lineWidth = 10; ctx.lineJoin = "round";
  const y0 = (H - lines.length * px * 1.1) / 2 + px * 0.85;
  lines.forEach((l, i) => { ctx.strokeText(l, 80, y0 + i * px * 1.1); ctx.fillText(l, 80, y0 + i * px * 1.1); });
  ctx.fillStyle = C.teal; rr(ctx, 80, 80, 330, 64, 32); ctx.fill();
  ctx.fillStyle = C.white; ctx.font = font(700, 30); ctx.textAlign = "center"; ctx.fillText("roamfact.com", 245, 123);
  fs.writeFileSync(file, cv.toBuffer("image/png"));
  return file;
}
