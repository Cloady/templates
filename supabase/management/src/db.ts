import { SQL } from "bun";
import { env } from "./env.ts";
import { HttpError } from "./http.ts";

export const sql = new SQL({
  adapter: "postgres",
  hostname: env.hosts.db,
  port: 5432,
  database: "postgres",
  username: "supabase_admin",
  password: env.postgresPassword,
  max: 4,
  idleTimeout: 30,
  connectionTimeout: 10,
  tls: false,
});

export async function adminQuery<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
  return (await sql.unsafe(text, params ?? [])) as T[];
}

export async function adminExec(text: string): Promise<void> {
  await sql.unsafe(text).simple();
}

export async function adminTx<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  return (await sql.begin(fn)) as T;
}

export function quoteLiteral(s: string): string {
  if (s.includes("\0")) throw new HttpError(400, "Values must not contain NUL characters");
  return `'${s.replaceAll("'", "''")}'`;
}
