import { readFile, rm } from "node:fs/promises";
import { env } from "../env.ts";
import { readJsonFile, withLock, writeFileAtomic } from "../fsutil.ts";
import { HttpError } from "../http.ts";
import { hmacSha256Hex, sha256Hex } from "../ids.ts";
import { AUTH_KEYS, type AuthKey, ENUMS, RESPONSE_FALLBACKS } from "./gotrue-map.ts";
import { generateSamlKey } from "./saml-key.ts";

type Overrides = Record<string, string>;
type Value = string | number | boolean;
type Entry = readonly [AuthKey, Value | undefined];

const OVERRIDES = `${env.authConfigDir}/management.json`;
const TEMPLATE_URL = `${env.internalBaseUrl}/internal/auth/templates/`;
const TEMPLATE_MAX_BYTES = 1_000_000;
const POOL = "GOTRUE_DB_MAX_POOL_SIZE";
const PERCENT = "GOTRUE_DB_CONN_PERCENTAGE";
const SAML_KEY = "GOTRUE_SAML_PRIVATE_KEY";
const SPECIAL = new Set(["template", "clientids-head", "clientids-tail", "poolsize", "poolunit"]);
const NANOS: Record<string, number> = { ns: 1, us: 1e3, "µs": 1e3, "μs": 1e3, ms: 1e6, s: 1e9, m: 6e10, h: 3.6e12 };
const EMAIL = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/u;
const byKey = new Map(AUTH_KEYS.map((row) => [row.key, row]));
const templateType = (row: AuthKey) => row.key.slice("mailer_templates_".length, -"_content".length);

export const TEMPLATES_DIR = `${env.authConfigDir}/templates`;
export const TEMPLATE_TYPES = AUTH_KEYS.filter((row) => row.conv === "template").map(templateType);
export const templatePath = (type: string) => `${TEMPLATES_DIR}/${type}.html`;

async function readOverrides(): Promise<Overrides> {
  try {
    return (await readJsonFile<Overrides>(OVERRIDES)) ?? {};
  } catch {
    throw new HttpError(500, `${OVERRIDES} could not be read`);
  }
}

function effective(o: Overrides, name: string): string | undefined {
  return o[name] ?? env.vars[name];
}

function int(text: string): number | undefined {
  const n = Number(text);
  return /^[+-]?\d+$/.test(text.trim()) && Number.isSafeInteger(n) ? n : undefined;
}

function nanos(text: string): number | undefined {
  const trimmed = text.trim();
  const body = trimmed.replace(/^[+-]/, "");
  const parts = [...body.matchAll(/(\d+\.?\d*|\.\d+)(ns|us|µs|μs|ms|s|m|h)/g)];
  if (body !== "0" && (parts.length === 0 || parts.map((p) => p[0]).join("") !== body)) return undefined;
  const total = parts.reduce((sum, p) => sum + Number(p[1]) * NANOS[p[2]], 0);
  return trimmed.startsWith("-") ? -total : total;
}

function per(text: string, unit: number): number | undefined {
  const n = nanos(text);
  return n === undefined ? undefined : n / unit;
}

function rate(text: string): number | undefined {
  const m = /^(\d+)(?:\/(.+))?$/.exec(text.trim());
  return m && (m[2] === undefined || nanos(m[2]) === NANOS.h) ? int(m[1]) : undefined;
}

function fromEnv(row: AuthKey, raw: string): Value | undefined {
  switch (row.conv) {
    case "bool":
      return /^(true|1|yes|on)$/i.test(raw.trim());
    case "int":
      return int(raw);
    case "rate":
      return rate(raw);
    case "seconds": {
      const seconds = per(raw, NANOS.s);
      return seconds === undefined ? undefined : Math.trunc(seconds);
    }
    case "hours":
      return per(raw, NANOS.h);
    case "otpmap":
      return raw.split(",").filter(Boolean).map((pair) => pair.replace(":", "=")).join(",");
    case "clientids-head":
      return raw.split(",")[0];
    case "clientids-tail":
      return raw.split(",").slice(1).join(",");
    default:
      return row.type === "enum" && !ENUMS[row.key].includes(raw) ? undefined : raw;
  }
}

function toEnv(row: AuthKey, value: Value | null): string {
  if (value === null) return row.default ?? (row.type === "boolean" ? "false" : row.type === "integer" ? "0" : "");
  if (row.conv === "seconds") return `${value}s`;
  if (row.conv === "hours") return `${value}h`;
  if (row.conv === "otpmap") return String(value).split(",").filter(Boolean).map((pair) => pair.replace("=", ":")).join(",");
  return String(value);
}

async function templateContent(row: AuthKey, raw: string): Promise<string | undefined> {
  const url = `${TEMPLATE_URL}${templateType(row)}`;
  if (raw !== url && !raw.startsWith(`${url}?`)) return undefined;
  return readFile(templatePath(templateType(row)), "utf8").catch(() => undefined);
}

function pool(o: Overrides): [number, string] | undefined {
  const percent = int(effective(o, PERCENT) ?? "") ?? 0;
  const size = int(effective(o, POOL) ?? "") ?? 0;
  return percent > 0 ? [percent, "percent"] : size > 0 ? [size, "connections"] : undefined;
}

