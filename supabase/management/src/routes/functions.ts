import { mkdir } from "node:fs/promises";
import { posix } from "node:path";
import { env } from "../env.ts";
import { serialUpload, withLock } from "../fsutil.ts";
import { empty, HttpError, json, readJson } from "../http.ts";
import { sha256Hex } from "../ids.ts";
import type { Ctx, RouteDef } from "../router.ts";
import { decodeBundle } from "../functions/eszip.ts";
import { multipartResponse, readSourceUpload } from "../functions/multipart.ts";
import { isSlug, slugOf, sourceLayout, usesDenoConfig } from "../functions/paths.ts";
import {
  activation,
  type DeployManifest,
  describe,
  type FunctionJson,
  type FunctionRecord,
  type FunctionStatus,
  functionJson,
  listFunctions,
  lookup,
  nextVersion,
  readManifest,
  removeFunction,
  saveRecord,
  sourceDownload,
  stage,
  sweepAbandoned,
  versionDir,
} from "../functions/store.ts";

interface BulkItem {
  slug: string;
  name: string;
  status: FunctionStatus;
  version: number;
  verify_jwt?: boolean | null;
}

const UPLOAD_LIMIT = 20 * 1024 * 1024;
const DOWNLOAD_LIMIT = 50 * 1024 * 1024;
const MAX_FILES = 1000;
const STATUSES = new Set<unknown>(["ACTIVE", "REMOVED", "THROTTLED"]);

const notFound = () => new HttpError(404, "Function not found");
const jsonSource = () => new HttpError(400, "Source updates through JSON are not supported");
const lock = (slug: string) => `fn:${slug}`;

function isJson(req: Request): boolean {
  return (req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
}

function limitUpload(req: Request): void {
  if (Number(req.headers.get("content-length")) > UPLOAD_LIMIT) throw new HttpError(413, "The upload is larger than 20 MiB");
}

async function readBody(req: Request): Promise<Uint8Array> {
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.byteLength > UPLOAD_LIMIT) throw new HttpError(413, "The upload is larger than 20 MiB");
  return body;
}

function flag(value: string | null): boolean | null {
  if (value === null) return null;
  if (value !== "true" && value !== "false") throw new HttpError(400, "verify_jwt must be true or false");
  return value === "true";
}

function withLocks<T>(slugs: string[], fn: () => Promise<T>): Promise<T> {
  const [first, ...rest] = slugs;
  return first === undefined ? fn() : withLock(lock(first), () => withLocks(rest, fn));
}

async function writeFiles(dir: string, targets: string[], files: File[]): Promise<void> {
  for (const [i, file] of files.entries()) await Bun.write(`${dir}/${targets[i]}`, file);
}

async function list(): Promise<Response> {
  return json(await listFunctions());
}

async function get({ params }: Ctx): Promise<Response> {
  const fn = await describe(slugOf(params.function_slug));
  if (!fn) throw notFound();
  return json(fn);
}

async function deploySource({ req, url }: Ctx): Promise<Response> {
  limitUpload(req);
  return serialUpload(async () => {
    const { metadata, files } = await readSourceUpload(req, UPLOAD_LIMIT, MAX_FILES);
    const slug = slugOf(url.searchParams.get("slug") || metadata.name);
    const names = files.map((f) => f.name);
    const entrypointPath = metadata.entrypoint_path;
    const importMapPath = metadata.import_map_path || null;
    const patterns = metadata.static_patterns ?? [];
    const layout = sourceLayout(names, [entrypointPath, ...(importMapPath ? [importMapPath] : []), ...patterns]);
    const inside = (path: string) => posix.join(layout.workdir, path);
    if (!layout.targets.includes(inside(entrypointPath))) throw new HttpError(400, "entrypoint_path must be one of the uploaded files");
    if (importMapPath && !layout.targets.includes(inside(importMapPath))) {
      throw new HttpError(400, "import_map_path must be one of the uploaded files");
    }
    return withLock(lock(slug), async () => {
      const record = (await lookup(slug))?.record ?? null;
      const version = await nextVersion(slug, record);
      const dir = versionDir(slug, version);
      const manifest: DeployManifest = {
        id: record?.id ?? crypto.randomUUID(),
        version,
        kind: "source",
        uploaded_at: Date.now(),
        name: metadata.name || slug,
        verify_jwt: metadata.verify_jwt ?? null,
        entrypoint_path: entrypointPath,
        import_map_path: importMapPath,
        static_patterns: patterns,
        files: names,
        up: layout.up,
        ezbr_sha256: null,
        active: {
          version,
          kind: "source",
          service_path: dir,
          entrypoint: Bun.pathToFileURL(`${dir}/${inside(entrypointPath)}`).href,
          import_map: importMapPath && !usesDenoConfig(importMapPath) ? `${dir}/${inside(importMapPath)}` : null,
          static_patterns: patterns.map((p) => `${dir}/${inside(p)}`),
          bundle: null,
        },
      };
      await stage(slug, manifest, (tmp) => writeFiles(tmp, layout.targets, files));
      const next = activation(slug, manifest, record);
      const staged = url.searchParams.get("bundleOnly") === "true";
      return json(functionJson(staged ? next : await saveRecord(slug, next, record)), 201);
    });
  });
}

