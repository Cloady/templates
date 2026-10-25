import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { randomAlnum } from "./ids.ts";

export async function writeFileAtomic(path: string, data: string | Uint8Array, mode = 0o644): Promise<void> {
  const dir = posix.dirname(path);
  const tmp = `${dir}/.${posix.basename(path)}.tmp-${randomAlnum(8)}`;
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(tmp, data, { mode });
    await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(text) as T;
}

const locks = new Map<string | symbol, Promise<unknown>>();
const UPLOAD = Symbol("upload");

async function locked<T>(key: string | symbol, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return locked(key, fn);
}

export function serialUpload<T>(fn: () => Promise<T>): Promise<T> {
  return locked(UPLOAD, fn);
}
