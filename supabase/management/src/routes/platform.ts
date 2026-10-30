import { adminQuery } from "../db.ts";
import { env } from "../env.ts";
import { error, json, notAvailable } from "../http.ts";
import { stableUuid } from "../ids.ts";
import type { Ctx, RouteDef } from "../router.ts";
import { adminJwt, upstream, urls } from "../upstream.ts";

type Check = (signal: AbortSignal) => Promise<object | void>;

const startedAt = new Date().toISOString();
let createdAt: string | null = null;

const org = { id: env.orgSlug, slug: env.orgSlug, name: env.orgName };

const profile = {
  gotrue_id: await stableUuid(`profile:${env.ref}`),
  primary_email: env.adminEmail,
  username: env.dashboardUsername,
};

const legacyKeys = [
  { name: "anon", api_key: env.anonKey, id: "anon", type: "legacy", description: "Legacy anon API key" },
  {
    name: "service_role",
    api_key: env.serviceRoleKey,
    id: "service_role",
    type: "legacy",
    description: "Legacy service_role API key",
  },
];

const publishableId = await stableUuid(`publishable:${env.ref}`);
const secretId = await stableUuid(`secret:${env.ref}`);

function apiKeys(reveal: boolean): object[] {
  if (!env.sbKeyTranslation) return legacyKeys;
  return [
    ...legacyKeys,
    {
      name: "default",
      api_key: env.publishableKey,
      id: publishableId,
      type: "publishable",
      description: "Publishable API key",
    },
    {
      name: "default",
      api_key: reveal ? env.secretKey : null,
      id: secretId,
      type: "secret",
      description: "Secret API key",
      secret_jwt_template: { role: "service_role" },
    },
  ];
}

function expiry(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
}

async function within<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(ms);
  try {
    return await Promise.race([run(signal), expiry(signal)]);
  } catch (err) {
    throw signal.aborted ? new Error("timeout") : err;
  }
}

async function selectOne(): Promise<void> {
  await adminQuery("select 1");
}

async function created(): Promise<string> {
  createdAt ??= await within(3000, async () => {
    const [row] = await adminQuery<{ created_at: Date | null }>(
      "select (pg_stat_file('PG_VERSION', true)).modification as created_at",
    );
    return row?.created_at?.toISOString() ?? null;
  }).catch(() => null);
  return createdAt ?? startedAt;
}

async function project(): Promise<object> {
  const [healthy, created_at] = await Promise.all([
    within(3000, selectOne).then(
      () => true,
      () => false,
    ),
    created(),
  ]);
  return {
    id: env.ref,
    ref: env.ref,
    organization_id: env.orgSlug,
    organization_slug: env.orgSlug,
    name: env.projectName,
    region: "local",
    created_at,
    status: healthy ? "ACTIVE_HEALTHY" : "ACTIVE_UNHEALTHY",
    database: {
      host: `db.${env.ref}.${env.publicHost}`,
      version: env.postgresVersion,
      postgres_engine: env.postgresMajor,
      release_channel: "ga",
    },
  };
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

async function fields(res: Response): Promise<Record<string, unknown>> {
  return record(await res.json().catch(() => null));
}

async function reach(
  signal: AbortSignal,
  url: string,
  init: RequestInit = {},
  ok = (res: Response) => res.status === 200,
): Promise<Response> {
  const res = await upstream(url, { ...init, signal });
  if (ok(res)) return res;
  await discard(res);
  throw new Error(`status ${res.status}`);
}

const CHECKS: Record<string, Check> = {
  auth: async (signal) => {
    const body = await fields(await reach(signal, `${urls.auth}/health`));
    return typeof body.version === "string" && typeof body.description === "string"
      ? { name: "GoTrue", version: body.version, description: body.description }
      : undefined;
  },
  db: selectOne,
  db_postgres_user: async (signal) =>
    discard(
      await reach(signal, `${urls.meta}/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "select 1" }),
      }),
    ),
  pooler: async (signal) => discard(await reach(signal, `${urls.supavisor}/api/health`, {}, (res) => res.ok)),
  realtime: async (signal) => {
    const headers = { authorization: `Bearer ${await adminJwt()}` };
    const res = await reach(signal, `${urls.realtime}/api/tenants/realtime-dev/health`, { headers });
    const { healthy, db_connected, replication_connected, connected_cluster } = record((await fields(res)).data);
    return typeof healthy === "boolean" &&
      typeof db_connected === "boolean" &&
      typeof replication_connected === "boolean" &&
      Number.isInteger(connected_cluster)
      ? { healthy, db_connected, replication_connected, connected_cluster }
      : undefined;
  },
  rest: async (signal) =>
    discard(await reach(signal, `${urls.rest}/`, { headers: { authorization: `Bearer ${env.serviceRoleKey}` } })),
  storage: async (signal) => discard(await reach(signal, `${urls.storage}/status`)),
  pg_bouncer: async () => {
    throw new Error("PgBouncer is not part of this stack");
  },
};

async function check(name: string, ms: number): Promise<object> {
  try {
    return { name, healthy: true, status: "ACTIVE_HEALTHY", info: await within(ms, CHECKS[name]) };
  } catch (err) {
    return { name, healthy: false, status: "UNHEALTHY", error: err instanceof Error ? err.message : String(err) };
  }
}

async function health({ url }: Ctx): Promise<Response> {
  const names = [
    ...new Set(
      url.searchParams
        .getAll("services")
        .flatMap((value) => value.split(","))
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
  if (!names.length || !names.every((name) => Object.hasOwn(CHECKS, name))) {
    return error(400, `services must list one or more of: ${Object.keys(CHECKS).join(", ")}`);
  }
  const requested = Number(url.searchParams.get("timeout_ms"));
  const ms = Math.min(requested > 0 ? requested : 5000, 15000);
  return json(await Promise.all(names.map((name) => check(name, ms))));
}

export const routes: RouteDef[] = [
  { method: "GET", path: "/v1/profile", handler: () => json(profile) },
  { method: "GET", path: "/v1/organizations", handler: () => json([org]) },
  { method: "POST", path: "/v1/organizations", handler: () => notAvailable("Creating organizations") },
  {
    method: "GET",
    path: "/v1/organizations/{slug}/entitlements",
    handler: ({ params }) =>
      params.slug === env.orgSlug ? json({ entitlements: [] }) : error(404, "Organization not found"),
  },
  { method: "GET", path: "/v1/projects", handler: async () => json([await project()]) },
  { method: "POST", path: "/v1/projects", handler: () => notAvailable("Creating projects") },
  { method: "GET", path: "/v1/projects/{ref}", handler: async () => json(await project()) },
  { method: "DELETE", path: "/v1/projects/{ref}", handler: () => notAvailable("Deleting projects") },
  {
    method: "GET",
    path: "/v1/projects/{ref}/api-keys",
    handler: ({ url }) => json(apiKeys(url.searchParams.get("reveal") === "true")),
  },
  { method: "GET", path: "/v1/projects/{ref}/health", handler: health },
];

export async function init(): Promise<void> {}
