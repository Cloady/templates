import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? ".");
const slug = basename(dir);
const project = `ci-${slug}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
const host = "localhost";
const waitMs = Number(process.env.SMOKE_WAIT_SECONDS ?? 600) * 1000;
const STABLE_MS = 30_000;
const MAX_RESTARTS = 5;
const GIB = 1024 ** 3;
const started = Date.now();

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const lines = (text) => text.split("\n").filter(Boolean);
const docker = (args, env = {}) =>
  execFileSync("docker", args, { cwd: dir, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"] });
const manifest = existsSync(join(dir, "cloady.json")) ? JSON.parse(readFileSync(join(dir, "cloady.json"), "utf8")) : {};

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function generateSecret(spec) {
  const [kind, arg] = spec.split(":");
  if (kind !== "password" && kind !== "hex") return null;
  const bytes = crypto.getRandomValues(new Uint8Array(Number(arg) || (kind === "hex" ? 32 : 24)));
  return kind === "hex" ? Buffer.from(bytes).toString("hex") : Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

const b64url = (value) => Buffer.from(value).toString("base64url");
function signJwt(payload, secret) {
  const body = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

function envDefaults(schema) {
  const out = {};
  for (const [key, f] of Object.entries(schema)) {
    if (f.generate?.startsWith("jwt:")) continue;
    const secret = f.generate ? generateSecret(f.generate) : null;
    if (secret != null) out[key] = secret;
    else if (f.default !== undefined) out[key] = String(f.default).split("{host}").join(host);
  }
  for (const [key, f] of Object.entries(schema)) {
    if (!f.generate?.startsWith("jwt:")) continue;
    const [, role, secretKey] = f.generate.split(":");
    out[key] = signJwt({ role, iss: "cloady", iat: 1700000000, exp: 2015000000 }, out[secretKey] ?? "");
  }
  return out;
}

function resolveEnvValue(raw, lookup) {
  return raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-+?])?([^}]*)\}/g, (_, name, op, def) => {
    const val = lookup[name];
    if (!op) return val ?? "";
    const useful = op.startsWith(":") ? val !== undefined && val !== "" : val !== undefined;
    if (op.endsWith("-")) return useful ? val : def;
    if (op.endsWith("+")) return useful ? def : "";
    return val ?? "";
  });
}

function envFile(vars, system) {
  const lookup = { ...vars, ...system };
  for (const [k, v] of Object.entries(lookup)) if (!(k in system)) lookup[k] = resolveEnvValue(v, lookup);
  const dq = (v) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  return Object.entries(vars)
    .map(([k, v]) => [k, resolveEnvValue(v, lookup)])
    .filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !v.endsWith("\\"))
    .map(([k, v]) => `${k}="${dq(v)}"`).join("\n") + "\n";
}

function defaultProfiles(services, schema) {
  const all = [...new Set(Object.values(services).flatMap((s) => s.profiles ?? []))];
  const groups = Object.values(schema ?? {}).flatMap((f) => {
    const multiple = f.type === "array";
    const required = !multiple && !Array.isArray(f.type);
    const options = ((multiple ? f.items?.enum : f.enum) ?? []).filter((p) => all.includes(p));
    const declared = [f.default ?? []].flat().filter((p) => options.includes(p));
    return options.length ? [{ required, options, defaults: declared.length || !required ? declared : options.slice(0, 1) }] : [];
  });
  const rest = all.filter((p) => !groups.some((g) => g.options.includes(p)));
  const restRequired = rest.length > 0 && !groups.some((g) => g.required) && Object.values(services).every((s) => s.profiles?.length);
  return [...groups.flatMap((g) => g.defaults), ...(restRequired ? rest.slice(0, 1) : [])];
}

const MEM_UNITS = { b: 1 / GIB, k: 1 / 1024 ** 2, m: 1 / 1024, g: 1, t: 1024 };
const finite = (n) => (Number.isFinite(n) ? n : null);
function parseCores(v) {
  if (v == null) return null;
  if (typeof v === "number") return finite(v);
  const milli = v.trim().match(/^([\d.]+)m$/);
  return finite(milli ? parseFloat(milli[1]) / 1000 : parseFloat(v));
}
function parseGib(v) {
  if (v == null) return null;
  if (typeof v === "number") return finite(v / GIB);
  const m = v.trim().match(/^([\d.]+)\s*([bkmgt])i?b?$/i);
  return finite(m ? parseFloat(m[1]) * MEM_UNITS[m[2].toLowerCase()] : parseFloat(v) / GIB);
}
const ceilStep = (n) => Math.ceil(n / 0.001 - 1e-9) * 0.001;

function override(config) {
  const out = ["services:"];
  for (const [name, s] of Object.entries(config.services ?? {})) {
    const declared = s.deploy?.resources?.limits ?? s.deploy?.resources?.reservations;
    const sized = `{cpus: ${ceilStep(parseCores(declared?.cpus) ?? 0.5)}, memory: ${Math.max(4, Math.round(ceilStep(parseGib(declared?.memory) ?? 1) * 1024))}m}`;
    out.push(`  ${JSON.stringify(name)}:`, "    restart: always", "    depends_on: !reset []",
      `    deploy: {${s.deploy?.replicas === 0 ? "replicas: 1, " : ""}resources: {limits: ${sized}, reservations: ${sized}}}`);
    if (s.ports?.length) out.push("    ports: !override", ...s.ports.map((p) => `      - {target: ${p.target}, protocol: ${p.protocol ?? "tcp"}}`));
  }
  const volumes = Object.keys(config.volumes ?? {});
  if (volumes.length) out.push("volumes:", ...volumes.flatMap((v) => [`  ${JSON.stringify(v)}:`, "    driver_opts: !reset {}"]));
  return `${out.join("\n")}\n`;
}

const envPath = join(dir, ".env");
const envBackup = existsSync(envPath) ? `${envPath}.smoke-backup` : null;
if (envBackup) renameSync(envPath, envBackup);
writeFileSync(envPath, "");

const work = mkdtempSync(join(tmpdir(), "smoke-"));
const overridePath = join(work, "override.yml");
let env = {};
const compose = (args) => docker(["compose", "-p", project, "-f", "docker-compose.yml", "-f", overridePath, ...args], env);

function summary(line) {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

function finish(ok, message) {
  if (!ok && existsSync(overridePath)) {
    for (const args of [["ps", "-a"], ["logs", "--no-color", "--tail", "100"]]) {
      try { console.log(compose(args)); } catch (err) { console.log(String(err.stdout ?? err)); }
    }
  }
  summary(`${ok ? "PASS" : "FAIL"} ${slug} after ${Math.round((Date.now() - started) / 1000)}s: ${message}`);
  if (existsSync(overridePath)) {
    try { compose(["down", "-v", "--remove-orphans", "--rmi", "all", "--timeout", "5"]); } catch {}
  }
  rmSync(envPath, { force: true });
  if (envBackup) renameSync(envBackup, envPath);
  rmSync(work, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}

function containers() {
  const ids = lines(docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`]));
  if (ids.length === 0) return [];
  return JSON.parse(docker(["inspect", ...ids])).map((c) => ({
    service: c.Config.Labels["com.docker.compose.service"],
    status: c.State.Status,
    health: c.State.Health?.Status ?? null,
    restarts: c.RestartCount,
  }));
}