async function deployBundle(req: Request, url: URL, slug: string, create: boolean): Promise<Response> {
  const query = url.searchParams;
  const verifyJwt = flag(query.get("verify_jwt"));
  const entrypoint = query.get("entrypoint_path");
  if (!entrypoint) throw new HttpError(400, "entrypoint_path is required");
  limitUpload(req);
  return serialUpload(async () => {
    const body = await readBody(req);
    const sha256 = await sha256Hex(body);
    const expected = query.get("ezbr_sha256");
    if (expected && expected.toLowerCase() !== sha256) throw new HttpError(400, "ezbr_sha256 does not match the uploaded body");
    const eszip = decodeBundle(body);
    return withLock(lock(slug), async () => {
      const found = await lookup(slug);
      if (create && found) throw new HttpError(400, "Duplicated function slug");
      if (!create && !found) throw notFound();
      const record = found?.record ?? null;
      const version = await nextVersion(slug, record);
      const dir = versionDir(slug, version);
      const manifest: DeployManifest = {
        id: record?.id ?? crypto.randomUUID(),
        version,
        kind: "bundle",
        uploaded_at: Date.now(),
        name: query.get("name") || record?.name || slug,
        verify_jwt: verifyJwt,
        entrypoint_path: entrypoint,
        import_map_path: query.get("import_map_path") || null,
        static_patterns: [],
        files: [],
        up: 0,
        ezbr_sha256: sha256,
        active: {
          version,
          kind: "bundle",
          service_path: dir,
          entrypoint,
          import_map: null,
          static_patterns: [],
          bundle: `${dir}/bundle.eszip`,
        },
      };
      await stage(slug, manifest, (tmp) => Bun.write(`${tmp}/bundle.eszip`, eszip));
      const next = await saveRecord(slug, activation(slug, manifest, record), record);
      return json(functionJson(next), create ? 201 : 200);
    });
  });
}

async function updateSettings(req: Request, slug: string): Promise<Response> {
  const body = await readJson(req);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "Body must be a JSON object");
  const { name, verify_jwt, body: source } = body as Record<string, unknown>;
  if (source !== undefined) throw jsonSource();
  if (name !== undefined && (typeof name !== "string" || name === "")) throw new HttpError(400, "name must be a non-empty string");
  if (verify_jwt !== undefined && typeof verify_jwt !== "boolean") throw new HttpError(400, "verify_jwt must be a boolean");
  return withLock(lock(slug), async () => {
    const found = await lookup(slug);
    if (!found) throw notFound();
    if (!found.record) throw new HttpError(400, "Deploy the function before updating its settings");
    const { record } = found;
    const next = { ...record, name: name ?? record.name, verify_jwt: verify_jwt ?? record.verify_jwt, updated_at: Date.now() };
    return json(functionJson(await saveRecord(slug, next, record)));
  });
}

async function createBundle({ req, url }: Ctx): Promise<Response> {
  if (isJson(req)) throw jsonSource();
  return deployBundle(req, url, slugOf(url.searchParams.get("slug")), true);
}

