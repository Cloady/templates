import { hmacSha256 } from "./ids.ts";

export interface Env {
  ref: string;
  token: string | null;
  publicUrl: string;
  publicHost: string;
  projectName: string;
  orgName: string;
  orgSlug: string;
  postgresVersion: string;
  postgresMajor: string;
  jwtSecret: string;
  postgresPassword: string;
  anonKey: string;
  serviceRoleKey: string;
  publishableKey: string;
  secretKey: string;
  anonKeyAsymmetric: string;
  serviceRoleKeyAsymmetric: string;
  sbKeyTranslation: boolean;
  dashboardUsername: string;
  adminEmail: string;
  verifyJwtDefault: boolean;
  poolerTenantId: string;
  hosts: { db: string; meta: string; rest: string; auth: string; storage: string; realtime: string; supavisor: string };
  functionsDir: string;
  authConfigDir: string;
  snippetsDir: string;
  internalBaseUrl: string;
  vars: Readonly<Record<string, string>>;
}

function fatal(message: string): never {
  console.error(`management: ${message}`);
  process.exit(1);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return fatal("PUBLIC_URL must be an absolute URL");
  }
}

async function deriveRef(jwtSecret: string): Promise<string> {
  const mac = await hmacSha256(jwtSecret, "supabase-project-ref");
  return Array.from(mac.subarray(0, 20), (b) => "abcdefghijklmnopqrstuvwxyz"[b % 26]).join("");
}

function readToken(value: string): string | null {
  const hex = value.replace(/^sbp_/, "");
  if (/^[a-f0-9]{40}$/.test(hex)) return hex;
  console.warn("management: MANAGEMENT_TOKEN is missing or malformed; the API is disabled");
  return null;
}

async function load(): Promise<Env> {
  const vars: Readonly<Record<string, string>> = Object.freeze(
    Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string")),
  );
  const get = (name: string) => vars[name] ?? "";

  const configuredRef = get("PROJECT_REF");
  if (configuredRef && !/^[a-z]{20}$/.test(configuredRef)) fatal("PROJECT_REF must be 20 lowercase letters");
  const jwtSecret = get("JWT_SECRET");
  if (!jwtSecret) fatal("JWT_SECRET is required");
  const postgresVersion = get("POSTGRES_VERSION");
  if (!postgresVersion) fatal("POSTGRES_VERSION is required");

  const publicUrl = get("PUBLIC_URL").replace(/\/+$/, "");
  const publicHost = hostOf(publicUrl);
  const orgName = get("STUDIO_DEFAULT_ORGANIZATION") || "Default Organization";
  const publishableKey = get("SUPABASE_PUBLISHABLE_KEY");
  const secretKey = get("SUPABASE_SECRET_KEY");
  const anonKeyAsymmetric = get("ANON_KEY_ASYMMETRIC");
  const serviceRoleKeyAsymmetric = get("SERVICE_ROLE_KEY_ASYMMETRIC");

  return {
    ref: configuredRef || (await deriveRef(jwtSecret)),
    token: readToken(get("MANAGEMENT_TOKEN")),
    publicUrl,
    publicHost,
    projectName: get("STUDIO_DEFAULT_PROJECT") || "Default Project",
    orgName,
    orgSlug: orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "default",
    postgresVersion,
    postgresMajor: postgresVersion.split(".")[0],
    jwtSecret,
    postgresPassword: get("POSTGRES_PASSWORD"),
    anonKey: get("ANON_KEY"),
    serviceRoleKey: get("SERVICE_ROLE_KEY"),
    publishableKey,
    secretKey,
    anonKeyAsymmetric,
    serviceRoleKeyAsymmetric,
    sbKeyTranslation: Boolean(publishableKey && secretKey && anonKeyAsymmetric && serviceRoleKeyAsymmetric),
    dashboardUsername: get("DASHBOARD_USERNAME") || "supabase",
    adminEmail: get("SMTP_ADMIN_EMAIL") || `admin@${publicHost}`,
    verifyJwtDefault: get("FUNCTIONS_VERIFY_JWT") === "true",
    poolerTenantId: get("POOLER_TENANT_ID") || "cloady",
    hosts: {
      db: get("POSTGRES_HOST") || "db",
      meta: get("META_HOST") || "meta",
      rest: get("REST_HOST") || "rest",
      auth: "auth",
      storage: "storage",
      realtime: "realtime",
      supavisor: "supavisor",
    },
    functionsDir: "/home/deno/functions",
    authConfigDir: "/etc/auth.d",
    snippetsDir: "/srv/snippets",
    internalBaseUrl: "http://management:8090",
    vars,
  };
}

export const env: Env = await load();
