import { empty, error, errorV2, json, notAvailable, readJson } from "../http.ts";
import type { Ctx, RouteDef } from "../router.ts";

const P = "/v1/projects/{ref}";
const V2 = "/v2/projects/{ref}";
const ALL_V4 = "0.0.0.0/0";
const ALL_V6 = "::/0";
const DOMAINS =
  "Custom domains are managed by your hosting platform, not through the Management API on self-hosted Supabase.";
const RESTRICTIONS = {
  entitlement: "disallowed",
  config: { dbAllowedCidrs: [ALL_V4], dbAllowedCidrsV6: [ALL_V6] },
  status: "applied",
};
const SSL = { currentConfig: { database: false }, appliedSuccessfully: true };
const HOSTNAME = {
  status: "1_not_started",
  custom_hostname: "",
  data: { success: true, errors: [], messages: [], result: { id: "", hostname: "" } },
};
const BACKUPS = { region: "local", walg_enabled: false, pitr_enabled: false, backups: [], physical_backup_data: {} };
const LOGIN =
  "Browser login is not available for this self-hosted project. Run: supabase login --token sbp_<MANAGEMENT_TOKEN>";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const none = (list: unknown) => list == null || (Array.isArray(list) && list.length === 0);
const only = (list: unknown, cidr: string) =>
  list == null || (Array.isArray(list) && list.length === 1 && list[0] === cidr);

const noBranch = () => error(404, "Branch not found");
const domains = () => error(400, DOMAINS);
const noInstance = () => errorV2(404, "compute_instance_not_found", "Compute instance not found");
const noCompute = () => errorV2(400, "compute_not_enabled", "Compute is not available on self-hosted Supabase.");
const noNotebook = () => errorV2(404, "notebook_not_found", "Notebook not found");

async function patchRestrictions({ req }: Ctx): Promise<Response> {
  const body = await readJson(req);
  const unchanged =
    isRecord(body) &&
    [body.add, body.remove].every(
      (side) => side == null || (isRecord(side) && none(side.dbAllowedCidrs) && none(side.dbAllowedCidrsV6)),
    );
  if (!unchanged) notAvailable("Network restrictions");
  return json({
    entitlement: "disallowed",
    config: {
      dbAllowedCidrs: [
        { address: ALL_V4, type: "v4" },
        { address: ALL_V6, type: "v6" },
      ],
    },
    status: "applied",
  });
}

async function applyRestrictions({ req }: Ctx): Promise<Response> {
  const body = await readJson(req);
  if (!isRecord(body) || !only(body.dbAllowedCidrs, ALL_V4) || !only(body.dbAllowedCidrsV6, ALL_V6)) {
    notAvailable("Network restrictions");
  }
  return json(RESTRICTIONS, 201);
}

async function updateSsl({ req }: Ctx): Promise<Response> {
  const body = await readJson(req);
  if (!isRecord(body) || !isRecord(body.requestedConfig) || body.requestedConfig.database !== false) {
    notAvailable("SSL enforcement");
  }
  return json(SSL);
}

export const routes: RouteDef[] = [
  { method: "GET", path: `${P}/billing/addons`, handler: () => json({ selected_addons: [], available_addons: [] }) },
  { method: "GET", path: `${P}/branches`, handler: () => json([]) },
  { method: "POST", path: `${P}/branches`, handler: () => notAvailable("Preview branches") },
  { method: "DELETE", path: `${P}/branches`, handler: () => empty(200) },
  { method: "GET", path: `${P}/branches/{name}`, handler: noBranch },
  { method: "GET", path: "/v1/branches/{branch_id_or_ref}", handler: noBranch },
  { method: "PATCH", path: "/v1/branches/{branch_id_or_ref}", handler: noBranch },
  { method: "DELETE", path: "/v1/branches/{branch_id_or_ref}", handler: noBranch },
  { method: "POST", path: `${P}/pause`, handler: () => notAvailable("Pausing projects") },
  { method: "POST", path: `${P}/restore`, handler: () => notAvailable("Restoring paused projects") },
  { method: "GET", path: `${P}/custom-hostname`, handler: () => json(HOSTNAME) },
  { method: "POST", path: `${P}/custom-hostname/initialize`, handler: domains },
  { method: "POST", path: `${P}/custom-hostname/reverify`, handler: domains },
  { method: "POST", path: `${P}/custom-hostname/activate`, handler: domains },
  { method: "DELETE", path: `${P}/custom-hostname`, handler: domains },
  { method: "GET", path: `${P}/vanity-subdomain`, handler: () => json({ status: "not-used" }) },
  { method: "POST", path: `${P}/vanity-subdomain/check-availability`, handler: () => json({ available: false }, 201) },
  { method: "POST", path: `${P}/vanity-subdomain/activate`, handler: () => notAvailable("Vanity subdomains") },
  { method: "DELETE", path: `${P}/vanity-subdomain`, handler: () => empty(200) },
  { method: "GET", path: `${P}/database/backups`, handler: () => json(BACKUPS) },
  { method: "POST", path: `${P}/database/backups/restore-pitr`, handler: () => notAvailable("Point-in-time restore") },
  { method: "POST", path: `${P}/network-bans/retrieve`, handler: () => json({ banned_ipv4_addresses: [] }, 201) },
  { method: "DELETE", path: `${P}/network-bans`, handler: () => empty(200) },
  { method: "GET", path: `${P}/network-restrictions`, handler: () => json(RESTRICTIONS) },
  { method: "PATCH", path: `${P}/network-restrictions`, handler: patchRestrictions },
  { method: "POST", path: `${P}/network-restrictions/apply`, handler: applyRestrictions },
  { method: "GET", path: `${P}/ssl-enforcement`, handler: () => json(SSL) },
  { method: "PUT", path: `${P}/ssl-enforcement`, handler: updateSsl },
  { method: "GET", path: `${P}/analytics/endpoints/logs`, handler: () => json({ result: [] }) },
  { method: "GET", path: `${V2}/compute`, handler: () => json({ data: [] }) },
  { method: "GET", path: `${V2}/compute/{name}`, handler: noInstance },
  { method: "DELETE", path: `${V2}/compute/{name}`, handler: noInstance },
  { method: "POST", path: `${V2}/compute/{name}/uploads`, handler: noCompute },
  { method: "POST", path: `${V2}/compute/{name}/deploy`, handler: noCompute },
  { method: "GET", path: `${V2}/notebooks`, handler: () => json({ data: [], links: { prev: null, next: null } }) },
  {
    method: "POST",
    path: `${V2}/notebooks`,
    handler: () => errorV2(400, "notebook_disabled", "Notebooks are not available on self-hosted Supabase."),
  },
  { method: "GET", path: `${V2}/notebooks/{id}`, handler: noNotebook },
  { method: "PATCH", path: `${V2}/notebooks/{id}`, handler: noNotebook },
  { method: "DELETE", path: `${V2}/notebooks/{id}`, handler: noNotebook },
  { method: "GET", path: "/platform/cli/login/{session_id}", public: true, handler: () => error(404, LOGIN) },
];

export async function init(): Promise<void> {}
