import { env } from "./env.ts";
import { sha256 } from "./ids.ts";

export async function authorized(req: Request): Promise<boolean> {
  const presented = /^bearer (.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!env.token || presented === undefined) return false;
  const [a, b] = await Promise.all([sha256(presented), sha256(`sbp_${env.token}`)]);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
