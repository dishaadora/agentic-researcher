/**
 * Runs in the search bar, before anything reaches our server, so a misspelled or made-up name
 * doesn't start a paid investigation. It checks the format, then the names we already know, then
 * whether the app can be found on the public web. The server still validates the format on its own.
 */

export type AppCheck =
  | { ok: true; query: string }
  | { ok: false; reason: "format"; message: string }
  /** A likely typo. `canSearchAnyway` means the typed name also checked out as real. */
  | { ok: false; reason: "spelling"; message: string; suggestion: string; canSearchAnyway: boolean }
  | { ok: false; reason: "not_found"; message: string; suggestion: string | null };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export type CheckOptions = {
  /** Skips the typo check for a name the user chose to search anyway. */
  skipSpelling?: boolean;
  fetch?: Fetch;
  signal?: AbortSignal;
};

const CHECK_TIMEOUT_MS = 5_000;
/** Bare names are looked up under these, since most apps live on one of them. */
const COMMON_TLDS = ["com", "io", "app", "ai", "co", "dev"];

export const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

const DOMAIN = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:[/?#].*)?$/i;

/** The host in a domain or URL, such as "www.acme.io" from https://www.acme.io/pricing. */
export function hostOf(query: string) {
  return query.trim().match(DOMAIN)?.[1]?.toLowerCase() ?? null;
}

/** The bare name in a host, such as "acme" from www.acme.io. */
const stemOf = (host: string) => host.replace(/^www\./, "").split(".")[0] ?? host;

/** The same rules the server applies, so a bad entry is caught without a request. */
export function formatProblem(query: string): string | null {
  const value = query.trim();
  if (value.length < 2) return "Enter an app name or website.";
  if (value.length > 200) return "That's too long. Enter just the app name or website.";
  if (!/^[^<>\p{Cc}]+$/u.test(value) || !/[\p{L}\p{N}]/u.test(value)) return "Enter just the app name or website.";
  return null;
}

/** Edit distance that counts a swap of two neighbouring letters as one typo, as in "Notoin". */
export function editDistance(a: string, b: string) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = best;
    }
  }
  return rows[a.length]![b.length]!;
}

/** Longer names can take more typos before they stop looking like the same word. */
const typoAllowance = (length: number) => (length <= 5 ? 1 : length <= 10 ? 2 : 3);

export function exactKnown(query: string, known: string[]) {
  const host = hostOf(query);
  const key = squash(host ? stemOf(host) : query);
  return key ? (known.find((name) => squash(name) === key) ?? null) : null;
}

/** The known name a query most likely misspells, if any is close enough. */
export function closestKnown(query: string, known: string[]) {
  const host = hostOf(query);
  const key = squash(host ? stemOf(host) : query);
  if (key.length < 3) return null;
  let best: { name: string; distance: number } | null = null;
  for (const name of known) {
    const distance = editDistance(key, squash(name));
    if (distance > 0 && distance <= typoAllowance(key.length) && (!best || distance < best.distance)) best = { name, distance };
  }
  return best?.name ?? null;
}

/** True when the name is registered in DNS, false when it isn't, null when the lookup failed. */
async function domainExists(host: string, fetcher: Fetch, signal: AbortSignal): Promise<boolean | null> {
  try {
    const response = await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, {
      headers: { accept: "application/dns-json" },
      signal,
    });
    if (!response.ok) return null;
    const { Status } = (await response.json()) as { Status?: number };
    // 0 means the name exists, 3 means no such domain.
    return Status === 0 ? true : Status === 3 ? false : null;
  } catch {
    return null;
  }
}

/** Whether Wikipedia has a page by this name, and its spelling suggestion if it has one. */
async function lookUpName(name: string, fetcher: Fetch, signal: AbortSignal) {
  try {
    const params = new URLSearchParams({ action: "query", list: "search", srsearch: name, srinfo: "suggestion", srlimit: "5", format: "json", origin: "*" });
    const response = await fetcher(`https://en.wikipedia.org/w/api.php?${params}`, { signal });
    if (!response.ok) return null;
    const { query } = (await response.json()) as { query?: { searchinfo?: { suggestion?: string }; search?: { title: string }[] } };
    const key = squash(name);
    const titleMatch = (query?.search ?? []).some(({ title }) => squash(title).startsWith(key));
    const raw = query?.searchinfo?.suggestion;
    const suggestion = raw && squash(raw) !== key ? raw.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase()) : null;
    return { titleMatch, suggestion };
  } catch {
    return null;
  }
}

export async function checkApp(input: string, known: string[], options: CheckOptions = {}): Promise<AppCheck> {
  const query = input.trim();
  const problem = formatProblem(query);
  if (problem) return { ok: false, reason: "format", message: problem };

  const match = exactKnown(query, known);
  if (match) return { ok: true, query: hostOf(query) ? query : match };

  const close = options.skipSpelling ? null : closestKnown(query, known);
  if (close) {
    return { ok: false, reason: "spelling", message: `Did you mean ${close}?`, suggestion: close, canSearchAnyway: true };
  }

  const fetcher = options.fetch ?? fetch;
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)]) : AbortSignal.timeout(CHECK_TIMEOUT_MS);

  const host = hostOf(query);
  if (host) {
    const exists = await domainExists(host, fetcher, signal);
    if (exists === false) {
      return { ok: false, reason: "not_found", message: `${host} doesn't exist. Check the spelling of the website.`, suggestion: closestKnown(query, known) };
    }
    // A lookup that failed shouldn't block a real site, so only a confirmed miss stops the search.
    return { ok: true, query };
  }

  const name = squash(query);
  const [lookup, ...domains] = await Promise.all([
    lookUpName(query, fetcher, signal),
    ...COMMON_TLDS.map((tld) => domainExists(`${name}.${tld}`, fetcher, signal)),
  ]);
  const onWeb = domains.some((found) => found === true);
  const exists = onWeb || Boolean(lookup?.titleMatch);

  if (lookup?.suggestion && !lookup.titleMatch && !options.skipSpelling) {
    if (exists) return { ok: false, reason: "spelling", message: `Did you mean ${lookup.suggestion}?`, suggestion: lookup.suggestion, canSearchAnyway: true };
    return { ok: false, reason: "not_found", message: `We couldn't find an app called "${query}". Did you mean ${lookup.suggestion}?`, suggestion: lookup.suggestion };
  }
  if (exists) return { ok: true, query };

  const couldNotCheck = lookup === null && domains.every((found) => found === null);
  if (couldNotCheck) return { ok: true, query };
  return { ok: false, reason: "not_found", message: `We couldn't find an app called "${query}". Check the spelling, or enter its website instead.`, suggestion: null };
}
