import type Groq from "groq-sdk";
import { describe, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/jobs/[id]/control/route";
import { startJob } from "../src/lib/agent/jobs";
import { generateGuide } from "../src/lib/agent/pipeline";

vi.mock("../src/lib/agent/pipeline", () => ({ createClient: vi.fn(), generateGuide: vi.fn() }));
vi.mock("../src/lib/store", () => ({ saveGuide: vi.fn() }));

/** A run that only ends when it's aborted, like a long Groq request. */
function hangingRun(query: string) {
  vi.mocked(generateGuide).mockImplementationOnce(
    (_query, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
  );
  return startJob(query, "test-ip", {} as Groq).job;
}

const send = (id: string, body: unknown) =>
  POST(new Request(`http://localhost/api/jobs/${id}/control`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });

describe("the abort endpoint", () => {
  it("aborts the run for whoever started it", async () => {
    const job = hangingRun("route-ok");
    const response = await send(job.id, { action: "abort", token: job.controlToken });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(job.events.at(-1)).toMatchObject({ type: "aborted" }));
  });

  it("refuses anyone without the token, and leaves the run going", async () => {
    const job = hangingRun("route-forbidden");
    for (const token of ["wrong", "", job.controlToken.slice(0, -1)]) {
      const response = await send(job.id, { action: "abort", token });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Only the person who started this run can pause or abort it." });
    }
    expect(job.finished).toBe(false);
    job.control("abort");
  });

  it("rejects bad requests without touching the run", async () => {
    const job = hangingRun("route-bad");
    expect((await send(job.id, { action: "stop", token: job.controlToken })).status).toBe(400);
    expect((await send(job.id, { action: "abort" })).status).toBe(400);
    expect((await send(job.id, "not json")).status).toBe(400);
    expect(job.finished).toBe(false);
    job.control("abort");
  });

  it("says when the run doesn't exist or has already ended", async () => {
    expect((await send("no-such-run", { action: "abort", token: "x" })).status).toBe(404);
    const job = hangingRun("route-ended");
    // A double click sends two at once, and neither should come back as an error.
    const both = await Promise.all([send(job.id, { action: "abort", token: job.controlToken }), send(job.id, { action: "abort", token: job.controlToken })]);
    expect(both.map((response) => response.status)).toEqual([200, 200]);
    await vi.waitFor(() => expect(job.finished).toBe(true));
    const late = await send(job.id, { action: "abort", token: job.controlToken });
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: "This run has already finished." });
  });
});
