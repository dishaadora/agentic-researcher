import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateGuide, type ProgressEvent } from "../src/lib/agent/pipeline";
import type { GuideDraft } from "../src/lib/schema";

/** Runs the real orchestration against a scripted model. The network calls are stubbed. */
vi.mock("../src/lib/probe", () => ({
  probeUrl: vi.fn(async (url: string, id: string) => ({ id, url, status: 200, observation: "Publishes OAuth metadata.", checkedAt: "2026-11-04T00:00:00Z" })),
}));
vi.mock("../src/lib/quote-check", () => ({
  checkQuote: vi.fn(async (_url: string, quote: string) => (quote.includes("real") ? { status: "matched" } : { status: "not_found", note: "Not on the page." })),
}));
vi.mock("../src/lib/store", () => ({ uniqueSlug: (name: string) => name.toLowerCase() }));

const quoted = (id: string, quote: string): GuideDraft["claims"][number] => ({
  id,
  text: `Claim ${id}`,
  label: "sourced",
  sources: [{ url: "https://docs.acme.test/oauth", title: "Docs", quote }],
  probeRefs: [],
});

const DRAFT: GuideDraft = {
  name: "Acme",
  website: "https://acme.test",
  category: "Testing",
  oauthSupport: "yes",
  summary: "Summary.",
  biggestRisk: "Risk.",
  paths: [
    {
      id: "main",
      name: "Main",
      whenToUse: "Always.",
      gates: ["provider_review"],
      gatesKnown: true,
      handsOnHours: { min: 1, max: 2 },
      wait: { minDays: null, maxDays: 14, basis: "provider_stated", note: "", claimId: "wrong" },
      steps: [],
      blockers: [],
    },
  ],
  nuances: [],
  claims: [
    quoted("right", "a real passage from the page"),
    quoted("wrong", "words the model made up here"),
    quoted("disputed", "another made up passage here"),
    { id: "fake-test", text: "We tested it", label: "tested", sources: [], probeRefs: [] },
    { id: "real-test", text: "Metadata exists", label: "tested", sources: [], probeRefs: ["p1"] },
  ],
  unknowns: [],
};

const text = (value: string) => ({ type: "text", text: value, citations: null });
const message = (stop_reason: string, content: unknown[]) => ({ stop_reason, content }) as unknown as Anthropic.Beta.BetaMessage;
const verdicts = JSON.stringify({
  verdicts: [
    { id: "wrong", verdict: "cannot_tell", note: "The page doesn't say." },
    { id: "disputed", verdict: "contradicted", note: "The page says otherwise." },
  ],
});

function scriptedClient(replies: Anthropic.Beta.BetaMessage[]) {
  const requests: Record<string, unknown>[] = [];
  const stream = vi.fn((params: Record<string, unknown>) => {
    // The caller keeps appending to its messages array, so snapshot what was sent.
    requests.push({ ...params, messages: [...(params.messages as unknown[])] });
    const reply = replies.shift();
    if (!reply) throw new Error("The model was called more times than scripted");
    return {
      on(_event: string, listener: (block: unknown) => void) {
        reply.content.forEach(listener);
        return this;
      },
      finalMessage: async () => reply,
    };
  });
  return { client: { beta: { messages: { stream } } } as unknown as Anthropic, requests, stream };
}

const run = (client: Anthropic, query = "Acme") => {
  const events: ProgressEvent[] = [];
  return generateGuide(query, { client, signal: new AbortController().signal, emit: (event) => events.push(event) }).then((guide) => ({ guide, events }));
};

