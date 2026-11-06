import { setMaxListeners } from "node:events";
import Groq from "groq-sdk";
import type { ChatCompletion, ChatCompletionMessageParam, ChatCompletionTool } from "groq-sdk/resources/chat/completions";
import { z } from "zod";
import { findInCatalog } from "../catalog";
import { applyChecks, checkClaimQuotes, demoteModelTested, explainHandoffs, normalizeClaims, probeClaims, reconcileWaits, requireApprovalEvidence, resolvePassages, type CheckResult, type Passage } from "../evidence";
import { excerpt, excerptAcross, readPage, toPassages, type PageResult } from "../page-text";
import { probeUrl } from "../probe";
import { probeTargets } from "../probe-targets";
import { GuideDraftSchema, isWebUrl, type Guide, type GuideDraft, type Probe } from "../schema";
import { uniqueSlug } from "../store";
import { DRAFT_SYSTEM, RESEARCH_SYSTEM, VERIFY_SYSTEM } from "./prompts";

/** Browser search only runs on Groq's gpt-oss models, so an override needs to be one of those. */
export const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const MAX_RESEARCH_TURNS = 8;
const MAX_PROBES = 10;
const MAX_PAGE_READS = 5;
const MIN_PAGE_READS = 3;
const MAX_PAGE_ATTEMPTS = 10;
/** A search used between 3K and 16K tokens in testing, because Groq's browser opens pages as it searches. */
const MAX_SEARCHES = 2;
const MAX_SEARCH_RESULTS = 8;
const SEARCH_ATTEMPTS = 3;
const SEARCH_OUTPUT_TOKENS = 600;
const MAX_INVALID_REPLIES = 4;
const MAX_DRAFT_ATTEMPTS = 3;
const MAX_MODEL_CHECKS = 15;
const CHARS_PER_TOKEN = 4;

/**
 * A single request can't exceed the account's tokens-per-minute limit, so everything is sized from
 * it. Raise GROQ_TOKENS_PER_MINUTE to match a higher plan and research can read more of each page.
 */
const tokensPerMinute = () => Number(process.env.GROQ_TOKENS_PER_MINUTE) || 8_000;
const budgets = () => {
  const tokens = tokensPerMinute();
  return {
    researchPromptTokens: Math.floor(tokens * 0.6),
    researchOutputTokens: Math.floor(tokens * 0.25),
    pageChars: Math.floor(tokens * 0.1) * CHARS_PER_TOKEN,
    notesChars: Math.floor(tokens * 0.2) * CHARS_PER_TOKEN,
    draftOutputTokens: Math.floor(tokens * 0.5),
    claimExcerptChars: Math.floor(tokens * 0.05) * CHARS_PER_TOKEN,
    verifyPromptChars: Math.floor(tokens * 0.4) * CHARS_PER_TOKEN,
    verifyOutputTokens: Math.floor(tokens * 0.15),
  };
};

export type Stage = "identify" | "research" | "draft" | "verify" | "publish";
export type ProgressEvent = { stage: Stage; message: string };
type Emit = (event: ProgressEvent) => void;
type Context = { client: Groq; emit: Emit; signal: AbortSignal };

/** Waits and retries on 429s, which are routine at these limits. */
export const createClient = () => new Groq({ maxRetries: 5 });

/**
 * Groq's browser search isn't offered in the research loop. Given it directly, the model reads pages
 * inside Groq and cites opaque markers, so its notes have no URLs or checkable passages. Here it only
 * finds links, and fetch_page is the only way to read a page.
 */
const RESEARCH_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Searches the web and returns the titles and URLs of matching pages. Read the useful ones with fetch_page.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "What to search for" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_page",
      description: "Reads one public page and returns the parts most related to what you're looking for, word for word.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute https URL" },
          looking_for: { type: "string", description: "The facts you want from this page, such as 'app review requirements and approval time'" },
        },
        required: ["url", "looking_for"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "probe_url",
      description:
        "Sends one read-only GET to a public URL and reports what came back, such as OAuth discovery metadata or a redirect to sign-in. It never signs in or submits anything. Results are the only thing that can back a 'tested' claim.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Absolute https URL" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
];

const baseRequest = { model: MODEL, include_reasoning: false, reasoning_effort: "low" as const, stream: false as const };

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const responseFormat = (name: string, schema: z.ZodType) => {
  const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
  return { type: "json_schema" as const, json_schema: { name, strict: true, schema: jsonSchema } };
};

