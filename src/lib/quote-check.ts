import { safeFetch } from "./safe-fetch";

export type QuoteResult =
  | { status: "matched" }
  | { status: "not_found"; note: string }
  | { status: "unreadable"; note: string };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', ndash: "-", mdash: "-" };

/** A page's readable text, with its original case and punctuation so passages can be copied from it. */
export function toPlainText(input: string) {
  return input
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeText(input: string) {
  return toPlainText(input)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Plain-code check that a passage is really on the page, with no model involved. */
export function quoteAppears(page: string, quote: string) {
  const needle = normalizeText(quote);
  return needle.length > 0 && normalizeText(page).includes(needle);
}

/** Many docs sites publish clean markdown at <url>.md and render the HTML with JavaScript. */
export function candidates(url: string) {
  const clean = url.split("#")[0]!.replace(/\/$/, "");
  return clean.endsWith(".md") || clean.endsWith(".pdf") ? [clean] : [clean, `${clean}.md`];
}

export const MIN_QUOTE_WORDS = 4;

/** Finding "403" or "minimum" on a page proves nothing, so short quotes never count as a match. */
export const isStrongQuote = (quote: string) => normalizeText(quote).split(" ").length >= MIN_QUOTE_WORDS;

export async function checkQuote(url: string, quote: string, signal?: AbortSignal): Promise<QuoteResult> {
  if (!isStrongQuote(quote)) return { status: "unreadable", note: "The quote is too short to prove anything." };
  let readable = false;
  let lastProblem = "The page couldn't be fetched.";
  for (const candidate of candidates(url)) {
    try {
      const response = await safeFetch(candidate, { signal });
      if (response.status !== 200) {
        lastProblem = `The page returned HTTP ${response.status}.`;
        continue;
      }
      if (response.contentType.includes("pdf")) {
        lastProblem = "PDFs can't be checked automatically.";
        continue;
      }
      if (normalizeText(response.body).length < 500) {
        lastProblem = "The page has almost no text without JavaScript.";
        continue;
      }
      readable = true;
      if (quoteAppears(response.body, quote)) return { status: "matched" };
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error);
    }
  }
  return readable
    ? { status: "not_found", note: "The page loaded, but this exact passage isn't in it." }
    : { status: "unreadable", note: lastProblem };
}
