import { execFileSync } from "node:child_process";

const [base, head] = process.argv.slice(2);
if (!base || !head || /^0+$/.test(base)) process.exit(0);

const diff = execFileSync("git", ["diff", "-U0", base, head, "--", "*/docker-compose.yml"], { encoding: "utf8" });
const templates = new Map();
let dir = null;
for (const line of diff.split("\n")) {
  if (line.startsWith("+++ ")) {
    dir = /^\+\+\+ b\/(.+)\/docker-compose\.yml$/.exec(line)?.[1] ?? null;
    if (dir) templates.set(dir, { from: new Map(), to: new Map() });
    continue;
  }
  const image = /^([-+])\s*image:\s*["']?([^"'\s#]+)/.exec(line);
  if (!dir || !image) continue;
  const ref = image[2].split("@")[0];
  const colon = ref.lastIndexOf(":");
  if (colon <= ref.lastIndexOf("/")) continue;
  templates.get(dir)[image[1] === "-" ? "from" : "to"].set(ref.slice(0, colon), ref.slice(colon + 1));
}

for (const [template, { from, to }] of templates) {
  for (const [repo, tag] of from) {
    const next = to.get(repo);
    if (next && next !== tag) {
      execFileSync("node", [".github/scripts/bump-template-version.mjs", template, tag, next], { stdio: "inherit" });
    }
  }
}
