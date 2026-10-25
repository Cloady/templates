import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { posix } from "node:path";
import { env } from "../env.ts";
import { readJsonFile, writeFileAtomic } from "../fsutil.ts";
import { HttpError, omitNullish } from "../http.ts";
import { randomAlnum, stableUuid } from "../ids.ts";
import type { DownloadFile } from "./multipart.ts";
import { hasControlChars, isSlug, workdirOf } from "./paths.ts";

export type FunctionStatus = "ACTIVE" | "REMOVED" | "THROTTLED";

export interface ActiveVersion {
  version: number;
  kind: "source" | "bundle";
  service_path: string;
  entrypoint: string;
  import_map: string | null;
  static_patterns: string[];
  bundle: string | null;
}

export interface FunctionRecord {
  id: string;
  slug: string;
  name: string;
  status: FunctionStatus;
  version: number;
  created_at: number;
  updated_at: number;
  verify_jwt: boolean;
  import_map: boolean;
  entrypoint_path: string;
  import_map_path: string | null;
  ezbr_sha256: string | null;
  active: ActiveVersion;
}

export interface DeployManifest {
  id: string;
  version: number;
  kind: "source" | "bundle";
  uploaded_at: number;
  name: string;
  verify_jwt: boolean | null;
  entrypoint_path: string;
  import_map_path: string | null;
  static_patterns: string[];
  files: string[];
  up: number;
  ezbr_sha256: string | null;
  active: ActiveVersion;
}

export type FunctionJson = Partial<Omit<FunctionRecord, "active">>;

export type Found = { record: FunctionRecord; index: null } | { record: null; index: string };

export interface SourceDownload {
  metadata: object;
  files: DownloadFile[];
}

const HOUR_MS = 3_600_000;
const VERSION_NAME = /^[1-9][0-9]*$/;
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.mjs", "index.jsx"];

export const functionDir = (slug: string) => `${env.functionsDir}/${slug}`;
export const versionDir = (slug: string, version: number) => `${functionDir(slug)}/.v/${version}`;
const recordPath = (slug: string) => `${functionDir(slug)}/.function.json`;
const errorCode = (err: unknown) => (err as NodeJS.ErrnoException).code;

function diskError(err: unknown): unknown {
  return errorCode(err) === "ENOSPC" ? new HttpError(507, "No space left on the functions volume") : err;
}

async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if (errorCode(err) === "ENOENT" || errorCode(err) === "ENOTDIR") return [];
    throw err;
  }
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

async function indexFile(slug: string): Promise<string | null> {
  for (const name of INDEX_FILES) if (await isFile(`${functionDir(slug)}/${name}`)) return name;
  return null;
}

export async function lookup(slug: string): Promise<Found | null> {
  const record = await readJsonFile<FunctionRecord>(recordPath(slug)).catch((err) => {
    if (errorCode(err) === "ENOTDIR") return null;
    throw err;
  });
  if (record) return { record, index: null };
  const index = await indexFile(slug);
  return index ? { record: null, index } : null;
}

export function functionJson({ active, ...fields }: FunctionRecord): FunctionJson {
  return omitNullish(fields);
}

async function legacyJson(slug: string, index: string): Promise<FunctionJson> {
  const modified = Math.trunc((await stat(`${functionDir(slug)}/${index}`)).mtimeMs);
  return {
    id: await stableUuid(`function:${slug}`),
    slug,
    name: slug,
    status: "ACTIVE",
    version: 1,
    created_at: modified,
    updated_at: modified,
    verify_jwt: env.verifyJwtDefault,
    import_map: false,
    entrypoint_path: `supabase/functions/${slug}/${index}`,
  };
}

export async function describe(slug: string): Promise<FunctionJson | null> {
  const found = await lookup(slug);
  if (!found) return null;
  return found.record ? functionJson(found.record) : legacyJson(slug, found.index);
}

export async function listFunctions(): Promise<FunctionJson[]> {
  const dirs = await readdir(env.functionsDir, { withFileTypes: true });
  const slugs = dirs.filter((d) => d.isDirectory() && isSlug(d.name)).map((d) => d.name);
  const all = await Promise.all(slugs.sort().map(describe));
  return all.filter((fn) => fn !== null);
}

export async function nextVersion(slug: string, record: FunctionRecord | null): Promise<number> {
  const versions = (await entries(`${functionDir(slug)}/.v`)).filter((n) => VERSION_NAME.test(n)).map(Number);
  return 1 + Math.max(record?.version ?? 0, ...versions);
}

export async function stage(slug: string, manifest: DeployManifest, write: (dir: string) => Promise<unknown>): Promise<void> {
  const parent = `${functionDir(slug)}/.v`;
  const tmp = `${parent}/.tmp-${randomAlnum(8)}`;
  try {
    await mkdir(tmp, { recursive: true });
    await write(tmp);
    await writeFileAtomic(`${tmp}/deploy.json`, JSON.stringify(manifest));
    await rename(tmp, `${parent}/${manifest.version}`);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw diskError(err);
  }
}

