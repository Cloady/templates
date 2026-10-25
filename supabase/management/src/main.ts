import { sql } from "./db.ts";
import { env } from "./env.ts";
import { createRouter, type RouteDef } from "./router.ts";
import * as internal from "./routes/internal.ts";
import * as platform from "./routes/platform.ts";
import * as stubs from "./routes/stubs.ts";
import * as database from "./routes/database.ts";
import * as functions from "./routes/functions.ts";
import * as config from "./routes/config.ts";
import * as secrets from "./routes/secrets.ts";
import * as sso from "./routes/sso.ts";

interface RoutesModule {
  routes: RouteDef[];
  init(): Promise<void>;
}

const modules: RoutesModule[] = [internal, platform, stubs, database, functions, config, secrets, sso];

for (const m of modules) await m.init();

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: 8090,
  idleTimeout: 0,
  maxRequestBodySize: 32 * 1024 * 1024,
  fetch: createRouter(modules.flatMap((m) => m.routes)),
});

console.log(`management: ref=${env.ref}`);

async function shutdown(): Promise<void> {
  server.stop();
  await sql.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