describe("generation pipeline", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs from research to a published guide, enforcing the evidence rules", async () => {
    const { client, requests } = scriptedClient([
      message("pause_turn", [{ type: "server_tool_use", name: "web_search", id: "s1", input: { query: "acme oauth docs" } }]),
      message("tool_use", [{ type: "tool_use", id: "t1", name: "probe_url", input: { url: "https://acme.test/.well-known/openid-configuration" } }]),
      message("end_turn", [text("Research notes.")]),
      message("end_turn", [text(JSON.stringify(DRAFT))]),
      message("end_turn", [text(verdicts)]),
    ]);
    const { guide, events } = await run(client);
    const byId = new Map(guide.claims.map((claim) => [claim.id, claim]));

    expect(byId.get("right")).toMatchObject({ label: "sourced", check: { status: "quote_matched" } });
    expect(byId.get("wrong")).toMatchObject({ label: "inferred", check: { status: "unverified" } });
    expect(byId.get("disputed")?.label).toBe("unknown");
    expect(byId.get("disputed")?.text).toMatch(/^Disputed/);
    expect(byId.get("fake-test")?.label).toBe("inferred");
    expect(byId.get("real-test")?.label).toBe("tested");
    expect(guide.paths[0]?.wait.basis).toBe("estimate");

    expect(guide.probes.map((probe) => probe.id)).toEqual(["p1"]);
    expect(guide.origin).toBe("live_agent");
    expect(events.map((event) => event.message).join("\n")).toContain("Searching: acme oauth docs");
    expect(events.at(-1)?.stage).toBe("publish");

    // A paused turn is resumed by sending its content back, and the probe result goes back too.
    const resumed = requests[1]!.messages as Anthropic.Beta.BetaMessageParam[];
    expect(resumed.at(-1)?.role).toBe("assistant");
    const withResult = requests[2]!.messages as Anthropic.Beta.BetaMessageParam[];
    expect(JSON.stringify(withResult.at(-1))).toContain("tool_result");
  });

  it("gives the drafting step no tools, since it reads untrusted notes", async () => {
    const { client, requests } = scriptedClient([
      message("end_turn", [text("Notes.")]),
      message("end_turn", [text(JSON.stringify({ ...DRAFT, claims: [quoted("right", "a real passage")] }))]),
    ]);
    await run(client);
    expect(requests[1]!.tools).toBeUndefined();
  });

  it("retries once when the draft fails validation", async () => {
    const { client, stream } = scriptedClient([
      message("end_turn", [text("Notes.")]),
      message("end_turn", [text('{"name":"incomplete"}')]),
      message("end_turn", [text(JSON.stringify({ ...DRAFT, claims: [quoted("right", "a real passage")] }))]),
    ]);
    const { guide } = await run(client);
    expect(guide.name).toBe("Acme");
    expect(stream).toHaveBeenCalledTimes(3);
  });

  it("fails clearly on a refusal", async () => {
    const { client } = scriptedClient([message("refusal", [])]);
    await expect(run(client)).rejects.toThrow("declined");
  });

  it("still publishes when the second check breaks, leaving claims unverified", async () => {
    const { client } = scriptedClient([
      message("end_turn", [text("Notes.")]),
      message("end_turn", [text(JSON.stringify(DRAFT))]),
      message("end_turn", [text("not json")]),
    ]);
    const { guide, events } = await run(client);
    expect(guide.claims.find((claim) => claim.id === "wrong")?.label).toBe("inferred");
    expect(events.map((event) => event.message).join("\n")).toContain("stay marked as unverified");
  });

  it("caps probes, so a page can't drive unlimited requests", async () => {
    const calls = Array.from({ length: 12 }, (_, index) => ({ type: "tool_use", id: `t${index}`, name: "probe_url", input: { url: `https://acme.test/${index}` } }));
    const { client, requests } = scriptedClient([
      message("tool_use", calls),
      message("end_turn", [text("Notes.")]),
      message("end_turn", [text(JSON.stringify({ ...DRAFT, claims: [quoted("right", "a real passage")] }))]),
    ]);
    const { guide } = await run(client);
    expect(guide.probes).toHaveLength(10);
    const results = requests[1]!.messages as Anthropic.Beta.BetaMessageParam[];
    expect(JSON.stringify(results.at(-1))).toContain("Probe limit reached");
  });
});