export function readManifest(slug: string, version: number): Promise<DeployManifest | null> {
  return readJsonFile<DeployManifest>(`${versionDir(slug, version)}/deploy.json`);
}

export function activation(slug: string, manifest: DeployManifest, record: FunctionRecord | null): FunctionRecord {
  const now = Date.now();
  return {
    id: record?.id ?? manifest.id,
    slug,
    name: manifest.name,
    status: "ACTIVE",
    version: manifest.version,
    created_at: record?.created_at ?? now,
    updated_at: now,
    verify_jwt: manifest.verify_jwt ?? record?.verify_jwt ?? env.verifyJwtDefault,
    import_map: Boolean(manifest.import_map_path),
    entrypoint_path: manifest.entrypoint_path,
    import_map_path: manifest.import_map_path,
    ezbr_sha256: manifest.ezbr_sha256,
    active: manifest.active,
  };
}

async function prune(slug: string, active: number, previous: number): Promise<void> {
  const parent = `${functionDir(slug)}/.v`;
  const floor = Math.min(active, previous);
  for (const name of await entries(parent)) {
    const version = VERSION_NAME.test(name) ? Number(name) : Number.NaN;
    if (version === active || version === previous) continue;
    const recent = version > floor && Date.now() - (await stat(`${parent}/${name}`)).mtimeMs < HOUR_MS;
    if (!recent) await rm(`${parent}/${name}`, { recursive: true, force: true });
  }
}

export async function saveRecord(slug: string, next: FunctionRecord, previous: FunctionRecord | null): Promise<FunctionRecord> {
  try {
    await writeFileAtomic(recordPath(slug), JSON.stringify(next));
  } catch (err) {
    throw diskError(err);
  }
  if (next.version !== previous?.version) {
    await prune(slug, next.version, previous?.version ?? next.version - 1).catch((err) =>
      console.error(`management: cleaning old versions of ${slug} failed: ${String(err)}`),
    );
  }
  return next;
}

export async function removeFunction(slug: string): Promise<boolean> {
  if (!(await isDirectory(functionDir(slug)))) return false;
  await rm(functionDir(slug), { recursive: true, force: true });
  return true;
}

export async function sweepAbandoned(): Promise<void> {
  const now = Date.now();
  for (const entry of await readdir(env.functionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isSlug(entry.name)) continue;
    const dir = functionDir(entry.name);
    const names = await entries(dir);
    if (names.length !== 1 || names[0] !== ".v") continue;
    const ages = await Promise.all((await entries(`${dir}/.v`)).map(async (n) => now - (await stat(`${dir}/.v/${n}`)).mtimeMs));
    if (ages.every((age) => age > HOUR_MS)) await rm(dir, { recursive: true, force: true });
  }
}

async function walk(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || hasControlChars(entry.name)) continue;
    if (entry.isDirectory()) out.push(...(await walk(`${dir}/${entry.name}`, `${prefix}${entry.name}/`)));
    else if (entry.isFile()) out.push(`${prefix}${entry.name}`);
  }
  return out;
}

async function managedSource(record: FunctionRecord): Promise<SourceDownload> {
  const manifest = await readJsonFile<DeployManifest>(`${record.active.service_path}/deploy.json`);
  if (!manifest) throw new Error(`deploy.json of ${record.slug} version ${record.version} is missing`);
  const workdir = `${record.active.service_path}/${workdirOf(manifest.up)}`;
  return {
    metadata: omitNullish({
      entrypoint_path: record.entrypoint_path,
      import_map_path: record.import_map_path,
      static_patterns: manifest.static_patterns.length ? manifest.static_patterns : null,
      name: record.name,
    }),
    files: manifest.files.map((path) => ({ path, source: posix.join(workdir, path) })),
  };
}

async function legacySource(slug: string, index: string): Promise<SourceDownload> {
  const prefix = `supabase/functions/${slug}`;
  const files = (await walk(functionDir(slug))).sort();
  return {
    metadata: { entrypoint_path: `${prefix}/${index}`, name: slug },
    files: files.map((rel) => ({ path: `${prefix}/${rel}`, source: `${functionDir(slug)}/${rel}` })),
  };
}

export async function sourceDownload(slug: string, found: Found, maxBytes: number): Promise<SourceDownload> {
  const download = found.record ? await managedSource(found.record) : await legacySource(slug, found.index);
  const sizes = await Promise.all(download.files.map(async (f) => (await stat(f.source)).size));
  if (sizes.reduce((sum, size) => sum + size, 0) > maxBytes) {
    throw new HttpError(413, `The function's files are larger than ${maxBytes / 1048576} MiB`);
  }
  return download;
}
