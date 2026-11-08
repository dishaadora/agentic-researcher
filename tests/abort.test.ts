import Groq from "groq-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startJob, type Job } from "../src/lib/agent/jobs";
import { readPage } from "../src/lib/page-text";
import { saveGuide } from "../src/lib/store";

/**
 * Aborting with the real jobs layer, the real pipeline and the real Groq SDK. Only the network under
 * the SDK, page reads, probes and storage are faked, so this covers how the SDK reacts to a cancel.
 */
vi.mock("../src/lib/store", () => ({ saveGuide: vi.fn(), uniqueSlug: (name: string) => name.toLowerCase() }));
vi.mock("../src/lib/probe", () => ({
  probeUrl: vi.fn(async (url: string, id: string) => ({ id, url, status: 200, observation: "OK.", checkedAt: "2026-11-08T00:00:00Z" })),
}));
vi.mock("../src/lib/quote-check", () => ({ checkQuote: vi.fn(async () => ({ status: "matched" })) }));
vi.mock("../src/lib/page-text", () => ({
  readPage: vi.fn(async () => ({ text: "Page text." })),
  excerpt: vi.fn((text: string) => text),
  toPassages: vi.fn((text: string) => [text]),
  excerptAcross: vi.fn(() => []),
}));

const toolCallReply = (name: string, args: Record<string, unknown>) => ({
  id: "c",
  object: "chat.completion",
  created: 0,
  model: "m",
  choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "", tool_calls: [{ id: "t", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
});

/** A fake Groq API. Each request waits until the test answers it, or until it's cancelled. */
function fakeGroq() {
  const requests: { signal: AbortSignal | null | undefined; answer: (body: unknown) => void }[] = [];
  const fetch = vi.fn(
    (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")), { once: true });
        requests.push({ signal, answer: (body) => resolve(Response.json(body)) });
      }),
  );
  const client = new Groq({ apiKey: "test-key", fetch: fetch as unknown as typeof globalThis.fetch, maxRetries: 5 });
  return { client, requests, fetch };
}

const finish = (job: Job) => vi.waitFor(() => expect(job.finished).toBe(true), { timeout: 2_000 });
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
let counter = 0;
const begin = (client: Groq) => startJob(`abort-test-${++counter}`, "test-ip", client).job;

describe("aborting a run", () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errors.mockRestore());

  it("cancels the Groq request in flight and publishes nothing", async () => {
    const groq = fakeGroq();
    const job = begin(groq.client);
    await vi.waitFor(() => expect(groq.requests).toHaveLength(1));

    expect(job.control("abort")).toBeNull();
    await finish(job);

    expect(groq.requests[0]!.signal?.aborted).toBe(true);
    await settle();
    // The SDK retries failures, but must not retry a cancel.
    expect(groq.fetch).toHaveBeenCalledTimes(1);
    expect(saveGuide).not.toHaveBeenCalled();
    expect(job.events.at(-1)).toEqual({ type: "aborted", message: "You aborted this run, so no guide was published." });
    expect(job.events.some((event) => event.type === "failed")).toBe(false);
    // An abort is the user's choice, not a failure, so it isn't logged as one.
    expect(errors).not.toHaveBeenCalled();
  });

  it("aborts a paused run without sending another request", async () => {
    const groq = fakeGroq();
    const job = begin(groq.client);
    await vi.waitFor(() => expect(groq.requests).toHaveLength(1));

    job.control("pause");
    groq.requests[0]!.answer(toolCallReply("fetch_page", { url: "https://docs.acme.test", looking_for: "review" }));
    await settle();
    expect(readPage).not.toHaveBeenCalled();

    job.control("abort");
    await finish(job);
    expect(groq.fetch).toHaveBeenCalledTimes(1);
    expect(readPage).not.toHaveBeenCalled();
    expect(job.paused).toBe(false);
    expect(job.events.map((event) => event.type).slice(-2)).toEqual(["paused", "aborted"]);
  });

  it("cancels a page read in flight", async () => {
    vi.mocked(readPage).mockImplementationOnce(
      (_url, signal) => new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })),
    );
    const groq = fakeGroq();
    const job = begin(groq.client);
    await vi.waitFor(() => expect(groq.requests).toHaveLength(1));
    groq.requests[0]!.answer(toolCallReply("fetch_page", { url: "https://docs.acme.test", looking_for: "review" }));
    await vi.waitFor(() => expect(readPage).toHaveBeenCalledOnce());

    job.control("abort");
    await finish(job);
    expect(groq.fetch).toHaveBeenCalledTimes(1);
    expect(job.events.at(-1)).toMatchObject({ type: "aborted" });
  });

  it("treats a second abort, or a pause sent after an abort, as harmless", async () => {
    const groq = fakeGroq();
    const job = begin(groq.client);
    await vi.waitFor(() => expect(groq.requests).toHaveLength(1));

    expect(job.control("abort")).toBeNull();
    // A double click, or a button pressed before the page hears the run ended.
    expect(job.control("abort")).toBeNull();
    expect(job.control("pause")).toBeNull();
    await finish(job);
    expect(job.events.filter((event) => event.type === "aborted")).toHaveLength(1);
    expect(job.events.some((event) => event.type === "paused")).toBe(false);
  });

  it("refuses controls once the run has ended", async () => {
    const groq = fakeGroq();
    const job = begin(groq.client);
    await vi.waitFor(() => expect(groq.requests).toHaveLength(1));
    job.control("abort");
    await finish(job);
    expect(job.control("abort")).toMatch(/already finished/);
    expect(job.control("resume")).toMatch(/already finished/);
  });
});

describe("timers after an abort", () => {
  afterEach(() => vi.useRealTimers());

  it("leaves no pause or time limit to fire later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const groq = fakeGroq();
    const job = begin(groq.client);
    await vi.waitFor(() => expect(groq.requests).toHaveLength(1));
    job.control("pause");
    job.control("abort");
    await vi.waitFor(() => expect(job.finished).toBe(true));
    const count = job.events.length;
    // Past both the 10-minute pause limit and the 8-minute run limit.
    vi.advanceTimersByTime(20 * 60_000);
    expect(job.events).toHaveLength(count);
    expect(job.events.at(-1)).toMatchObject({ type: "aborted", message: expect.stringContaining("You aborted") });
  });
});
