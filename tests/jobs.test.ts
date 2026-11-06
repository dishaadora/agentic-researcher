import type Groq from "groq-sdk";
import { describe, expect, it, vi } from "vitest";
import { startJob, type Job } from "../src/lib/agent/jobs";
import { generateGuide } from "../src/lib/agent/pipeline";
import { saveGuide } from "../src/lib/store";

vi.mock("../src/lib/agent/pipeline", () => ({ createClient: vi.fn(), generateGuide: vi.fn() }));
vi.mock("../src/lib/store", () => ({ saveGuide: vi.fn() }));

const finish = (job: Job) => vi.waitFor(() => expect(job.finished).toBe(true));
const start = (query: string) => startJob(query, "test-ip", {} as Groq);

describe("publishing a generated guide", () => {
  it("reports done only after the guide is saved", async () => {
    vi.mocked(generateGuide).mockResolvedValueOnce({ slug: "acme" } as never);
    const job = start("acme");
    await finish(job);
    expect(saveGuide).toHaveBeenCalledOnce();
    expect(job.events.at(-1)).toEqual({ type: "done", slug: "acme" });
  });

  it("says so clearly when the guide can't be saved", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(generateGuide).mockResolvedValueOnce({ slug: "beta" } as never);
    vi.mocked(saveGuide).mockImplementationOnce(() => {
      throw new Error("EACCES: permission denied");
    });
    const job = start("beta");
    await finish(job);
    const last = job.events.at(-1);
    expect(last).toMatchObject({ type: "failed" });
    expect(last).toHaveProperty("message", expect.stringContaining("couldn't save it"));
    // The real cause still reaches the logs.
    expect((logged.mock.calls[0]![1] as Error).cause).toMatchObject({ message: "EACCES: permission denied" });
    logged.mockRestore();
  });
});
