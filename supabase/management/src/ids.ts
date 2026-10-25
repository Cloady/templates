const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const bytes = (data: string | Uint8Array): BufferSource =>
  typeof data === "string" ? new TextEncoder().encode(data) : (data as Uint8Array<ArrayBuffer>);

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(data)));
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  return hex(await sha256(data));
}

export async function hmacSha256(key: string | Uint8Array, msg: string | Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", bytes(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, bytes(msg)));
}

export async function hmacSha256Hex(key: string, msg: string): Promise<string> {
  return hex(await hmacSha256(key, msg));
}

export function uuidFromBytes(b16: Uint8Array): string {
  const b = b16.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function stableUuid(name: string): Promise<string> {
  return uuidFromBytes(await sha256(name));
}

export function randomAlnum(n: number): string {
  let out = "";
  while (out.length < n) {
    for (const b of crypto.getRandomValues(new Uint8Array(n - out.length))) {
      if (b < 248) out += ALNUM[b % 62];
    }
  }
  return out;
}

export function nowMs(): number {
  return Date.now();
}
