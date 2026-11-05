import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { domainStem } from "./catalog";
import { GuideSchema, type Guide } from "./schema";

/** Reviewed guides ship in the repo. Generated ones go to a separate directory that can be a volume. */
const SEED_DIR = path.join(process.cwd(), "data", "guides");
const runtimeDir = () => path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data", "runtime"), "guides");

function readDir(directory: string): Guide[] {
  let files: string[];
  try {
    files = readdirSync(directory).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  return files.flatMap((file) => {
    const parsed = GuideSchema.safeParse(JSON.parse(readFileSync(path.join(directory, file), "utf8")));
    if (!parsed.success) console.error(`Skipping invalid guide ${file}:`, parsed.error.message);
    return parsed.success ? [parsed.data] : [];
  });
}

export function listGuides(): Guide[] {
  const guides = new Map<string, Guide>();
  for (const guide of readDir(runtimeDir())) guides.set(guide.slug, guide);
  for (const guide of readDir(SEED_DIR)) guides.set(guide.slug, guide);
  return [...guides.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const getGuide = (slug: string) => listGuides().find((guide) => guide.slug === slug) ?? null;

export function saveGuide(guide: Guide) {
  const directory = runtimeDir();
  mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `${guide.slug}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(guide, null, 2));
  renameSync(temporary, target);
}

export const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "app";

/** A live run must never overwrite an existing guide, especially a reviewed one. */
export function uniqueSlug(name: string) {
  const base = slugify(name);
  const taken = new Set(listGuides().map((guide) => guide.slug));
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix++) if (!taken.has(`${base}-${suffix}`)) return `${base}-${suffix}`;
}

/** Finds an existing guide by name, slug or website, so repeat submissions cost nothing. */
export function findGuide(query: string): Guide | null {
  const normalized = query.trim().toLowerCase();
  const stem = domainStem(normalized);
  return (
    listGuides().find((guide) => {
      if (guide.slug === slugify(normalized) || guide.name.toLowerCase() === normalized) return true;
      return stem !== null && (domainStem(guide.website) === stem || guide.slug === stem);
    }) ?? null
  );
}
