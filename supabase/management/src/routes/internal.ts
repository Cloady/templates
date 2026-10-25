import { readFile } from "node:fs/promises";
import { TEMPLATE_TYPES, templatePath } from "../config/gotrue.ts";
import { error } from "../http.ts";
import type { RouteDef } from "../router.ts";

export const routes: RouteDef[] = [
  {
    method: "GET",
    path: "/internal/auth/templates/{type}",
    public: true,
    handler: async ({ params }) => {
      const html = TEMPLATE_TYPES.includes(params.type) ? await readFile(templatePath(params.type), "utf8").catch(() => null) : null;
      if (html === null) return error(404, "Template not found");
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  },
];

export async function init(): Promise<void> {}
