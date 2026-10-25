import { env } from "./env.ts";
import { HttpError } from "./http.ts";
import { hmacSha256 } from "./ids.ts";

export const urls = {
  meta: `http://${env.hosts.meta}:8080`,
  auth: `http://${env.hosts.auth}:9999`,
  rest: `http://${env.hosts.rest}:3000`,
  storage: `http://${env.hosts.storage}:5000`,
  realtime: `http://${env.hosts.realtime}:4000`,
  supavisor: `http://${env.hosts.supavisor}:4000`,
};

function serviceOf(url: string): string {
  const { origin, host } = new URL(url);
  return Object.entries(urls).find(([, base]) => base === origin)?.[0] ?? host;
}

export async function upstream(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 15000, signal, ...rest } = init;
  const deadline = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: signal ? AbortSignal.any([deadline, signal]) : deadline, timeout: false });
  } catch {
    throw new HttpError(502, `${serviceOf(url)} did not answer`);
  }
}

const base64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const segment = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

export async function signHs256(claims: Record<string, unknown>, secret: string): Promise<string> {
  const input = `${segment({ alg: "HS256", typ: "JWT" })}.${segment(claims)}`;
  return `${input}.${base64url(await hmacSha256(secret, input))}`;
}

export async function adminJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signHs256({ role: "service_role", iss: "supabase-management", iat: now, exp: now + 300 }, env.jwtSecret);
}
