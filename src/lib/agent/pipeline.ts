import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { findInCatalog } from "../catalog";
import { applyChecks, checkClaimQuotes, normalizeClaims, reconcileWaits, type CheckResult } from "../evidence";
import { probeUrl } from "../probe";
import { GuideDraftSchema, type Guide, type GuideDraft, type Probe } from "../schema";
import { uniqueSlug } from "../store";
import { DRAFT_SYSTEM, RESEARCH_SYSTEM, VERIFY_SYSTEM } from "./prompts";

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
const MAX_RESEARCH_TURNS = 15;
const MAX_PROBES = 10;
const MAX_MODEL_CHECKS = 12;

export type Stage = "identify" | "research" | "draft" | "verify" | "publish";
export type ProgressEvent = { stage: Stage; message: string };
type Emit = (event: ProgressEvent) => void;
type Context = { client: Anthropic; emit: Emit; signal: AbortSignal };

const PROBE_TOOL: Anthropic.Beta.BetaTool = {
  name: "probe_url",
  description:
    "Sends one read-only GET to a public URL and reports what came back, such as OAuth discovery metadata or a redirect to sign-in. It never signs in or submits anything. Results are the only thing that can back a 'tested' claim.",
  input_schema: {
    type: "object",
    properties: { url: { type: "string", description: "Absolute https URL" } },
    required: ["url"],
    additionalProperties: false,
  },
  eager_input_streaming: true,
};

const baseRequest = {
  model: MODEL,
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default" as const,
};

function assertUsable(message: Anthropic.Beta.BetaMessage, step: string) {
  if (message.stop_reason === "refusal") throw new Error(`The model declined the ${step} step.`);
  if (message.stop_reason === "max_tokens") throw new Error(`The ${step} step ran out of output space.`);
}

const textOf = (message: Anthropic.Beta.BetaMessage) =>
  message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim();

async function research(query: string, statusNote: string, { client, emit, signal }: Context) {
  const probes: Probe[] = [];
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: `Investigate this app. The submitted name or website is:\n<submitted_app>${query}</submitted_app>\n\n${statusNote}`,
    },
  ];

  for (let turn = 0; turn < MAX_RESEARCH_TURNS; turn++) {
    const stream = client.beta.messages.stream(
      {
        ...baseRequest,
        max_tokens: 32_000,
        output_config: { effort: "medium" },
        system: RESEARCH_SYSTEM,
        tools: [
          { type: "web_search_20260209", name: "web_search", max_uses: 8 },
          { type: "web_fetch_20260209", name: "web_fetch", max_uses: 12, max_content_tokens: 30_000 },
          PROBE_TOOL,
        ],
        messages,
      },
      { signal },
    );
    stream.on("contentBlock", (block) => {
      if (block.type !== "server_tool_use") return;
      const input = block.input as { query?: string; url?: string } | null;
      if (block.name === "web_search" && input?.query) emit({ stage: "research", message: `Searching: ${input.query}` });
      if (block.name === "web_fetch" && input?.url) emit({ stage: "research", message: `Reading ${input.url}` });
    });
    const message = await stream.finalMessage();
    assertUsable(message, "research");
    messages.push({ role: "assistant", content: message.content });

    if (message.stop_reason === "pause_turn") continue;
    if (message.stop_reason !== "tool_use") return { notes: textOf(message), probes };

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      const url = (block.input as { url?: unknown } | null)?.url;
      if (block.name !== "probe_url" || typeof url !== "string") {
        results.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: "Expected probe_url with a url string." });
      } else if (probes.length >= MAX_PROBES) {
        results.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: "Probe limit reached. Finish with what you have." });
      } else {
        emit({ stage: "research", message: `Testing ${url}` });
        const probe = await probeUrl(url, `p${probes.length + 1}`, signal);
        probes.push(probe);
        emit({ stage: "research", message: `Result: ${probe.observation}` });
        results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(probe) });
      }
    }
    messages.push({ role: "user", content: results });
  }
  throw new Error("Research didn't finish within its turn limit.");
}

