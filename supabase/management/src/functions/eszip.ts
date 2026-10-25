import { brotliDecompressSync } from "node:zlib";
import { HttpError } from "../http.ts";

const MAX_ESZIP_BYTES = 48 * 1024 * 1024;

function startsWith(bytes: Uint8Array, magic: string): boolean {
  return bytes.length >= magic.length && String.fromCharCode(...bytes.subarray(0, magic.length)) === magic;
}

function inflate(compressed: Uint8Array): Uint8Array {
  try {
    return brotliDecompressSync(compressed, { maxOutputLength: MAX_ESZIP_BYTES });
  } catch (err) {
    if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new HttpError(413, "The bundle is larger than 48 MiB when decompressed");
    }
    throw new HttpError(400, "Body is not a valid EZBR bundle");
  }
}

export function decodeBundle(body: Uint8Array): Uint8Array {
  const eszip = startsWith(body, "EZBR") ? inflate(body.subarray(4)) : body;
  if (!startsWith(eszip, "ESZIP")) throw new HttpError(400, "Body is not an eszip bundle");
  return eszip;
}
