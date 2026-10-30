const PG_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const SYMMETRIC_SECRET = /^v1,whsec_[A-Za-z0-9+/=]{32,88}/;
const ASYMMETRIC_SECRET = /^v1a,whpk_[A-Za-z0-9+/=]{44,}:whsk_[A-Za-z0-9+/=]{44,}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "host.docker.internal"]);
const GO_HOST = /^[A-Za-z0-9\-._~!$&'()*+,;=:[\]<>"]*$/;
const BAD_ESCAPE = /%(?![0-9A-Fa-f]{2})/;

export function hookUriProblem(uri: string, enabled: boolean, secrets: string): string | undefined {
  if (!uri) return enabled ? "is enabled without a URI" : undefined;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return `${JSON.stringify(uri)} is not a valid URI`;
  }
  if (url.href !== uri) return `write the URI as ${url.href}`;
  if (!GO_HOST.test(url.host)) return `invalid character in host name ${url.host}`;
  if ([url.username, url.password, url.pathname, url.hash].some((part) => BAD_ESCAPE.test(part))) {
    return "invalid URL escape: write a literal % as %25";
  }
  const signed = () =>
    secrets.split("|").filter(Boolean).every((s) => SYMMETRIC_SECRET.test(s) || ASYMMETRIC_SECRET.test(s))
      ? undefined
      : "invalid secret format: use v1,whsec_<base64> or v1a,whpk_<base64>:whsk_<base64>";
  switch (url.protocol) {
    case "pg-functions:": {
      const [root, schema, fn] = url.pathname.split("/");
      if (root !== "" || fn === undefined) return "URI path does not contain enough parts";
      if (!PG_NAME.test(schema)) return `invalid schema name: ${schema}`;
      return PG_NAME.test(fn) ? undefined : `invalid function name: ${fn}`;
    }
    case "http:":
      return LOOPBACK.has(url.hostname.replace(/^\[(.*)\]$/, "$1")) ? signed() : "only localhost, 127.0.0.1, and ::1 are supported with http";
    case "https:":
      return signed();
    default:
      return "only postgres hooks and HTTPS functions are supported at the moment";
  }
}
