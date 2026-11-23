/**
 * Хранилище готовых видео между запусками workflow: GitHub Releases (ассеты до 2 ГБ, бесплатно).
 * Локально (или STORAGE=local) файлы просто лежат в data/out/<id>/.
 */
import fs from "node:fs";
import path from "node:path";
import { OUT, env, log, sh } from "./util.js";

const useRelease = () => env("STORAGE", env("GITHUB_ACTIONS") ? "release" : "local") === "release";
export const tagFor = (id) => `vid-${id}`;
export const dirFor = (id) => path.join(OUT, id);

export function put(id, files) {
  if (!useRelease()) return { where: "local", url: dirFor(id) };
  const tag = tagFor(id);
  try { sh("gh", ["release", "view", tag]); sh("gh", ["release", "upload", tag, ...files, "--clobber"]); }
  catch {
    sh("gh", ["release", "create", tag, ...files, "--title", `Video ${id}`, "--notes", "Файлы видео для агента (удаляются после публикации)", "--prerelease"]);
  }
  const url = sh("gh", ["release", "view", tag, "--json", "url", "-q", ".url"]).trim();
  log(`  файлы в релизе ${url}`);
  return { where: "release", url };
}

export function get(id) {
  const dir = dirFor(id);
  if (useRelease()) {
    fs.mkdirSync(dir, { recursive: true });
    sh("gh", ["release", "download", tagFor(id), "-D", dir, "--clobber"]);
  }
  return dir;
}

export function drop(id) {
  if (!useRelease()) return;
  try { sh("gh", ["release", "delete", tagFor(id), "--cleanup-tag", "-y"]); } catch { /* уже нет */ }
}
