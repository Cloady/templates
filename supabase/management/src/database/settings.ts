import { adminExec, adminQuery, quoteLiteral } from "../db.ts";
import { HttpError } from "../http.ts";

export interface PgSetting {
  api: string;
  pg: string;
  v2: string;
  type: "int" | "bool" | "string" | "enum";
}

type Value = number | boolean | string;

interface Rule extends PgSetting {
  range?: readonly [number, number];
  values?: readonly string[];
  duration?: boolean;
}

const text = (api: string): Rule => ({ api, pg: api, v2: api.replaceAll(".", "_"), type: "string" });
const duration = (api: string): Rule => ({ ...text(api), duration: true });
const flag = (api: string): Rule => ({ ...text(api), type: "bool" });
const int = (api: string, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): Rule => ({
  ...text(api),
  type: "int",
  range: [min, max],
});

const RULES: readonly Rule[] = [
  text("effective_cache_size"),
  text("logical_decoding_work_mem"),
  int("pg_stat_statements.max", 100, 45000),
  int("pg_net.batch_size", 0, 32767),
  int("autovacuum_max_workers", 1, 262143),
  text("autovacuum_work_mem"),
  flag("cron.log_statement"),
  duration("log_autovacuum_min_duration"),
  flag("log_checkpoints"),
  flag("log_connections"),
  flag("log_disconnections"),
  flag("log_duration"),
  flag("log_lock_waits"),
  flag("log_recovery_conflict_waits"),
  flag("log_replication_commands"),
  duration("log_startup_progress_interval"),
  text("log_temp_files"),
  text("maintenance_work_mem"),
  text("track_activity_query_size"),
  int("max_connections", 1, 262143),
  int("max_locks_per_transaction", 10, 2147483640),
  int("max_logical_replication_workers", 0, 262143),
  int("max_parallel_maintenance_workers", 0, 1024),
  int("max_parallel_workers", 0, 1024),
  int("max_parallel_workers_per_gather", 0, 1024),
  int("max_replication_slots"),
  text("max_slot_wal_keep_size"),
  text("max_standby_archive_delay"),
  text("max_standby_streaming_delay"),
  int("max_sync_workers_per_subscription", 0, 262143),
  text("max_wal_size"),
  int("max_wal_senders"),
  int("max_worker_processes", 0, 262143),
  { ...text("session_replication_role"), type: "enum", values: ["origin", "replica", "local"] },
  text("shared_buffers"),
  duration("statement_timeout"),
  flag("track_commit_timestamp"),
  text("wal_keep_size"),
  duration("wal_sender_timeout"),
  text("work_mem"),
  duration("checkpoint_timeout"),
  flag("hot_standby_feedback"),
];

export const POSTGRES_SETTINGS: readonly PgSetting[] = RULES;

const TEXT = /^[0-9A-Za-z_.:\- ]{1,64}$/;
const DURATION = /^(-?[0-9]+(?:\.[0-9]+)?)(us|ms|s|min|h|d)?$/;
const UNAVAILABLE = /^(08|28|53|57P)/;

const pgArray = (names: readonly string[]) => `{${names.join(",")}}`;

export async function dbCall<T>(
  run: () => Promise<T>,
  serverError = (message: string) => new HttpError(400, message),
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const { errno, message } = (err ?? {}) as { errno?: unknown; message?: unknown };
    if (typeof errno !== "string") throw new HttpError(502, "db did not answer");
    throw UNAVAILABLE.test(errno) ? new HttpError(502, String(message)) : serverError(String(message));
  }
}

const exec = (statement: string) => dbCall(() => adminExec(statement));

function parse(rule: Rule, setting: string): Value | undefined {
  if (rule.type === "bool") return /^(on|true|yes|1)$/i.test(setting);
  if (rule.type !== "int") return setting;
  const n = Number.parseInt(setting, 10);
  return Number.isFinite(n) ? n : undefined;
}

function valid(rule: Rule, value: unknown): boolean {
  switch (rule.type) {
    case "int": {
      const [min, max] = rule.range ?? [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
      return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
    }
    case "bool":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && (rule.values ?? []).includes(value);
    case "string":
      return typeof value === "string" && TEXT.test(value) && (!rule.duration || DURATION.test(value));
  }
}

export async function readPostgresOverrides(): Promise<Record<string, Value>> {
  const rows = await dbCall(() =>
    adminQuery<{ name: string; setting: string }>(
      "select name, setting from pg_file_settings where sourcefile like '%postgresql.auto.conf' and name = any($1::text[]) order by seqno",
      [pgArray(RULES.map((r) => r.pg))],
    ),
  );
  const overrides: Record<string, Value> = {};
  for (const { name, setting } of rows) {
    const rule = RULES.find((r) => r.pg === name);
    const value = rule ? parse(rule, setting) : undefined;
    if (rule && value !== undefined) overrides[rule.api] = value;
  }
  return overrides;
}

export async function postgresMajorVersion(): Promise<number> {
  const [row] = await dbCall(() =>
    adminQuery<{ major: number }>("select current_setting('server_version_num')::int / 10000 as major"),
  );
  return Number(row.major);
}

async function warnRestart(rules: Rule[]): Promise<void> {
  if (!rules.length) return;
  const rows = await adminQuery<{ name: string }>(
    "select name from pg_settings where context = 'postmaster' and name = any($1::text[])",
    [pgArray(rules.map((r) => r.pg))],
  ).catch(() => []);
  const keys = rules.filter((r) => rows.some((row) => row.name === r.pg)).map((r) => r.api);
  if (keys.length) console.log(`management: ${keys.join(", ")} need a database restart`);
}

export async function writePostgresOverrides(body: Record<string, unknown>): Promise<Record<string, Value>> {
  const updates = Object.entries(body).flatMap(([key, value]) => {
    if (key === "restart_database") {
      if (typeof value !== "boolean") throw new HttpError(400, "Invalid value for restart_database");
      return [];
    }
    const rule = RULES.find((r) => r.api === key);
    if (!rule) throw new HttpError(400, `Unknown Postgres setting: ${key}`);
    if (!valid(rule, value)) throw new HttpError(400, `Invalid value for ${key}`);
    return [{ rule, value: value as Value }];
  });
  const current = await readPostgresOverrides();
  const resets = RULES.filter((r) => Object.hasOwn(current, r.api) && !Object.hasOwn(body, r.api));
  for (const { rule, value } of updates) {
    const setting = typeof value === "boolean" ? (value ? "on" : "off") : String(value);
    await exec(`ALTER SYSTEM SET ${rule.pg} = ${quoteLiteral(setting)}`);
  }
  for (const rule of resets) await exec(`ALTER SYSTEM RESET ${rule.pg}`);
  await exec("select pg_reload_conf()");
  await warnRestart([...updates.filter((u) => current[u.rule.api] !== u.value).map((u) => u.rule), ...resets]);
  return readPostgresOverrides();
}
