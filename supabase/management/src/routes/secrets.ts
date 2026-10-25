import { mkdir } from "node:fs/promises";
import { deleteSecrets, listSecrets, SECRETS_DIR, setSecrets } from "../config/secrets-store.ts";
import { empty, json, readJson } from "../http.ts";
import type { RouteDef } from "../router.ts";

export const routes: RouteDef[] = [
  {
    method: "GET",
    path: "/v1/projects/{ref}/secrets",
    handler: async () => json(await listSecrets()),
  },
  {
    method: "POST",
    path: "/v1/projects/{ref}/secrets",
    handler: async ({ req }) => {
      await setSecrets(await readJson(req));
      return empty(201);
    },
  },
  {
    method: "DELETE",
    path: "/v1/projects/{ref}/secrets",
    handler: async ({ req }) => {
      await deleteSecrets(await readJson(req));
      return empty(200);
    },
  },
];

export async function init(): Promise<void> {
  await mkdir(SECRETS_DIR, { recursive: true });
}