async function valueOf(o: Overrides, row: AuthKey): Promise<Value | undefined> {
  if (row.conv === "poolsize") return pool(o)?.[0];
  if (row.conv === "poolunit") return pool(o)?.[1];
  const raw = row.env ? (effective(o, row.env) ?? row.default) : undefined;
  if (raw === undefined) return undefined;
  return row.conv === "template" ? templateContent(row, raw) : fromEnv(row, raw);
}

function values(o: Overrides): Promise<Entry[]> {
  return Promise.all(AUTH_KEYS.map(async (row): Promise<Entry> => [row, await valueOf(o, row)]));
}

function patchResponse(entries: Entry[]): Record<string, unknown> {
  return Object.fromEntries(
    entries.map(([row, value]) => {
      const hidden = row.secret || (row.key === "smtp_admin_email" && !EMAIL.test(String(value)));
      return [row.key, (hidden ? undefined : value) ?? RESPONSE_FALLBACKS[row.key] ?? null];
    }),
  );
}

export async function authAttributes(): Promise<Record<string, Value>> {
  const known = (await values(await readOverrides())).filter(
    (entry): entry is readonly [AuthKey, Value] => entry[1] !== undefined,
  );
  return Object.fromEntries(
    await Promise.all(
      known.map(async ([row, value]) => [row.key, row.secret && value !== "" ? await hmacSha256Hex(env.ref, String(value)) : value] as const),
    ),
  );
}

function valid(row: AuthKey, value: unknown): boolean {
  if (row.type === "boolean") return typeof value === "boolean";
  if (row.type === "integer") return Number.isSafeInteger(value);
  if (row.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (row.type === "enum") return ENUMS[row.key].includes(value as string);
  if (typeof value !== "string" || value.includes("\0")) return false;
  if (row.key === "smtp_port") return /^\d+$/.test(value);
  return row.conv !== "template" || new TextEncoder().encode(value).byteLength <= TEMPLATE_MAX_BYTES;
}

function changes(body: Record<string, unknown>): [AuthKey, Value | null][] {
  return Object.entries(body).flatMap(([key, value]): [AuthKey, Value | null][] => {
    const row = byKey.get(key);
    if (!row) throw new HttpError(400, `Unknown auth config key: ${key}`);
    if (!row.patch || row.conv === "hosted") return [];
    if (value !== null && !valid(row, value)) throw new HttpError(400, `Invalid value for ${key}`);
    return [[row, value as Value | null]];
  });
}

async function setTemplate(next: Overrides, files: Map<string, string | null>, row: AuthKey, value: Value | null): Promise<void> {
  const type = templateType(row);
  const content = value ? String(value) : null;
  files.set(templatePath(type), content);
  next[row.env] = content === null ? "" : `${TEMPLATE_URL}${type}?v=${(await sha256Hex(content)).slice(0, 12)}`;
}

function setClientIds(next: Overrides, body: Record<string, unknown>): void {
  for (const head of AUTH_KEYS.filter((row) => row.conv === "clientids-head")) {
    const tailKey = head.key.replace(/_client_id$/, "_additional_client_ids");
    if (!(head.key in body) && !(tailKey in body)) continue;
    const [id = "", ...extra] = (effective(next, head.env) ?? "").split(",");
    const parts = [head.key in body ? body[head.key] : id, tailKey in body ? body[tailKey] : extra.join(",")];
    next[head.env] = parts.map((part) => part ?? "").join(",").split(",").map((part) => part.trim()).filter(Boolean).join(",");
  }
}

function setPool(next: Overrides, body: Record<string, unknown>): void {
  if (!("db_max_pool_size" in body)) return;
  const [target, other] = body.db_max_pool_size_unit === "percent" ? [PERCENT, POOL] : [POOL, PERCENT];
  next[target] = String(body.db_max_pool_size ?? 0);
  next[other] = "0";
  console.log("management: the auth database pool size applies after the auth service restarts");
}

async function ensureSamlKey(next: Overrides): Promise<void> {
  if (!effective(next, SAML_KEY)) next[SAML_KEY] = await generateSamlKey();
}

async function save(next: Overrides, files: Map<string, string | null>): Promise<void> {
  for (const [path, content] of files) if (content !== null) await writeFileAtomic(path, content);
  await writeFileAtomic(OVERRIDES, JSON.stringify(next));
  for (const [path, content] of files) if (content === null) await rm(path, { force: true });
}

export async function updateAuth(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const updates = changes(body);
  return withLock("gotrue", async () => {
    const next = await readOverrides();
    const files = new Map<string, string | null>();
    for (const [row, value] of updates) {
      if (row.conv === "template") await setTemplate(next, files, row, value);
      else if (row.conv === "hours" && !(typeof value === "number" && value > 0)) {
        delete next[row.env];
        console.log(`management: ${row.env} is unset once the auth service restarts`);
      } else if (!SPECIAL.has(row.conv)) next[row.env] = toEnv(row, value);
    }
    setClientIds(next, body);
    setPool(next, body);
    if (body.saml_enabled === true) await ensureSamlKey(next);
    if (updates.length > 0) await save(next, files);
    return patchResponse(await values(next));
  });
}

export async function enableSaml(): Promise<void> {
  await withLock("gotrue", async () => {
    const next = { ...(await readOverrides()), GOTRUE_SAML_ENABLED: "true" };
    await ensureSamlKey(next);
    await save(next, new Map());
  });
}
