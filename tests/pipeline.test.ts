import Groq from "groq-sdk";
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
vi.mock("../src/lib/page-text", () => ({
  readPage: vi.fn(async (url: string) => (url.includes("unreadable") ? { problem: "Blocked." } : { text: "Page text about the requirements." })),
  excerpt: vi.fn((text: string) => text),
  toPassages: vi.fn((text: string) => [text]),
  excerptAcross: vi.fn((pages: { url: string; text: string }[]) => pages.map(({ url, text }) => ({ url, text }))),
}));

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

type Reply = { choices: { finish_reason: string; message: Record<string, unknown> }[] };
const text = (content: string, finish_reason = "stop", extra: Record<string, unknown> = {}): Reply => ({
  choices: [{ finish_reason, message: { role: "assistant", content, ...extra } }],
});
const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const calls = (...tool_calls: ReturnType<typeof toolCall>[]) => text("", "tool_calls", { tool_calls });
const searchReply = (results: { title: string; url: string; content: string }[]) =>
  text("done", "stop", { executed_tools: [{ index: 0, type: "browser_search", arguments: "{}", search_results: { results } }] });
const verdicts = JSON.stringify({
  verdicts: [
    { id: "wrong", verdict: "cannot_tell", evidence_id: null, note: "The page doesn't say." },
    { id: "disputed", verdict: "contradicted", evidence_id: null, note: "The page says otherwise." },
  ],
});

function scriptedClient(replies: Reply[]) {
  const requests: { messages: { role: string; content: string }[]; [key: string]: unknown }[] = [];
  const create = vi.fn(async (params: { messages: { role: string; content: string }[] }) => {
    // The caller keeps changing its messages, so snapshot what was sent.
    requests.push(structuredClone(params));
    const reply = replies.shift();
    if (!reply) throw new Error("The model was called more times than scripted");
    return reply;
  });
  return { client: { chat: { completions: { create } } } as unknown as Groq, requests, create };
}

const run = (client: Groq, query = "Acme") => {
  const events: ProgressEvent[] = [];
  return generateGuide(query, { client, signal: new AbortController().signal, emit: (event) => events.push(event) }).then((guide) => ({ guide, events }));
};