/** Groq rejects a reply it can't validate as a 400, which is worth one more attempt rather than a failed run. */
const isInvalidModelOutput = (error: unknown) => error instanceof Groq.BadRequestError && /tool_use_failed|json_validate_failed|output_parse_failed/.test(error.message);

const estimateTokens = (messages: ChatCompletionMessageParam[]) =>
  Math.ceil(JSON.stringify(messages).length / CHARS_PER_TOKEN);

/** Every turn resends the conversation, so the oldest search output and tool results go first once it nears the limit. */
function compact(messages: ChatCompletionMessageParam[], limit: number) {
  for (const [index, message] of messages.entries()) {
    if (estimateTokens(messages) <= limit) return;
    if (index >= messages.length - 1) return;
    if (message.role === "tool") message.content = "[Removed to stay within the token limit.]";
    if (message.role === "assistant") message.content = "";
  }
}

const cleanNotes = (text: string, maxChars: number) =>
  text.replace(/【[^】]*】/g, "").trim().slice(-maxChars);

/** Links come from Groq's search results rather than the model's reply, so they're real pages. */
async function searchWeb(query: string, { client, signal }: Pick<Context, "client" | "signal">) {
  for (let attempt = 0; attempt < SEARCH_ATTEMPTS; attempt++) {
    try {
      const completion = await client.chat.completions.create(
        {
          ...baseRequest,
          max_completion_tokens: SEARCH_OUTPUT_TOKENS,
          tools: [{ type: "browser_search" }],
          tool_choice: "required",
          messages: [{ role: "user", content: `Search the web for this, then reply only with "done":\n<query>${query}</query>` }],
        },
        { signal },
      );
      const results = (completion.choices[0]?.message.executed_tools ?? []).flatMap((tool) => tool.search_results?.results ?? []);
      const pages = new Map<string, string>();
      for (const { url, title } of results) if (url && isWebUrl(url) && !pages.has(url)) pages.set(url, title ?? "");
      if (pages.size > 0) return [...pages].slice(0, MAX_SEARCH_RESULTS).map(([url, title]) => ({ url, title }));
    } catch (error) {
      if (!isInvalidModelOutput(error)) throw error;
    }
  }
  return [];
}

