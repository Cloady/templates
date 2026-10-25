import { enableSaml } from "../config/gotrue.ts";
import { env } from "../env.ts";
import { HttpError, json, omitNullish, readJson } from "../http.ts";
import type { Method, RouteDef } from "../router.ts";
import { upstream, urls } from "../upstream.ts";

type Json = Record<string, unknown>;

const PROVIDERS = "/admin/sso/providers";
const providerPath = (id: string) => `${PROVIDERS}/${encodeURIComponent(id)}`;
const provider = (data: unknown) => omitNullish(data as Json);

async function gotrue(path: string, method: Method = "GET", body?: unknown): Promise<Json> {
  const res = await upstream(`${urls.auth}${path}`, {
    method,
    headers: { authorization: `Bearer ${env.serviceRoleKey}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as Json | null;
  if (res.ok && data) return data;
  if (res.status >= 400 && res.status < 500) {
    throw new HttpError(res.status, String(data?.msg || data?.error_code || `auth answered ${res.status}`));
  }
  throw new HttpError(502, `auth answered ${res.status}`);
}

async function samlEnabled(): Promise<boolean> {
  return (await gotrue("/settings")).saml_enabled === true;
}

async function waitForSaml(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (await samlEnabled().catch(() => false)) return;
  }
  throw new HttpError(400, "The auth service did not enable SAML; check its logs");
}

export const routes: RouteDef[] = [
  {
    method: "GET",
    path: "/v1/projects/{ref}/config/auth/sso/providers",
    handler: async () => {
      if (!(await samlEnabled())) return json({ items: [] });
      const { items } = await gotrue(PROVIDERS);
      return json({ items: Array.isArray(items) ? items.map(provider) : [] });
    },
  },
  {
    method: "POST",
    path: "/v1/projects/{ref}/config/auth/sso/providers",
    handler: async ({ req }) => {
      const body = await readJson(req);
      if (!(await samlEnabled())) {
        await enableSaml();
        await waitForSaml();
      }
      return json(provider(await gotrue(PROVIDERS, "POST", body)), 201);
    },
  },
  {
    method: "GET",
    path: "/v1/projects/{ref}/config/auth/sso/providers/{provider_id}",
    handler: async ({ params }) => json(provider(await gotrue(providerPath(params.provider_id)))),
  },
  {
    method: "PUT",
    path: "/v1/projects/{ref}/config/auth/sso/providers/{provider_id}",
    handler: async ({ req, params }) => json(provider(await gotrue(providerPath(params.provider_id), "PUT", await readJson(req)))),
  },
  {
    method: "DELETE",
    path: "/v1/projects/{ref}/config/auth/sso/providers/{provider_id}",
    handler: async ({ params }) => json(provider(await gotrue(providerPath(params.provider_id), "DELETE"))),
  },
];

export async function init(): Promise<void> {}
