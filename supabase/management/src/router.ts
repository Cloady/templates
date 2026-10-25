import { authorized } from "./auth.ts";
import { env } from "./env.ts";
import { error, errorV2, HttpError, json } from "./http.ts";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export interface Ctx {
  req: Request;
  url: URL;
  params: Record<string, string>;
}
export type Handler = (ctx: Ctx) => Response | Promise<Response>;
export interface RouteDef {
  method: Method;
  path: string;
  handler: Handler;
  public?: boolean;
}

interface Route extends RouteDef {
  pattern: string[];
  scoped: boolean;
}

const CODES: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  413: "request_too_large",
};

function fail(v2: boolean, status: number, message: string, code?: string): Response {
  return v2 ? errorV2(status, code ?? CODES[status] ?? "internal_server_error", message) : error(status, message);
}

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function match(pattern: string[], segments: string[]): Record<string, string> | null {
  if (pattern.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const part = pattern[i];
    if (!part.startsWith("{") || !part.endsWith("}")) {
      if (part !== segments[i]) return null;
      continue;
    }
    const value = segments[i] ? decode(segments[i]) : null;
    if (value === null) return null;
    params[part.slice(1, -1)] = value;
  }
  return params;
}

async function dispatch(routes: Route[], req: Request, url: URL, v2: boolean): Promise<Response> {
  if (req.method === "GET" && url.pathname === "/health") return json({ status: "ok" });
  const guarded = v2 || url.pathname.startsWith("/v1/");
  if (guarded && !(await authorized(req))) return fail(v2, 401, "Unauthorized");
  const segments = url.pathname.split("/");
  let pathExists = false;
  for (const route of routes) {
    const params = match(route.pattern, segments);
    if (!params) continue;
    pathExists = true;
    if (route.method !== req.method) continue;
    if (!guarded && !route.public && !(await authorized(req))) return fail(v2, 401, "Unauthorized");
    if (route.scoped && params.ref !== env.ref) return fail(v2, 404, "Project not found", "project_not_found");
    return await route.handler({ req, url, params });
  }
  return pathExists ? fail(v2, 405, "Method not allowed", "method_not_allowed") : fail(v2, 404, "Not found");
}

function failure(v2: boolean, err: unknown): Response {
  if (err instanceof HttpError) return fail(v2, err.status, err.message, err.v2Code);
  console.error(err instanceof Error ? err.stack : String(err));
  return fail(v2, 500, "Internal error");
}

export function createRouter(routes: RouteDef[]): (req: Request) => Promise<Response> {
  const table: Route[] = routes.map((r) => {
    const pattern = r.path.split("/");
    return { ...r, pattern, scoped: pattern.includes("{ref}") };
  });
  return async (req) => {
    const started = performance.now();
    const url = new URL(req.url);
    const v2 = url.pathname.startsWith("/v2/");
    const res = await dispatch(table, req, url, v2).catch((err: unknown) => failure(v2, err));
    if (url.pathname !== "/health") console.log(`${req.method} ${url.pathname} ${res.status} ${Math.round(performance.now() - started)}ms`);
    return res;
  };
}