async function research(query: string, statusNote: string, { client, emit, signal }: Context) {
  const budget = budgets();
  const probes: Probe[] = [];
  const passages = new Map<string, Passage>();
  const pages: { url: string; text: string }[] = [];
  const finished = (notes: string) => ({ notes, probes, passages, pages });
  let pageAttempts = 0;
  let searches = 0;
  let invalidReplies = 0;
  let finishNow = false;
  let askedToReadMore = false;
  const messages: ChatCompletionMessageParam[] = [
    {
      role: "user",
      content: `Investigate this app. The submitted name or website is:\n<submitted_app>${query}</submitted_app>\n\n${statusNote}`,
    },
  ];

  const runTool = async (name: string | undefined, args: Record<string, unknown> | null): Promise<string> => {
    if (name === "search_web") {
      if (typeof args?.query !== "string") return "Error: expected a query string.";
      if (searches >= MAX_SEARCHES) return "Error: search limit reached. Read the pages you've found, or finish with what you have.";
      searches += 1;
      emit({ stage: "research", message: `Searching: ${args.query}` });
      const pages = await searchWeb(args.query, { client, signal });
      return pages.length > 0 ? JSON.stringify(pages) : "No results. Try fetch_page on the provider's developer docs.";
    }
    const url = args?.url;
    if (typeof url !== "string") return "Error: expected a url string.";
    if (name === "probe_url") {
      if (probes.length >= MAX_PROBES) return "Error: probe limit reached. Finish with what you have.";
      emit({ stage: "research", message: `Testing ${url}` });
      const probe = await probeUrl(url, `p${probes.length + 1}`, signal);
      probes.push(probe);
      emit({ stage: "research", message: `Result: ${probe.observation}` });
      return JSON.stringify(probe);
    }
    if (name === "fetch_page") {
      // A page that can't be read doesn't use up a read, but the attempts are still capped.
      if (pages.length >= MAX_PAGE_READS || pageAttempts >= MAX_PAGE_ATTEMPTS) return "Error: page limit reached. Finish with what you have.";
      pageAttempts += 1;
      emit({ stage: "research", message: `Reading ${url}` });
      const page = await readPage(url, signal);
      if ("problem" in page) return `Couldn't read this page: ${page.problem}`;
      // Reading the same page again for another topic is fine, and doesn't count as another page.
      if (!pages.some((known) => known.url === url)) pages.push({ url, text: page.text });
      const lines = toPassages(excerpt(page.text, typeof args?.looking_for === "string" ? args.looking_for : query, budget.pageChars)).map((quote) => {
        const id = `P${passages.size + 1}`;
        passages.set(id, { url, quote });
        return `[${id}] ${quote}`;
      });
      return `URL: ${url}\n${lines.join("\n")}`;
    }
    return `Error: unknown tool ${name}.`;
  };

  for (let turn = 0; turn < MAX_RESEARCH_TURNS; turn++) {
    const lastTurn = finishNow || turn === MAX_RESEARCH_TURNS - 1;
    compact(messages, budget.researchPromptTokens);

    let completion: ChatCompletion;
    try {
      completion = await client.chat.completions.create(
        {
          ...baseRequest,
          max_completion_tokens: budget.researchOutputTokens,
          messages: [{ role: "system", content: RESEARCH_SYSTEM }, ...messages],
          tools: RESEARCH_TOOLS,
          tool_choice: lastTurn ? "none" : "auto",
        },
        { signal },
      );
    } catch (error) {
      if (!isInvalidModelOutput(error)) throw error;
      // These fail quickly and do no work, so a few don't use up a research turn.
      if (++invalidReplies <= MAX_INVALID_REPLIES) turn--;
      continue;
    }

    const choice = completion.choices[0];
    if (!choice) throw new Error("The research step returned nothing.");
    const { message } = choice;
    const toolCalls = message.tool_calls ?? [];

    if (choice.finish_reason === "length") {
      // Keep what came back and wrap up, rather than losing the research.
      if (lastTurn) {
        const partial = cleanNotes(message.content ?? "", budget.notesChars);
        if (partial) return finished(partial);
        throw new Error("The research step ran out of output space.");
      }
      finishNow = true;
      messages.push({ role: "assistant", content: cleanNotes(message.content ?? "", budget.notesChars) });
      messages.push({ role: "user", content: "That reply was cut off. Don't use any more tools. Write your final notes now, under 500 words." });
      continue;
    }

    // The model tends to stop after a page or two and fill the gaps from memory.
    if (toolCalls.length === 0 && !lastTurn && !askedToReadMore && pages.length > 0 && pages.length < MIN_PAGE_READS) {
      askedToReadMore = true;
      messages.push({ role: "assistant", content: cleanNotes(message.content ?? "", budget.notesChars) });
      messages.push({
        role: "user",
        content: `You've read only ${pages.length} ${pages.length === 1 ? "page" : "pages"}. Before finishing, use fetch_page to find what's still missing: token lifetimes and refresh rules, redirect URI rules, the review or approval process, limits, and the terms or policy page. Then write your final notes, citing a passage id for every fact.`,
      });
      continue;
    }

    if (toolCalls.length === 0 || lastTurn) {
      const notes = cleanNotes(message.content ?? "", budget.notesChars);
      if (!notes) throw new Error("The research step returned no notes.");
      return finished(notes);
    }

    messages.push({ role: "assistant", content: message.content ?? "", tool_calls: toolCalls });
    for (const call of toolCalls) {
      const args = safeJson(call.function.arguments) as Record<string, unknown> | null;
      messages.push({ role: "tool", tool_call_id: call.id, content: await runTool(call.function.name, args) });
    }
  }
  throw new Error("Research didn't finish within its turn limit.");
}

async function draft(query: string, notes: string, probes: Probe[], { client, signal }: Context): Promise<GuideDraft> {
  const response_format = responseFormat("oauth_guide", GuideDraftSchema);
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: DRAFT_SYSTEM },
    {
      role: "user",
      content: `Write the guide for: <submitted_app>${query}</submitted_app>\n\n<research_notes>\n${notes}\n</research_notes>\n\n<probes>\n${JSON.stringify(probes.map(({ id, url, status, observation }) => ({ id, url, status, observation })))}\n</probes>`,
    },
  ];
  let lastProblem: unknown;
  for (let attempt = 0; attempt < MAX_DRAFT_ATTEMPTS; attempt++) {
    let completion: ChatCompletion;
    try {
      completion = await client.chat.completions.create(
        { ...baseRequest, max_completion_tokens: budgets().draftOutputTokens, response_format, messages },
        { signal },
      );
    } catch (error) {
      if (!isInvalidModelOutput(error)) throw error;
      lastProblem = error;
      continue;
    }
    const choice = completion.choices[0];
    if (choice?.finish_reason === "length") throw new Error("The drafting step ran out of output space.");
    const result = GuideDraftSchema.safeParse(safeJson(choice?.message.content ?? ""));
    if (result.success) return result.data;
    lastProblem = result.error;
    // The failed draft isn't resent, because the request would no longer fit the per-minute limit.
    if (attempt === 0) {
      messages.push({ role: "user", content: `A previous attempt failed validation:\n${z.prettifyError(result.error).slice(0, 1_000)}\nReturn the whole guide, corrected.` });
    }
  }
  throw new Error("The draft didn't match the guide format after a retry.", { cause: lastProblem });
}

