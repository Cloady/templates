import { mkdir } from "node:fs/promises";
import { authAttributes, TEMPLATES_DIR, updateAuth } from "../config/gotrue.ts";
import { postgrestConfig, updatePostgrest } from "../config/postgrest.ts";
import { checkStorageUpdate, storageAttributes, storageConfig } from "../config/storage.ts";
import { POSTGRES_SETTINGS, postgresMajorVersion, readPostgresOverrides } from "../database/settings.ts";
import { env } from "../env.ts";
import { empty, HttpError, json, readJson } from "../http.ts";
import type { RouteDef } from "../router.ts";
import { adminJwt, upstream, urls } from "../upstream.ts";

interface Tenant {
  users?: { mode_type?: unknown }[];
  default_pool_size?: unknown;
  default_max_clients?: unknown;
}

async function objectBody(req: Request, maxBytes?: number): Promise<Record<string, unknown>> {
  const body = await readJson(req, maxBytes);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "Body must be a JSON object");
  return body as Record<string, unknown>;
}

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(env.vars[name] ?? "", 10);
  return Number.isSafeInteger(n) ? n : fallback;
}

async function databaseBlock() {
  const [major, overrides] = await Promise.all([postgresMajorVersion(), readPostgresOverrides()]);
  return {
    major_version: major,
    ssl_enforced: false,
    network_restrictions: {
      entitlement: "disallowed",
      status: "applied",
      allowed_cidrs: [
        { address: "0.0.0.0/0", type: "v4" },
        { address: "::/0", type: "v6" },
      ],
    },
    postgres_settings: Object.fromEntries(
      POSTGRES_SETTINGS.filter((s) => Object.hasOwn(overrides, s.api)).map((s) => [s.v2, overrides[s.api]]),
    ),
  };
}

async function poolerBlock() {
  const tenant = await upstream(`${urls.supavisor}/api/tenants/${encodeURIComponent(env.poolerTenantId)}`, {
    headers: { authorization: `Bearer ${await adminJwt()}` },
    timeoutMs: 5000,
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => (body as { data?: Tenant } | null)?.data)
    .catch(() => undefined);
  const mode = tenant?.users?.[0]?.mode_type;
  const size = tenant?.default_pool_size;
  const max = tenant?.default_max_clients;
  if (typeof mode === "string" && Number.isSafeInteger(size) && Number.isSafeInteger(max)) {
    return { pool_mode: mode, default_pool_size: size, max_client_conn: max };
  }
  return {
    pool_mode: "transaction",
    default_pool_size: envInt("POOLER_DEFAULT_POOL_SIZE", 20),
    max_client_conn: envInt("POOLER_MAX_CLIENT_CONN", 100),
  };
}

const BLOCKS: [string, () => Promise<unknown>][] = [
  ["database", databaseBlock],
  ["pooler", poolerBlock],
  ["auth", authAttributes],
  ["api", postgrestConfig],
  ["storage", storageAttributes],
];

async function projectConfig(): Promise<Response> {
  const settled = await Promise.allSettled(BLOCKS.map(([, read]) => read()));
  const attributes: Record<string, unknown> = {};
  settled.forEach((result, i) => {
    const name = BLOCKS[i][0];
    if (result.status === "fulfilled") attributes[name] = result.value;
    else console.error(`management: config block ${name} failed: ${result.reason instanceof Error ? result.reason.message : result.reason}`);
  });
  if (Object.keys(attributes).length === 0) {
    throw new HttpError(502, "The project configuration could not be read", "internal_server_error");
  }
  return json({ data: { type: "project_config", id: env.ref, attributes } });
}

export const routes: RouteDef[] = [
  {
    method: "PATCH",
    path: "/v1/projects/{ref}/config/auth",
    handler: async ({ req }) => json(await updateAuth(await objectBody(req, 4 * 1024 * 1024))),
  },
  {
    method: "GET",
    path: "/v1/projects/{ref}/postgrest",
    handler: async () => json({ ...(await postgrestConfig()), jwt_secret: env.jwtSecret }),
  },
  {
    method: "PATCH",
    path: "/v1/projects/{ref}/postgrest",
    handler: async ({ req }) => json(await updatePostgrest(await objectBody(req))),
  },
  {
    method: "GET",
    path: "/v1/projects/{ref}/config/storage",
    handler: async () => json(await storageConfig()),
  },
  {
    method: "PATCH",
    path: "/v1/projects/{ref}/config/storage",
    handler: async ({ req }) => {
      checkStorageUpdate(await objectBody(req));
      return empty(200);
    },
  },
  {
    method: "GET",
    path: "/v2/projects/{ref}/config",
    handler: projectConfig,
  },
];

export async function init(): Promise<void> {
  await mkdir(TEMPLATES_DIR, { recursive: true });
}