async function update({ req, url, params }: Ctx): Promise<Response> {
  const slug = slugOf(params.function_slug);
  return isJson(req) ? updateSettings(req, slug) : deployBundle(req, url, slug, false);
}

function bulkItems(body: unknown): BulkItem[] {
  if (!Array.isArray(body)) throw new HttpError(400, "Body must be an array of functions");
  for (const item of body) {
    const valid =
      typeof item === "object" &&
      item !== null &&
      typeof item.slug === "string" &&
      isSlug(item.slug) &&
      typeof item.name === "string" &&
      item.name !== "" &&
      STATUSES.has(item.status) &&
      Number.isSafeInteger(item.version) &&
      item.version > 0 &&
      (item.verify_jwt === undefined || item.verify_jwt === null || typeof item.verify_jwt === "boolean");
    if (!valid) throw new HttpError(400, "Invalid function update");
  }
  return body;
}

async function applyItem(item: BulkItem, manifest: DeployManifest | null): Promise<FunctionRecord> {
  const record = (await lookup(item.slug))?.record ?? null;
  const base = manifest ? activation(item.slug, manifest, record) : record && { ...record, updated_at: Date.now() };
  if (!base) throw new HttpError(400, `Function ${item.slug} has no uploaded version ${item.version}`);
  const next = { ...base, name: item.name, status: item.status, verify_jwt: item.verify_jwt ?? base.verify_jwt };
  return saveRecord(item.slug, next, record);
}

async function bulkUpdate({ req }: Ctx): Promise<Response> {
  const items = bulkItems(await readJson(req));
  return withLocks([...new Set(items.map((i) => i.slug))].sort(), async () => {
    const manifests: (DeployManifest | null)[] = [];
    for (const item of items) {
      const manifest = await readManifest(item.slug, item.version);
      if (!manifest && item.version !== (await lookup(item.slug))?.record?.version) {
        throw new HttpError(400, `Function ${item.slug} has no uploaded version ${item.version}`);
      }
      manifests.push(manifest);
    }
    const order = items.map((_, i) => i).sort((a, b) => (items[a].slug === items[b].slug ? a - b : items[a].slug < items[b].slug ? -1 : 1));
    const functions: FunctionJson[] = [];
    for (const i of order) functions[i] = functionJson(await applyItem(items[i], manifests[i]));
    return json({ functions });
  });
}

async function remove({ params }: Ctx): Promise<Response> {
  const slug = slugOf(params.function_slug);
  if (!(await withLock(lock(slug), () => removeFunction(slug)))) throw notFound();
  return empty(200);
}

async function download({ req, params }: Ctx): Promise<Response> {
  const slug = slugOf(params.function_slug);
  const found = await lookup(slug);
  if (!found) throw notFound();
  const bundle = found.record?.active.kind === "bundle" ? found.record.active.bundle : null;
  if (!(req.headers.get("accept") ?? "").toLowerCase().includes("multipart/form-data")) {
    if (!bundle) throw new HttpError(400, `Function ${slug} was deployed from source files; download it with --use-api.`);
    return new Response(Bun.file(bundle), { headers: { "content-type": "application/octet-stream" } });
  }
  if (bundle) {
    throw new HttpError(
      400,
      `Function ${slug} was deployed as an eszip bundle; download it with Docker running (supabase functions download without --use-api).`,
    );
  }
  const { metadata, files } = await sourceDownload(slug, found, DOWNLOAD_LIMIT);
  return multipartResponse(metadata, files);
}

const BASE = "/v1/projects/{ref}/functions";

export const routes: RouteDef[] = [
  { method: "GET", path: BASE, handler: list },
  { method: "POST", path: BASE, handler: createBundle },
  { method: "PUT", path: BASE, handler: bulkUpdate },
  { method: "POST", path: `${BASE}/deploy`, handler: deploySource },
  { method: "GET", path: `${BASE}/{function_slug}`, handler: get },
  { method: "PATCH", path: `${BASE}/{function_slug}`, handler: update },
  { method: "DELETE", path: `${BASE}/{function_slug}`, handler: remove },
  { method: "GET", path: `${BASE}/{function_slug}/body`, handler: download },
];

export async function init(): Promise<void> {
  await mkdir(env.functionsDir, { recursive: true });
  await sweepAbandoned();
}