async function draft(query: string, notes: string, probes: Probe[], { client, signal }: Context): Promise<GuideDraft> {
  const format = betaZodOutputFormat(GuideDraftSchema);
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: `Write the guide for: <submitted_app>${query}</submitted_app>\n\n<research_notes>\n${notes}\n</research_notes>\n\n<probes>\n${JSON.stringify(probes)}\n</probes>`,
    },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const message = await client.beta.messages
      .stream({ ...baseRequest, max_tokens: 48_000, output_config: { effort: "medium", format }, system: DRAFT_SYSTEM, messages }, { signal })
      .finalMessage();
    assertUsable(message, "drafting");
    const parsed = safeJson(textOf(message));
    const result = GuideDraftSchema.safeParse(parsed);
    if (result.success) return result.data;
    messages.push({ role: "assistant", content: message.content });
    messages.push({ role: "user", content: `That output failed validation:\n${z.prettifyError(result.error)}\nReturn the corrected guide.` });
  }
  throw new Error("The draft didn't match the guide format after a retry.");
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const VerdictSchema = z.strictObject({
  verdicts: z.array(
    z.strictObject({
      id: z.string(),
      verdict: z.enum(["supported", "contradicted", "cannot_tell"]),
      note: z.string().describe("One short sentence explaining the verdict"),
    }),
  ),
});

/** A second opinion for claims the exact-quote check couldn't settle. It doesn't see the draft or notes. */
async function modelCheck(claims: GuideDraft["claims"], { client, signal }: Context) {
  const payload = claims.map(({ id, text, sources }) => ({ id, text, urls: sources.map((source) => source.url) }));
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: `Check these claims against their URLs:\n${JSON.stringify(payload, null, 1)}` },
  ];
  const format = betaZodOutputFormat(VerdictSchema);
  for (let turn = 0; turn < 6; turn++) {
    const message = await client.beta.messages
      .stream(
        {
          ...baseRequest,
          max_tokens: 16_000,
          output_config: { effort: "low", format },
          system: VERIFY_SYSTEM,
          tools: [{ type: "web_fetch_20260209", name: "web_fetch", max_uses: 15, max_content_tokens: 20_000 }],
          messages,
        },
        { signal },
      )
      .finalMessage();
    assertUsable(message, "verification");
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }
    return VerdictSchema.parse(safeJson(textOf(message))).verdicts;
  }
  throw new Error("Verification didn't finish within its turn limit.");
}

async function verify(claims: GuideDraft["claims"], context: Context) {
  const { emit, signal } = context;
  const checks = await checkClaimQuotes(claims, signal);
  const matched = [...checks.values()].filter((check) => check.status === "quote_matched").length;
  emit({ stage: "verify", message: `Found ${matched} of ${checks.size} sourced claims word for word on their pages.` });

  const unresolved = claims.filter((claim) => checks.get(claim.id)?.status === "unverified" && claim.sources.length > 0);
  const batch = unresolved.slice(0, MAX_MODEL_CHECKS);
  if (batch.length === 0) return checks;

  emit({ stage: "verify", message: `Having a separate agent check the ${batch.length === 1 ? "remaining claim" : `${batch.length} remaining claims`} against the source.` });
  try {
    for (const { id, verdict, note } of await modelCheck(batch, context)) {
      if (!checks.has(id)) continue;
      const result: CheckResult =
        verdict === "supported"
          ? { status: "model_confirmed", note }
          : verdict === "contradicted"
            ? { status: "contradicted", note }
            : { status: "unverified", note };
      checks.set(id, result);
    }
  } catch (error) {
    if (signal.aborted) throw error;
    // Publish anyway: the claims stay marked unverified, which is what the reader should see.
    emit({ stage: "verify", message: "The second check didn't finish, so those claims stay marked as unverified." });
  }
  return checks;
}

export async function generateGuide(query: string, options: { client: Anthropic; emit: Emit; signal: AbortSignal }): Promise<Guide> {
  const context: Context = options;
  const { emit } = context;

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
  const { notes, probes } = await research(query, statusNote, context);

  emit({ stage: "draft", message: "Writing the guide from the research notes. This usually takes about a minute." });
  const guideDraft = await draft(query, notes, probes, context);
  const claims = normalizeClaims(guideDraft, probes);

  emit({ stage: "verify", message: `Checking ${claims.filter((claim) => claim.label === "sourced").length} sourced claims against their pages.` });
  const checks = await verify(claims, context);
  const finalClaims = applyChecks(claims, checks);

  const guide: Guide = {
    ...guideDraft,
    claims: finalClaims,
    paths: reconcileWaits(guideDraft.paths, finalClaims),
    slug: uniqueSlug(entry?.slug ?? guideDraft.name),
    generatedAt: new Date().toISOString(),
    origin: "live_agent",
    model: MODEL,
    probes,
  };
  emit({ stage: "publish", message: "Guide ready." });
  return guide;
}
