import catalog from "../../data/composio-catalog.json";

export type CatalogStatus = "managed" | "byo" | "not_listed";
export type CatalogEntry = { name: string; slug: string; status: "managed" | "byo" };

export const CATALOG = catalog as { source: string; fetchedAt: string; entries: CatalogEntry[] };

const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The bare name in a domain, such as "acme" from https://www.acme.io/pricing. */
export function domainStem(query: string) {
  const match = query.trim().match(/^(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+)\.[a-z.]{2,}(?:[/?#].*)?$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

export function findInCatalog(query: string): CatalogEntry | null {
  const key = squash(domainStem(query) ?? query);
  if (!key) return null;
  return CATALOG.entries.find((entry) => squash(entry.slug) === key || squash(entry.name) === key) ?? null;
}

export function catalogStatus(name: string): CatalogStatus {
  return findInCatalog(name)?.status ?? "not_listed";
}

export const catalogCounts = {
  total: CATALOG.entries.length,
  managed: CATALOG.entries.filter((entry) => entry.status === "managed").length,
  byo: CATALOG.entries.filter((entry) => entry.status === "byo").length,
};
