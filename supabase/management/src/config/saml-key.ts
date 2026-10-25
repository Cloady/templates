function length(der: Uint8Array, at: number): [size: number, start: number] {
  const first = der[at];
  if (first < 0x80) return [first, at + 1];
  if (first === 0x81) return [der[at + 1], at + 2];
  if (first === 0x82) return [(der[at + 1] << 8) | der[at + 2], at + 3];
  throw new Error("Unsupported DER length");
}

function element(der: Uint8Array, at: number, tag: number): [start: number, end: number] {
  if (der[at] !== tag) throw new Error("Unexpected DER tag");
  const [size, start] = length(der, at + 1);
  return [start, start + size];
}

function pkcs8ToPkcs1(der: Uint8Array): Uint8Array {
  const [outer] = element(der, 0, 0x30);
  const [, afterVersion] = element(der, outer, 0x02);
  const [, afterAlgorithm] = element(der, afterVersion, 0x30);
  const [start, end] = element(der, afterAlgorithm, 0x04);
  return der.subarray(start, end);
}

export async function generateSamlKey(): Promise<string> {
  const { privateKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
  return btoa(String.fromCharCode(...pkcs8ToPkcs1(pkcs8)));
}
