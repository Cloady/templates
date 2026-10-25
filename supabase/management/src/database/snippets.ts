import { readdir, readFile, stat } from "node:fs/promises";
import { posix } from "node:path";
import { env } from "../env.ts";
import { uuidFromBytes } from "../ids.ts";

interface Snippet {
  id: string;
  name: string;
  path: string;
  inserted: Date;
  updated: Date;
}

export function studioUuid(inputs: (string | null)[]): string {
  const input = inputs.filter(Boolean).join("_");
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash = hash & hash;
  }
  let seed = Math.abs(hash);
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = (seed >>> 16) & 0xff;
  }
  return uuidFromBytes(bytes);
}

async function list(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

const isSql = (entry: { name: string; isFile(): boolean }) => entry.isFile() && entry.name.endsWith(".sql");

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

async function snippet(path: string, file: string, folderId: string | null): Promise<Snippet> {
  const info = await stat(path);
  const name = file.replace(".sql", "");
  return {
    id: studioUuid([folderId, `${name}.sql`]),
    name,
    path,
    inserted: info.birthtimeMs > 0 ? info.birthtime : info.mtime,
    updated: info.mtime,
  };
}

async function scan(): Promise<Snippet[]> {
  const found: Snippet[] = [];
  for (const entry of await list(env.snippetsDir)) {
    const path = posix.join(env.snippetsDir, entry.name);
    if (isSql(entry)) found.push(await snippet(path, entry.name, null));
    if (!entry.isDirectory()) continue;
    const folderId = studioUuid([entry.name]);
    for (const file of await list(path)) {
      if (isSql(file)) found.push(await snippet(posix.join(path, file.name), file.name, folderId));
    }
  }
  return found;
}

function summary(s: Snippet) {
  const user = { id: 1, username: env.dashboardUsername };
  return {
    id: s.id,
    inserted_at: s.inserted.toISOString(),
    updated_at: s.updated.toISOString(),
    type: "sql",
    visibility: "user",
    name: s.name,
    description: null,
    project: { id: 1, name: env.projectName },
    owner: user,
    updated_by: user,
    favorite: false,
  };
}

export async function listSnippets(query: URLSearchParams): Promise<object[]> {
  const ref = query.get("project_ref");
  if (ref !== null && ref !== env.ref) return [];
  const snippets = await scan();
  snippets.sort(
    query.get("sort_by") === "name"
      ? (a, b) => compare(a.name.toLowerCase(), b.name.toLowerCase())
      : (a, b) => a.inserted.getTime() - b.inserted.getTime(),
  );
  if (query.get("sort_order") !== "asc") snippets.reverse();
  const limit = Number(query.get("limit"));
  return (Number.isInteger(limit) && limit > 0 ? snippets.slice(0, limit) : snippets).map(summary);
}

export async function getSnippet(id: string): Promise<object | null> {
  const found = (await scan()).find((s) => s.id === id);
  if (!found) return null;
  return { ...summary(found), content: { sql: await readFile(found.path, "utf8"), schema_version: "1.0", favorite: false } };
}