function tcpOpen(port) {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 3000 });
    socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("timeout", () => { socket.destroy(); done(false); });
    socket.once("error", () => done(false));
  });
}

async function probe({ service, target }) {
  let port;
  try { port = Number(compose(["port", service, String(target)]).trim().split(":").pop()); } catch { return { service, target, ok: false, detail: "not published" }; }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual", signal: AbortSignal.timeout(8000) });
    return { service, target, ok: res.status < 500, detail: `HTTP ${res.status}` };
  } catch {
    const open = await tcpOpen(port);
    return { service, target, ok: open, detail: open ? "TCP open" : "no answer" };
  }
}

try {
  const declared = lines(docker(["compose", "config", "--profiles", "--no-interpolate"]));
  const everything = JSON.parse(docker(["compose", "config", "--format", "json", "--no-interpolate"], { COMPOSE_PROFILES: declared.join(",") }));
  const profiles = defaultProfiles(everything.services ?? {}, manifest.profileSchema);
  const active = Object.entries(everything.services ?? {})
    .filter(([, s]) => !s.profiles?.length || s.profiles.some((p) => profiles.includes(p)))
    .map(([name]) => name);
  const system = {
    CLOADY_DOMAIN: host,
    CLOADY_PRIMARY_HOST: host,
    CLOADY_PRIMARY_URL: `https://${host}`,
    CLOADY_SVCID: slug,
    CLOADY_WORKSPACE: "ci",
    ...Object.fromEntries(active.map((name) => [`CLOADY_HOST_${name.toUpperCase().replace(/-/g, "_")}`, name])),
  };
  writeFileSync(envPath, envFile(envDefaults(manifest.envSchema ?? {}), system));
  env = { COMPOSE_PROFILES: profiles.join(","), ...system };
  const config = JSON.parse(docker(["compose", "config", "--format", "json"], env));
  writeFileSync(overridePath, override(config));
  console.log(`${slug}: ${Object.keys(config.services ?? {}).join(", ")}${profiles.length ? ` (profiles ${profiles.join(", ")})` : ""}`);

  for (let attempt = 1; ; attempt++) {
    try { compose(["pull", "--quiet", "--ignore-buildable"]); break; } catch (err) {
      if (attempt >= 3) throw err;
      await sleep(15000 * attempt);
    }
  }
  compose(["up", "-d", "--quiet-pull"]);

  const ports = Object.entries(config.services ?? {}).flatMap(([service, s]) =>
    (s.ports ?? []).filter((p) => (p.protocol ?? "tcp") === "tcp").map((p) => ({ service, target: Number(p.target) })));
  const upAt = Date.now();
  let stableSince = null;
  let loggedAt = 0;
  let last = "starting";
  while (Date.now() - upAt < waitMs) {
    const states = containers();
    const looping = states.find((c) => c.restarts >= MAX_RESTARTS);
    if (looping) finish(false, `${looping.service} restarted ${looping.restarts} times`);
    const waiting = states.filter((c) => c.status !== "running" || c.health === "starting" || c.health === "unhealthy");
    if (states.length === 0 || waiting.length) {
      stableSince = null;
      last = waiting.map((c) => `${c.service} ${c.status}${c.health ? `/${c.health}` : ""}`).join(", ") || "no containers";
    } else if (Date.now() - (stableSince ??= Date.now()) < STABLE_MS) {
      last = "running, waiting for every container to stay up";
    } else {
      const results = await Promise.all(ports.map(probe));
      const report = results.map((r) => `${r.service}:${r.target} ${r.detail}`).join(", ");
      if (results.every((r) => r.ok)) finish(true, `${states.length} containers up${report ? `; ${report}` : ""}`);
      last = report;
    }
    if (Date.now() - loggedAt > 30000) { console.log(`${Math.round((Date.now() - upAt) / 1000)}s: ${last}`); loggedAt = Date.now(); }
    await sleep(5000);
  }
  finish(false, `not ready after ${waitMs / 1000}s: ${last}`);
} catch (err) {
  console.log(String(err.stderr ?? "").trim());
  finish(false, String(err.message ?? err).split("\n")[0]);
}
