import { posix } from "node:path";
import { HttpError } from "../http.ts";

const SLUG = /^[A-Za-z][A-Za-z0-9_-]*$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const DENO_CONFIG = new Set(["deno.json", "deno.jsonc"]);

export interface SourceLayout {
  up: number;
  workdir: string;
  targets: string[];
}

export function isSlug(value: string): boolean {
  return value.length <= 128 && SLUG.test(value) && value.toLowerCase() !== "main";
}

export function slugOf(value: string | null | undefined): string {
  if (!value || !isSlug(value)) throw new HttpError(400, "Invalid function slug");
  return value;
}

export function hasControlChars(name: string): boolean {
  return CONTROL.test(name);
}

function upLevels(name: string): number {
  const invalid = !name || CONTROL.test(name) || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:\//.test(name);
  const segments = invalid ? [] : posix.normalize(name).split("/");
  const up = segments.findIndex((s) => s !== "..");
  if (up < 0 || segments.slice(up).some((s) => s === ".." || s === "." || s === "")) {
    throw new HttpError(400, `Invalid file path: ${name}`);
  }
  return up;
}

function ancestors(target: string): string[] {
  const out: string[] = [];
  for (let dir = posix.dirname(target); dir !== "."; dir = posix.dirname(dir)) out.push(dir);
  return out;
}

export function workdirOf(up: number): string {
  return `src${"/_".repeat(up)}`;
}

export function sourceLayout(names: string[], references: string[]): SourceLayout {
  const up = Math.max(0, ...[...names, ...references].map(upLevels));
  const workdir = workdirOf(up);
  const targets = names.map((name) => posix.join(workdir, name));
  const unique = new Set(targets);
  if (unique.size !== targets.length || targets.some((t) => ancestors(t).some((a) => unique.has(a)))) {
    throw new HttpError(400, "Conflicting file paths");
  }
  return { up, workdir, targets };
}

export function usesDenoConfig(importMapPath: string): boolean {
  return DENO_CONFIG.has(posix.basename(importMapPath));
}