const VerdictSchema = z.strictObject({
  verdicts: z.array(
    z.strictObject({
      id: z.string(),
      verdict: z.enum(["supported", "contradicted", "cannot_tell"]),
      evidence_id: z.string().nullable().describe("For a supported verdict, the id of the evidence that most directly states the claim"),
      note: z.string().describe("One short sentence explaining the verdict"),
    }),
  ),
});

type DraftClaim = GuideDraft["claims"][number];
type CheckItem = { id: string; text: string; evidence: { id: string; text: string }[] };

/** A second opinion on whether the text really supports each claim. It sees only the claims and page text, and has no tools. */
async function modelCheck(payload: CheckItem[], { client, signal }: Context) {
  const completion = await client.chat.completions.create(
    {
      ...baseRequest,
      max_completion_tokens: budgets().verifyOutputTokens,
      response_format: responseFormat("claim_verdicts", VerdictSchema),
      messages: [
        { role: "system", content: VERIFY_SYSTEM },
        { role: "user", content: `Check these claims against their evidence:\n${JSON.stringify(payload)}` },
      ],
    },
    { signal },
  );
  return VerdictSchema.parse(safeJson(completion.choices[0]?.message.content ?? "")).verdicts;
}

/**
 * Checks each claim against what its sources say and against every page read, because the drafter
 * often cites a nearby passage when the page states the fact elsewhere. The checker picks evidence
 * by id and code attaches the exact words, so a confirmed claim always has a real passage.
 */
async function verify(claims: DraftClaim[], pagesRead: { url: string; text: string }[], context: Context) {
  const { emit, signal } = context;
  const checks = await checkClaimQuotes(claims, signal);
  const matched = [...checks.values()].filter((check) => check.status === "quote_matched").length;
  emit({ stage: "verify", message: `Found ${matched} of ${checks.size} sourced claims word for word on their pages.` });

  const batch = claims.filter((claim) => claim.label === "sourced" || claim.label === "inferred").slice(0, MAX_MODEL_CHECKS);
  if (batch.length === 0) return { claims, checks };
  emit({ stage: "verify", message: `Having a separate agent check ${batch.length === 1 ? "the claim" : `the ${batch.length} claims`} against the pages that were read.` });

  const pages = new Map<string, Promise<PageResult>>();
  const read = (url: string) => {
    if (!pages.has(url)) pages.set(url, readPage(url, signal));
    return pages.get(url)!;
  };
  const { claimExcerptChars, verifyPromptChars } = budgets();
  const evidenceById = new Map<string, { claimId: string; url: string; quote: string }>();
  const items: CheckItem[] = [];
  for (const claim of batch) {
    const found = new Map<string, string>();
    const isMatched = checks.get(claim.id)?.status === "quote_matched";
    for (const { url, quote } of claim.sources) {
      if (isMatched && quote) {
        found.set(quote, url);
      } else if (!pagesRead.some((page) => page.url === url)) {
        const page = await read(url);
        if ("text" in page) for (const passage of toPassages(excerpt(page.text, claim.text, claimExcerptChars))) found.set(passage, url);
      }
    }
    for (const { url, text } of excerptAcross(pagesRead, claim.text, claimExcerptChars)) {
      for (const passage of toPassages(text)) if (!found.has(passage)) found.set(passage, url);
    }
    if (found.size === 0) continue;
    const evidence = [...found].map(([quote, url]) => {
      const id = `E${evidenceById.size + 1}`;
      evidenceById.set(id, { claimId: claim.id, url, quote });
      return { id, text: quote };
    });
    items.push({ id: claim.id, text: claim.text, evidence });
  }

  // Requests are split by size, because a request can't exceed the per-minute limit.
  const requests: CheckItem[][] = [];
  let size = 0;
  for (const item of items) {
    const itemSize = JSON.stringify(item).length;
    if (requests.length === 0 || size + itemSize > verifyPromptChars) {
      requests.push([]);
      size = 0;
    }
    requests.at(-1)!.push(item);
    size += itemSize;
  }

  const updated = new Map(claims.map((claim) => [claim.id, claim]));
  try {
    for (const request of requests) {
      for (const { id, verdict, evidence_id, note } of await modelCheck(request, context)) {
        const claim = updated.get(id);
        if (!claim) continue;
        if (verdict === "contradicted") {
          checks.set(id, { status: "contradicted", note });
        } else if (verdict === "cannot_tell") {
          // The cited text doesn't back the claim, so it shouldn't be shown as if it does.
          updated.set(id, { ...claim, sources: [] });
          checks.set(id, { status: "unverified", note });
        } else {
          const evidence = evidence_id ? evidenceById.get(evidence_id.toUpperCase()) : undefined;
          if (evidence?.claimId === id) {
            const source = { url: evidence.url, title: new URL(evidence.url).hostname, quote: evidence.quote };
            updated.set(id, { ...claim, label: "sourced", sources: [source] });
            checks.set(id, { status: "quote_matched", note: null });
          } else if (claim.label === "sourced" && checks.get(id)?.status !== "quote_matched") {
            checks.set(id, { status: "model_confirmed", note });
          }
        }
      }
    }
  } catch (error) {
    if (signal.aborted) throw error;
    // Publish anyway: any claims not reached stay as they were, which is what the reader should see.
    emit({ stage: "verify", message: "The second check didn't finish, so those claims stay marked as unverified." });
  }
  return { claims: [...updated.values()], checks };
}

