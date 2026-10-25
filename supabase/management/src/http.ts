export class HttpError extends Error {
  constructor(public status: number, message: string, public v2Code?: string) {
    super(message);
  }
}

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  if (!h.has("content-type")) h.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function empty(status: 200 | 201 | 204): Response {
  return new Response(null, { status });
}

export function error(status: number, message: string): Response {
  return json({ message }, status);
}

export function errorV2(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

export function notAvailable(feature: string): never {
  throw new HttpError(400, `${feature} is not available on self-hosted Supabase.`, "bad_request");
}

export async function readJson<T = unknown>(req: Request, maxBytes = 1024 * 1024): Promise<T> {
  if (Number(req.headers.get("content-length")) > maxBytes) throw new HttpError(413, "Request body too large");
  const body = await req.arrayBuffer();
  if (body.byteLength > maxBytes) throw new HttpError(413, "Request body too large");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

export function omitNullish<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;
}
