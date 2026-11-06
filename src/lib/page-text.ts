import { candidates, MIN_QUOTE_WORDS, toPlainText } from "./quote-check";
import { safeFetch } from "./safe-fetch";

const MIN_READABLE_CHARS = 500;
const WINDOW_CHARS = 600;
const WINDOW_SEPARATOR = " [...] ";
const MAX_PASSAGE_CHARS = 300;

export type PageResult = { text: string } | { problem: string };

/** Reads a page as plain text. URLs may come from the model or from web pages, so this goes through safeFetch. */
export async function readPage(url: string, signal?: AbortSignal): Promise<PageResult> {
  let problem = "The page couldn't be fetched.";
  for (const candidate of candidates(url)) {
    try {
      const response = await safeFetch(candidate, { signal });
      if (response.status !== 200) {
        problem = `The page returned HTTP ${response.status}.`;
      } else if (response.contentType.includes("pdf")) {
        problem = "PDFs can't be read here.";
      } else {
        // Menus are full of keywords like "Callback URLs", and they'd crowd out the real content in excerpts.
        const text = toPlainText(response.body.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " "));
        if (text.length >= MIN_READABLE_CHARS) return { text };
        problem = "The page has almost no text without JavaScript.";
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      problem = error instanceof Error ? error.message : String(error);
    }
  }
  return { problem };
}

/** Splits an excerpt into short word-for-word passages, each long enough to prove something. */
export function toPassages(text: string): string[] {
  const passages: string[] = [];
  for (const window of text.split(WINDOW_SEPARATOR)) {
    for (const sentence of window.split(/(?<=[.!?:])\s+/)) {
      let rest = sentence.trim();
      while (rest.length > MAX_PASSAGE_CHARS) {
        const cut = rest.lastIndexOf(" ", MAX_PASSAGE_CHARS);
        const end = cut > 0 ? cut : MAX_PASSAGE_CHARS;
        passages.push(rest.slice(0, end));
        rest = rest.slice(end).trim();
      }
      if (rest) passages.push(rest);
    }
  }
  return passages.filter((passage) => passage.split(/\s+/).length >= MIN_QUOTE_WORDS);
}

const keywordsOf = (topic: string) => [...new Set(topic.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])];

function scoredWindows(text: string, topic: string) {
  const keywords = keywordsOf(topic);
  const windows: { start: number; score: number }[] = [];
  for (let start = 0; start < text.length; start += WINDOW_CHARS) {
    const lower = text.slice(start, start + WINDOW_CHARS).toLowerCase();
    const score = keywords.filter((keyword) => lower.includes(keyword)).length;
    if (score > 0) windows.push({ start, score });
  }
  return windows;
}

/** Finds the text most related to a claim across every page read, so a fact can be confirmed wherever it appears. */
export function excerptAcross(pages: { url: string; text: string }[], topic: string, maxChars: number) {
  const count = Math.max(1, Math.floor(maxChars / WINDOW_CHARS));
  return pages
    .flatMap(({ url, text }) => scoredWindows(text, topic).map(({ start, score }) => ({ url, score, text: text.slice(start, start + WINDOW_CHARS) })))
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map(({ url, text }) => ({ url, text }));
}

/**
 * Keeps the parts of a page most related to a topic, because whole pages won't fit the model's
 * tokens-per-minute limit. Passages stay word for word, and windows stay in page order.
 */
export function excerpt(text: string, topic: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  const count = Math.max(1, Math.floor(maxChars / WINDOW_CHARS));
  const best = scoredWindows(text, topic)
    .sort((a, b) => b.score - a.score || a.start - b.start)
    .slice(0, count)
    .sort((a, b) => a.start - b.start);
  if (best.length === 0) return text.slice(0, maxChars);
  return best.map(({ start }) => text.slice(start, start + WINDOW_CHARS)).join(WINDOW_SEPARATOR);
}
