import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, from, to] = process.argv.slice(2);
const file = join(dir ?? "", "cloady.json");
if (!dir || !from || !to || !existsSync(file)) process.exit(0);

const forms = [
  (tag) => tag,
  (tag) => tag.replace(/^v(?=\d)/, ""),
  (tag) => tag.split("-")[0],
  (tag) => tag.replace(/^v(?=\d)/, "").split("-")[0],
];

const text = readFileSync(file, "utf8");
const manifest = JSON.parse(text);
const form = forms.find((f) => f(from) === manifest.version);
if (!form) process.exit(0);

const version = form(to);
if (version === manifest.version) process.exit(0);

const edited = text.replace(/("version"\s*:\s*)"[^"]*"/, (_, key) => `${key}${JSON.stringify(version)}`);
const check = JSON.parse(edited);
const same = JSON.stringify({ ...check, version: manifest.version }) === JSON.stringify(manifest);
writeFileSync(file, check.version === version && same ? edited : `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
console.log(`${dir}: version ${manifest.version} -> ${version}`);
