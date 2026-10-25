import { env } from "../env.ts";
import { readJsonFile, withLock, writeFileAtomic } from "../fsutil.ts";
import { HttpError } from "../http.ts";
import { sha256Hex } from "../ids.ts";

interface Secret {
  value: string;
  updated_at: string;
}

interface SecretsFile {
  version: number;
  secrets: Record<string, Secret>;
}

export const SECRETS_DIR = `${env.functionsDir}/.management`;
const FILE = `${SECRETS_DIR}/secrets.json`;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

async function load(): Promise<SecretsFile> {
  try {
    return (await readJsonFile<SecretsFile>(FILE)) ?? { version: 0, secrets: {} };
  } catch {
    throw new HttpError(500, `${FILE} could not be read`);
  }
}

async function save(version: number, secrets: Map<string, Secret>): Promise<void> {
  const text = JSON.stringify({ version, secrets: Object.fromEntries(secrets) });
  if (bytes(text) > MAX_FILE_BYTES) throw new HttpError(400, "Secrets must not exceed 1 MiB in total");
  await writeFileAtomic(FILE, text, 0o600);
}

function defaults(): Record<string, string> {
  return {
    SUPABASE_URL: env.vars.PUBLIC_URL ?? "",
    SUPABASE_ANON_KEY: env.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: env.serviceRoleKey,
    SUPABASE_DB_URL: `postgresql://postgres:${env.postgresPassword}@${env.vars.POSTGRES_HOST ?? ""}:5432/postgres`,
  };
}

export async function listSecrets(): Promise<{ name: string; value: string; updated_at?: string }[]> {
  const { secrets } = await load();
  const stored = Object.entries(secrets).map(async ([name, s]) => ({ name, value: await sha256Hex(s.value), updated_at: s.updated_at }));
  const builtIn = Object.entries(defaults()).map(async ([name, value]) => ({ name, value: await sha256Hex(value) }));
  const all = await Promise.all([...stored, ...builtIn]);
  return all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function checked(item: unknown): { name: string; value: string } {
  const { name, value } = (item ?? {}) as { name?: unknown; value?: unknown };
  if (typeof name !== "string" || !NAME.test(name) || name.length > 256 || name.startsWith("SUPABASE_")) {
    throw new HttpError(400, "Secret names are up to 256 letters, digits and underscores, start with a letter or underscore, and must not start with SUPABASE_");
  }
  if (typeof value !== "string" || bytes(value) > MAX_VALUE_BYTES) {
    throw new HttpError(400, `Secret ${name} must have a string value of at most 64 KiB`);
  }
  return { name, value };
}

export async function setSecrets(body: unknown): Promise<void> {
  if (!Array.isArray(body) || body.length > 100) throw new HttpError(400, "Body must be an array of at most 100 secrets");
  const items = body.map(checked);
  if (items.length === 0) return;
  await withLock("secrets", async () => {
    const file = await load();
    const secrets = new Map(Object.entries(file.secrets));
    const updated_at = new Date().toISOString();
    for (const { name, value } of items) secrets.set(name, { value, updated_at });
    await save(file.version + 1, secrets);
  });
}

export async function deleteSecrets(body: unknown): Promise<void> {
  if (!Array.isArray(body) || !body.every((name) => typeof name === "string")) {
    throw new HttpError(400, "Body must be an array of secret names");
  }
  await withLock("secrets", async () => {
    const file = await load();
    const secrets = new Map(Object.entries(file.secrets));
    const removed = body.filter((name: string) => !name.startsWith("SUPABASE_") && secrets.delete(name));
    if (removed.length > 0) await save(file.version + 1, secrets);
  });
}