describe("generation pipeline", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs from research to a published guide, enforcing the evidence rules", async () => {
    const { client, requests } = scriptedClient([
      calls(toolCall("t0", "search_web", { query: "acme oauth docs" })),
      searchReply([
        { title: "Docs", url: "https://docs.acme.test/oauth", content: "Full page text from Groq's browser" },
        { title: "Docs again", url: "https://docs.acme.test/oauth", content: "" },
        { title: "Bad link", url: "javascript:alert(1)", content: "" },
      ]),
      calls(toolCall("t1", "probe_url", { url: "https://acme.test/.well-known/openid-configuration" })),
      calls(toolCall("t2", "fetch_page", { url: "https://docs.acme.test/oauth", looking_for: "review" })),
      text("Early notes."),
      text("Research notes【2†L6-L10】."),
      text(JSON.stringify(DRAFT)),
      text(verdicts),
    ]);
    const { guide, events } = await run(client);
    const byId = new Map(guide.claims.map((claim) => [claim.id, claim]));

    expect(byId.get("right")).toMatchObject({ label: "sourced", check: { status: "quote_matched" } });
    expect(byId.get("wrong")).toMatchObject({ label: "inferred", check: { status: "unverified" } });
    expect(byId.get("disputed")?.label).toBe("unknown");
    expect(byId.get("disputed")?.text).toMatch(/^Disputed/);
    expect(byId.get("fake-test")?.label).toBe("inferred");
    // Only code writes tested claims, even when the model cites a probe that ran.
    expect(byId.get("real-test")?.label).toBe("inferred");
    expect(byId.get("probe-p1")).toMatchObject({ label: "tested", probeRefs: ["p1"] });
    expect(guide.paths[0]?.wait.basis).toBe("estimate");

    // The model asked for p1, and code ran the discovery checks after research.
    expect(guide.probes.map((probe) => probe.url)).toEqual(["https://acme.test/.well-known/openid-configuration", "https://acme.test/.well-known/oauth-authorization-server"]);
    expect(guide.probes.map((probe) => probe.id)).toEqual(["p1", "p2"]);
    expect(byId.get("probe-p2")).toMatchObject({ label: "tested", probeRefs: ["p2"] });
    expect(guide.origin).toBe("live_agent");
    expect(events.map((event) => event.message).join("\n")).toContain("Searching: acme oauth docs");
    expect(events.at(-1)?.stage).toBe("publish");

    // Tool results go back to the model, and search citation markers don't reach the drafting step.
    expect(requests[3]!.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "t1" });
    expect(requests[4]!.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "t2", content: "URL: https://docs.acme.test/oauth\n[P1] Page text about the requirements." });
    expect(requests[5]!.messages.at(-1)?.content).toContain("read only 1 page");
    expect(requests[6]!.messages.at(-1)?.content).toContain("Research notes.");
    expect(requests[6]!.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true } });
    expect(JSON.stringify(requests[6]!.response_format)).not.toContain("$schema");
  });

  it("gets search links from Groq's results and keeps its browser out of the research loop", async () => {
    const { client, requests } = scriptedClient([
      calls(toolCall("t0", "search_web", { query: "acme oauth docs" })),
      searchReply([
        { title: "Docs", url: "https://docs.acme.test/oauth", content: "Full page text from Groq's browser" },
        { title: "Docs again", url: "https://docs.acme.test/oauth", content: "" },
        { title: "Bad link", url: "javascript:alert(1)", content: "" },
      ]),
      text("Notes."),
      text(JSON.stringify({ ...DRAFT, claims: [quoted("right", "a real passage")] })),
    ]);
    await run(client);
    expect(JSON.stringify(requests[0]!.tools)).not.toContain("browser_search");
    expect(requests[1]!.tools).toEqual([{ type: "browser_search" }]);
    const results = requests[2]!.messages.at(-1)!;
    expect(results.role).toBe("tool");
    expect(JSON.parse(results.content)).toEqual([{ url: "https://docs.acme.test/oauth", title: "Docs" }]);
  });

  it("limits searches, because each one is expensive", async () => {
    const searches = [1, 2, 3].map((n) => toolCall(`t${n}`, "search_web", { query: `query ${n}` }));
    const { client, requests } = scriptedClient([
      calls(...searches),
      searchReply([{ title: "A", url: "https://a.test/", content: "" }]),
      searchReply([{ title: "B", url: "https://b.test/", content: "" }]),
      text("Notes."),
      text(JSON.stringify({ ...DRAFT, claims: [quoted("right", "a real passage")] })),
    ]);
    await run(client);
    expect(requests.filter((request) => JSON.stringify(request.tools) === '[{"type":"browser_search"}]')).toHaveLength(2);
    expect(requests[3]!.messages.at(-1)?.content).toContain("search limit reached");
  });

  it("carries on when a search finds nothing", async () => {
    const { client, requests } = scriptedClient([
      calls(toolCall("t0", "search_web", { query: "acme" })),
      searchReply([]),
      searchReply([]),
      searchReply([]),
      text("Notes."),
      text(JSON.stringify({ ...DRAFT, claims: [quoted("right", "a real passage")] })),
    ]);
    await run(client);
    expect(requests[4]!.messages.at(-1)?.content).toContain("No results");
  });

  it("retries a malformed tool call without using up a research turn", async () => {
    const malformed = new Groq.BadRequestError(400, undefined, "tool_use_failed: attempted to call tool 'search'", new Headers());
    const create = vi.fn();
    for (let attempt = 0; attempt < 4; attempt++) create.mockRejectedValueOnce(malformed);
    create.mockResolvedValueOnce(text("Notes.")).mockResolvedValueOnce(text(JSON.stringify({ ...DRAFT, claims: [quoted("right", "a real passage")] })));
    const { guide } = await run({ chat: { completions: { create } } } as unknown as Groq);
    expect(guide.name).toBe("Acme");
    expect(create.mock.calls[3]![0].tool_choice).toBe("auto");
    expect(create.mock.calls[5]![0].response_format.json_schema.name).toBe("oauth_guide");
  });

  it("wraps up instead of failing when a research turn is cut off", async () => {
    const { client, requests } = scriptedClient([
      text("Long search output", "length"),
      text("Notes."),
      text(JSON.stringify({ ...DRAFT, claims: [quoted("right", "a real passage")] })),
    ]);
    const { guide } = await run(client);
    expect(guide.name).toBe("Acme");
    expect(requests[0]!.tool_choice).toBe("auto");
    expect(requests[1]!.tool_choice).toBe("none");
  });

  it("removes the oldest tool results to stay under the token limit", async () => {
    const { readPage } = await import("../src/lib/page-text");
    for (let read = 0; read < 4; read++) vi.mocked(readPage).mockResolvedValueOnce({ text: "x".repeat(9_000) });
    const pages = [1, 2, 3, 4].map((n) => calls(toolCall(`t${n}`, "fetch_page", { url: `https://docs.acme.test/${n}`, looking_for: "review" })));
    const { client, requests } = scriptedClient([
      ...pages,
      text("Notes."),
      text(JSON.stringify({ ...DRAFT, claims: [quoted("right", "a real passage")] })),
    ]);
    await run(client);
    const last = requests[4]!.messages;
    expect(last.find((entry) => entry.role === "tool")?.content).toContain("Removed");
    expect(last.at(-1)?.content).toContain("x".repeat(9_000));
    expect(JSON.stringify(last).length / 4).toBeLessThan(8_000 * 0.55 + 3_000);
  });

  it("limits page reads, so a page can't drive unlimited requests", async () => {
    const reads = Array.from({ length: 6 }, (_, n) => toolCall(`t${n}`, "fetch_page", { url: `https://docs.acme.test/${n}`, looking_for: "review" }));
    const { client, requests } = scriptedClient([
      calls(...reads),
      text("Notes."),
      text(JSON.stringify({ ...DRAFT, claims: [quoted("right", "a real passage")] })),
    ]);
    await run(client);
    const { readPage } = await import("../src/lib/page-text");
    expect(readPage).toHaveBeenCalledTimes(5);
    expect(requests[1]!.messages.at(-1)?.content).toContain("page limit reached");
  });

  it("doesn't use up a page read on a page that can't be opened", async () => {
    const reads = ["https://unreadable.acme.test/", ...[1, 2, 3, 4, 5].map((n) => `https://docs.acme.test/${n}`)].map((url, n) => toolCall(`t${n}`, "fetch_page", { url, looking_for: "review" }));
    const { client, requests } = scriptedClient([
      calls(...reads),
      text("Notes."),
      text(JSON.stringify({ ...DRAFT, claims: [quoted("right", "a real passage")] })),
    ]);
    await run(client);
    const results = requests[1]!.messages.filter((entry) => entry.role === "tool");
    expect(results[0]!.content).toContain("Couldn't read");
    expect(results[5]!.content).toContain("[P5]");
  });

  it("fills in cited passages from what was read, so the model can't reword them or change the URL", async () => {
    const cited = { ...quoted("cited", "P1"), sources: [{ url: "", title: "Docs", quote: "P1" }] };
    const invented = { ...quoted("invented", "P99"), sources: [{ url: "https://made-up.test/", title: "Docs", quote: "P99" }] };
    const { client } = scriptedClient([
      calls(toolCall("t1", "fetch_page", { url: "https://docs.acme.test/oauth", looking_for: "review" })),
      text("Early notes."),
      text("Fact [P1]."),
      text(JSON.stringify({ ...DRAFT, claims: [cited, invented] })),
      text(JSON.stringify({ verdicts: [{ id: "cited", verdict: "supported", evidence_id: null, note: "Says so." }] })),
    ]);
    const { guide } = await run(client);
    const byId = new Map(guide.claims.map((claim) => [claim.id, claim]));
    expect(byId.get("cited")?.sources[0]).toMatchObject({ url: "https://docs.acme.test/oauth", quote: "Page text about the requirements." });
    expect(byId.get("invented")).toMatchObject({ label: "inferred", sources: [] });
  });

  it("downgrades a real quote that doesn't support its claim", async () => {
    const { client, requests } = scriptedClient([
      text("Notes."),
      text(JSON.stringify({ ...DRAFT, claims: [quoted("right", "a real passage")] })),
      text(JSON.stringify({ verdicts: [{ id: "right", verdict: "cannot_tell", evidence_id: null, note: "The passage is about something else." }] })),
    ]);
    const { guide } = await run(client);
    expect(requests[2]!.messages.at(-1)?.content).toContain("a real passage");
    expect(guide.claims[0]).toMatchObject({ label: "inferred", check: { status: "unverified" } });
  });

  it("upgrades a claim when the checker finds real evidence on a page that was read", async () => {
    const memory = { id: "memory", text: "Tokens last an hour", label: "inferred" as const, sources: [], probeRefs: [] };
    const { client, requests } = scriptedClient([
      calls(toolCall("t1", "fetch_page", { url: "https://docs.acme.test/tokens", looking_for: "tokens" })),
      text("Early notes."),
      text("Notes."),
      text(JSON.stringify({ ...DRAFT, claims: [memory] })),
      text(JSON.stringify({ verdicts: [{ id: "memory", verdict: "supported", evidence_id: "E1", note: "Says so." }] })),
    ]);
    const { guide } = await run(client);
    expect(requests[4]!.messages.at(-1)?.content).toContain("E1");
    expect(guide.claims.find((claim) => claim.id === "memory")).toMatchObject({
      label: "sourced",
      check: { status: "quote_matched" },
      sources: [{ url: "https://docs.acme.test/tokens", quote: "Page text about the requirements." }],
    });
  });

  it("won't accept evidence that was offered for a different claim", async () => {
    const claimA = { id: "a", text: "Fact A", label: "inferred" as const, sources: [], probeRefs: [] };
    const claimB = { id: "b", text: "Fact B", label: "inferred" as const, sources: [], probeRefs: [] };
    const { client } = scriptedClient([
      calls(toolCall("t1", "fetch_page", { url: "https://docs.acme.test/a", looking_for: "a" })),
      text("Early notes."),
      text("Notes."),
      text(JSON.stringify({ ...DRAFT, claims: [claimA, claimB] })),
      text(JSON.stringify({ verdicts: [{ id: "b", verdict: "supported", evidence_id: "E1", note: "Says so." }] })),
    ]);
    const { guide } = await run(client);
    expect(guide.claims.find((claim) => claim.id === "b")?.label).toBe("inferred");
  });

  it("removes a cited source that doesn't back its claim", async () => {
    const { client } = scriptedClient([
      text("Notes."),
      text(JSON.stringify({ ...DRAFT, claims: [quoted("right", "a real passage")] })),
      text(JSON.stringify({ verdicts: [{ id: "right", verdict: "cannot_tell", evidence_id: null, note: "It's about something else." }] })),
    ]);
    const { guide } = await run(client);
    expect(guide.claims[0]).toMatchObject({ label: "inferred", sources: [] });
  });

  it("keeps a matched quote as sourced when the check supports it", async () => {
    const { client } = scriptedClient([
      text("Notes."),
      text(JSON.stringify({ ...DRAFT, claims: [quoted("right", "a real passage")] })),
      text(JSON.stringify({ verdicts: [{ id: "right", verdict: "supported", evidence_id: null, note: "Says so." }] })),
    ]);
    const { guide } = await run(client);
    expect(guide.claims[0]).toMatchObject({ label: "sourced", check: { status: "quote_matched" } });
  });

  it("doesn't ask the model to judge a claim when its page can't be read", async () => {
    const unreadable = { ...quoted("gone", "words that aren't on the page"), sources: [{ url: "https://unreadable.acme.test/", title: "Docs", quote: "words that aren't on the page" }] };
    const { client, requests } = scriptedClient([
      text("Notes."),
      text(JSON.stringify({ ...DRAFT, claims: [quoted("right", "a real passage"), unreadable] })),
      text(JSON.stringify({ verdicts: [] })),
    ]);
    const { guide } = await run(client);
    expect(requests[2]!.messages.at(-1)?.content).not.toContain('"gone"');
    expect(guide.claims.find((claim) => claim.id === "gone")?.label).toBe("inferred");
  });

  it("won't publish a self-serve path whose no-approval claim failed, or a handoff with no reason", async () => {
    const step = { title: "Register", owner: "you" as const, detail: "Register.", minutes: { min: 5, max: 10 }, confirm: "It exists.", handoffReason: null, claimIds: [] };
    const path = {
      ...DRAFT.paths[0]!,
      gates: [],
      wait: { minDays: null, maxDays: null, basis: "none" as const, note: "Activation is immediate.", claimId: "wrong" },
      steps: [step],
    };
    const { client } = scriptedClient([text("Notes."), text(JSON.stringify({ ...DRAFT, paths: [path] })), text(verdicts)]);
    const { guide } = await run(client);
    expect(guide.paths[0]).toMatchObject({ gatesKnown: false, wait: { basis: "unknown", claimId: null } });
    expect(guide.paths[0]!.steps[0]!.handoffReason).toMatch(/your account/);
  });

  it("gives the drafting step no tools, since it reads untrusted notes", async () => {
    const { client, requests } = scriptedClient([
      text("Notes."),
      text(JSON.stringify({ ...DRAFT, claims: [quoted("right", "a real passage")] })),
    ]);
    await run(client);
    expect(requests[1]!.tools).toBeUndefined();
  });

  it("gives the verifying step no tools, since it reads untrusted pages", async () => {
    const { client, requests } = scriptedClient([text("Notes."), text(JSON.stringify(DRAFT)), text(verdicts)]);
    await run(client);
    expect(requests[2]!.tools).toBeUndefined();
    expect(requests[2]!.messages.at(-1)?.content).toContain("Page text about the requirements.");
  });

  it("retries once when the draft fails validation", async () => {
    const { client, create } = scriptedClient([
      text("Notes."),
      text('{"name":"incomplete"}'),
      text(JSON.stringify({ ...DRAFT, claims: [quoted("right", "a real passage")] })),
    ]);
    const { guide } = await run(client);
    expect(guide.name).toBe("Acme");
    expect(create.mock.calls.filter(([params]) => (params as { response_format?: { json_schema: { name: string } } }).response_format?.json_schema.name === "oauth_guide")).toHaveLength(2);
  });

  it("fails clearly when the draft is cut off", async () => {
    const { client } = scriptedClient([text("Notes."), text('{"name":', "length")]);
    await expect(run(client)).rejects.toThrow("ran out of output space");
  });

  it("fails clearly when research returns no notes", async () => {
    const { client } = scriptedClient([text("")]);
    await expect(run(client)).rejects.toThrow("no notes");
  });

  it("still publishes when the second check breaks, leaving claims unverified", async () => {
    const { client } = scriptedClient([text("Notes."), text(JSON.stringify(DRAFT)), text("not json")]);
    const { guide, events } = await run(client);
    expect(guide.claims.find((claim) => claim.id === "wrong")?.label).toBe("inferred");
    expect(events.map((event) => event.message).join("\n")).toContain("stay marked as unverified");
  });

  it("caps probes, so a page can't drive unlimited requests", async () => {
    const probes = Array.from({ length: 12 }, (_, index) => toolCall(`t${index}`, "probe_url", { url: `https://acme.test/${index}` }));
    const { client, requests } = scriptedClient([
      calls(...probes),
      text("Notes."),
      text(JSON.stringify({ ...DRAFT, claims: [quoted("right", "a real passage")] })),
    ]);
    const { guide } = await run(client);
    expect(guide.probes).toHaveLength(10);
    expect(requests[1]!.messages.at(-1)?.content).toContain("probe limit reached");
  });
});
