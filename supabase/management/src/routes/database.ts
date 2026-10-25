import { adminExec, adminQuery, adminTx, quoteLiteral } from "../db.ts";
import { LINTS_SQL } from "../database/lints-sql.ts";
import { dbCall, readPostgresOverrides, writePostgresOverrides } from "../database/settings.ts";
import { getSnippet, listSnippets } from "../database/snippets.ts";
import { env } from "../env.ts";
import { empty, HttpError, json, notAvailable, omitNullish, readJson } from "../http.ts";
import { nowMs, randomAlnum } from "../ids.ts";
import type { Ctx, RouteDef } from "../router.ts";
import { upstream, urls } from "../upstream.ts";

const PROJECT = "/v1/projects/{ref}";
const SPLIT = LINTS_SQL.indexOf(";\n\n");
const LINTS_SETUP = SPLIT === -1 ? "" : LINTS_SQL.slice(0, SPLIT);
const LINTS_QUERY = SPLIT === -1 ? LINTS_SQL : LINTS_SQL.slice(SPLIT + 3);

interface LintRow {
  name: string;
  title: string;
  level: string;
  facing: string;
  categories: unknown;
  description: string;
  detail: string;
  remediation: string;
  metadata: unknown;
  cache_key: string;
}

let restVersion: { value: string; at: number } | null = null;

async function objectBody(req: Request, maxBytes?: number): Promise<Record<string, unknown>> {
  const body = await readJson(req, maxBytes);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

async function metaError(res: Response): Promise<HttpError> {
  const text = await res.text().catch(() => "");
  let message = text;
  try {
    const body = JSON.parse(text) as { error?: unknown } | null;
    if (typeof body?.error === "string") message = body.error;
  } catch {}
  return new HttpError(res.status < 500 ? res.status : 502, message || `meta answered ${res.status}`);
}

async function runQuery({ req }: Ctx): Promise<Response> {
  const { query, parameters, read_only } = await objectBody(req, 3 * 1024 * 1024);
  if (read_only === true) throw new HttpError(400, "read_only queries are not supported");
  if (typeof query !== "string" || query === "") throw new HttpError(400, "query must be a non-empty string");
  if (parameters !== undefined && !Array.isArray(parameters)) throw new HttpError(400, "parameters must be an array");
  const res = await upstream(`${urls.meta}/query?queryTimeoutSecs=3600`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pg-application-name": "supabase-management" },
    body: JSON.stringify({ query, parameters }),
    timeoutMs: 3_600_000,
    signal: req.signal,
  });
  if (!res.ok) throw await metaError(res);
  return new Response(res.body, { status: 201, headers: { "content-type": "application/json" } });
}

