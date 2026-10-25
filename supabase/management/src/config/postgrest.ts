import { adminExec, adminQuery, quoteLiteral } from "../db.ts";
import { env } from "../env.ts";
import { HttpError, notAvailable } from "../http.ts";

export interface PostgrestConfig {
  db_schema: string;
  max_rows: number;
  db_extra_search_path: string;
  db_pool: null;
  db_pool_acquisition_timeout: null;
}

const ROLE_SETTINGS =
  "select unnest(s.setconfig) as setting from pg_db_role_setting s join pg_roles r on r.oid = s.setrole " +
  "where r.rolname = 'authenticator' and s.setdatabase in (0, (select oid from pg_database where datname = current_database())) " +
  "order by s.setdatabase";
const SCHEMA = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function unreachable(): never {
  throw new HttpError(502, "db did not answer");
}

function rejected(err: unknown): never {
  const { errno, message } = (err ?? {}) as { errno?: unknown; message?: unknown };
  if (typeof errno === "string" && !/^(08|28|53|57P)/.test(errno)) throw new HttpError(400, String(message));
  unreachable();
}

async function roleSettings(): Promise<Map<string, string>> {
  const rows = await adminQuery<{ setting: string }>(ROLE_SETTINGS).catch(unreachable);
  return new Map(
    rows.map(({ setting }): [string, string] => {
      const at = setting.indexOf("=");
      return [setting.slice(0, at), setting.slice(at + 1)];
    }),
  );
}

export async function postgrestConfig(): Promise<PostgrestConfig> {
  const role = await roleSettings();
  const pick = (setting: string, name: string, fallback: string) => role.get(setting) ?? env.vars[name] ?? fallback;
  const maxRows = Number.parseInt(pick("pgrst.db_max_rows", "PGRST_DB_MAX_ROWS", "1000"), 10);
  return {
    db_schema: pick("pgrst.db_schemas", "PGRST_DB_SCHEMAS", "public,graphql_public"),
    max_rows: Number.isSafeInteger(maxRows) ? maxRows : 1000,
    db_extra_search_path: pick("pgrst.db_extra_search_path", "PGRST_DB_EXTRA_SEARCH_PATH", "public"),
    db_pool: null,
    db_pool_acquisition_timeout: null,
  };
}

function schemas(key: string, value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, `${key} must be a string`);
  if (value === "") return "";
  const items = value.split(",").map((item) => item.trim());
  if (!items.every((item) => SCHEMA.test(item))) throw new HttpError(400, `${key} must be a comma-separated list of schema names`);
  return items.join(",");
}

function maxRows(value: unknown): string {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 1_000_000) {
    throw new HttpError(400, "max_rows must be an integer from 1 to 1000000");
  }
  return String(value);
}

export async function updatePostgrest(body: Record<string, unknown>): Promise<PostgrestConfig> {
  if ((body.db_pool ?? null) !== null || (body.db_pool_acquisition_timeout ?? null) !== null) {
    throw new HttpError(400, "db_pool and db_pool_acquisition_timeout are fixed on this stack");
  }
  if (body.db_schema === "") notAvailable("Disabling the Data API");
  const settings: [string, string][] = [];
  if (body.db_schema !== undefined) settings.push(["pgrst.db_schemas", schemas("db_schema", body.db_schema)]);
  if (body.db_extra_search_path !== undefined) {
    settings.push(["pgrst.db_extra_search_path", schemas("db_extra_search_path", body.db_extra_search_path)]);
  }
  if (body.max_rows !== undefined) settings.push(["pgrst.db_max_rows", maxRows(body.max_rows)]);
  if (settings.length > 0) {
    const statements = settings.map(([name, value]) => `ALTER ROLE authenticator SET ${name} TO ${quoteLiteral(value)};`);
    await adminExec([...statements, "NOTIFY pgrst, 'reload config';"].join("\n")).catch(rejected);
  }
  return postgrestConfig();
}