export async function generateGuide(query: string, options: { client: Groq; emit: Emit; signal: AbortSignal }): Promise<Guide> {
  const context: Context = options;
  const { emit } = context;
  // Concurrent page reads and model calls each listen on this one signal.
  setMaxListeners(100, context.signal);

  const entry = findInCatalog(query);
  emit({
    stage: "identify",
    message: entry
      ? `${entry.name} is in Composio's directory: ${entry.status === "managed" ? "a managed app is available" : "you bring your own OAuth app"}.`
      : `"${query}" isn't in Composio's directory snapshot, so this is a fresh investigation.`,
  });
  const statusNote = entry
    ? `Directory fact: ${entry.name} is listed by Composio as ${entry.status === "managed" ? "having a Composio-managed OAuth app" : "needing the developer's own OAuth app"}. Research the provider's own requirements either way.`
    : "This app isn't in Composio's directory snapshot, which only lists OAuth-capable toolkits. That doesn't show it lacks OAuth, so check.";

  emit({ stage: "research", message: "Looking for official developer documentation." });
  const { notes, probes, passages, pages } = await research(query, statusNote, context);

  // Run by code, so a guide gets real observations even if the model didn't ask for any.
  const alreadyProbed = new Set(probes.map((probe) => probe.url));
  for (const url of probeTargets(pages, query)) {
    if (alreadyProbed.has(url) || probes.length >= MAX_PROBES) continue;
    emit({ stage: "research", message: `Testing ${url}` });
    const probe = await probeUrl(url, `p${probes.length + 1}`, context.signal);
    probes.push(probe);
    emit({ stage: "research", message: `Result: ${probe.observation}` });
  }

  emit({ stage: "draft", message: "Writing the guide from the research notes. This usually takes about a minute." });
  const guideDraft = await draft(query, notes, probes, context);
  const resolved = resolvePassages(guideDraft.claims, passages);
  const normalized = demoteModelTested(normalizeClaims({ ...guideDraft, claims: resolved }, probes));

  emit({ stage: "verify", message: `Checking ${normalized.filter((claim) => claim.label === "sourced").length} sourced claims against their pages.` });
  const { claims: verified, checks } = await verify(normalized, pages, context);
  const finalClaims = [...applyChecks(verified, checks), ...applyChecks(probeClaims(probes), new Map())];

  const guide: Guide = {
    ...guideDraft,
    claims: finalClaims,
    paths: explainHandoffs(requireApprovalEvidence(reconcileWaits(guideDraft.paths, finalClaims), finalClaims)),
    slug: uniqueSlug(entry?.slug ?? guideDraft.name),
    generatedAt: new Date().toISOString(),
    origin: "live_agent",
    model: MODEL,
    probes,
  };
  emit({ stage: "publish", message: "Guide ready." });
  return guide;
}