async function postgrestVersion(): Promise<string | null> {
  if (restVersion && nowMs() - restVersion.at < 600_000) return restVersion.value;
  try {
    const res = await upstream(`${urls.rest}/`, {
      headers: { accept: "application/openapi+json", authorization: `Bearer ${env.serviceRoleKey}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { info?: { version?: unknown } } | null;
    const value = /^\d+(\.\d+)*/.exec(String(body?.info?.version ?? ""))?.[0];
    if (!value) return null;
    restVersion = { value, at: nowMs() };
    return value;
  } catch {
    return null;
  }
}

async function typescriptTypes({ url }: Ctx): Promise<Response> {
  const params = new URLSearchParams();
  const schemas = url.searchParams.get("included_schemas");
  if (schemas !== null) params.set("included_schemas", schemas);
  params.set("detect_one_to_one_relationships", "true");
  const version = await postgrestVersion();
  if (version) params.set("postgrest_version", version);
  const res = await upstream(`${urls.meta}/generators/typescript?${params}`, { timeoutMs: 120_000 });
  if (!res.ok) throw await metaError(res);
  return json({ types: await res.text() });
}

async function loginRole({ req }: Ctx): Promise<Response> {
  const { read_only } = await objectBody(req);
  if (typeof read_only !== "boolean") throw new HttpError(400, "read_only must be a boolean");
  const parent = read_only ? "supabase_read_only_user" : "postgres";
  const role = `cli_login_${parent}`;
  if (read_only) {
    const rows = await dbCall(() => adminQuery("select 1 from pg_roles where rolname = $1", [parent]));
    if (!rows.length) throw new HttpError(400, `The ${parent} role does not exist`);
  }
  const password = randomAlnum(32);
  const login = `${role} WITH LOGIN PASSWORD ${quoteLiteral(password)} VALID UNTIL ${quoteLiteral(new Date(nowMs() + 3_600_000).toISOString())}`;
  await dbCall(() =>
    adminExec(`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(role)}) THEN
    ALTER ROLE ${login};
  ELSE
    CREATE ROLE ${login};
  END IF;
END $$;
GRANT ${parent} TO ${role};`),
  );
  return json({ role, password, ttl_seconds: 3600 }, 201);
}

async function lintRows(): Promise<LintRow[]> {
  const rollback = new Error("rollback");
  let rows: LintRow[] = [];
  try {
    await adminTx(async (tx) => {
      await tx.unsafe("set local statement_timeout = '60s'");
      if (LINTS_SETUP) await tx.unsafe(LINTS_SETUP);
      rows = await tx.unsafe(LINTS_QUERY);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
  return rows;
}

const parsed = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value);

function lint(row: LintRow) {
  return omitNullish({
    name: row.name,
    title: row.title,
    level: row.level,
    facing: row.facing,
    categories: parsed(row.categories) as string[],
    description: row.description,
    detail: row.detail,
    remediation: row.remediation,
    cache_key: row.cache_key,
    metadata: parsed(row.metadata),
  });
}

async function advisors(category: string): Promise<Response> {
  const lints = (await dbCall(lintRows)).map(lint).filter((l) => l.categories?.includes(category));
  return json({ lints });
}

async function enableWebhooks(): Promise<Response> {
  const rows = await dbCall(() => adminQuery("select 1 from pg_namespace where nspname = 'supabase_functions'"));
  if (!rows.length) {
    throw new HttpError(400, "The supabase_functions schema is missing; it is created when the database is first initialised.");
  }
  return empty(201);
}

async function rootKey(): Promise<Response> {
  const notFound = () => new HttpError(404, "pgsodium root key not found");
  const [row] = await dbCall(
    () => adminQuery<{ root_key: string | null }>("select pg_read_file('/etc/postgresql-custom/pgsodium_root.key') as root_key"),
    notFound,
  );
  const key = row?.root_key?.trim();
  if (!key) throw notFound();
  return json({ root_key: key });
}

async function snippet({ params }: Ctx): Promise<Response> {
  const found = await getSnippet(params.id);
  if (!found) throw new HttpError(404, "Snippet not found");
  return json(found);
}

export const routes: RouteDef[] = [
  { method: "POST", path: `${PROJECT}/database/query`, handler: runQuery },
  { method: "GET", path: `${PROJECT}/types/typescript`, handler: typescriptTypes },
  { method: "POST", path: `${PROJECT}/cli/login-role`, handler: loginRole },
  { method: "GET", path: `${PROJECT}/config/database/pooler`, handler: () => json([]) },
  { method: "GET", path: `${PROJECT}/config/database/postgres`, handler: async () => json(await readPostgresOverrides()) },
  {
    method: "PUT",
    path: `${PROJECT}/config/database/postgres`,
    handler: async ({ req }) => json(await writePostgresOverrides(await objectBody(req))),
  },
  { method: "GET", path: `${PROJECT}/advisors/security`, handler: () => advisors("SECURITY") },
  { method: "GET", path: `${PROJECT}/advisors/performance`, handler: () => advisors("PERFORMANCE") },
  { method: "POST", path: `${PROJECT}/database/webhooks/enable`, handler: enableWebhooks },
  { method: "GET", path: `${PROJECT}/pgsodium`, handler: rootKey },
  { method: "PUT", path: `${PROJECT}/pgsodium`, handler: () => notAvailable("Rotating the pgsodium root key") },
  { method: "GET", path: "/v1/snippets", handler: async ({ url }) => json({ data: await listSnippets(url.searchParams) }) },
  { method: "GET", path: "/v1/snippets/{id}", handler: snippet },
];

export async function init(): Promise<void> {}
