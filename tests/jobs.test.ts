import type Groq from "groq-sdk";
import { describe, expect, it, vi } from "vitest";
import { canControl, startJob, type Job } from "../src/lib/agent/jobs";
import { generateGuide } from "../src/lib/agent/pipeline";
import { saveGuide } from "../src/lib/store";

vi.mock("../src/lib/agent/pipeline", () => ({ createClient: vi.fn(), generateGuide: vi.fn() }));
vi.mock("../src/lib/store", () => ({ saveGuide: vi.fn() }));

const finish = (job: Job) => vi.waitFor(() => expect(job.finished).toBe(true));
const start = (query: string) => startJob(query, "test-ip", {} as Groq).job;

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

type Options = Parameters<typeof generateGuide>[1];

/** A fake run that does `steps` steps, stopping at a checkpoint before each, and reports how far it got. */
function stepwiseRun(steps: number) {
  const reached: number[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  vi.mocked(generateGuide).mockImplementationOnce(async (query: string, options: Options) => {
    for (let step = 1; step <= steps; step++) {
      await options.checkpoint!();
      reached.push(step);
      // The first step waits until the test lets it go, so there's time to pause.
      if (step === 1) await gate;
    }
    return { slug: query } as never;
  });
  return { reached, release };
}

const types = (job: Job) => job.events.map((event) => event.type);

describe("pausing and aborting a run", () => {
  it("only accepts the token given to whoever started the run", () => {
    stepwiseRun(1).release();
    const first = startJob("gamma", "test-ip", {} as Groq);
    const joined = startJob("Gamma", "other-ip", {} as Groq);
    expect(first.created).toBe(true);
    expect(joined).toMatchObject({ created: false, job: first.job });
    expect(canControl(first.job, first.job.controlToken)).toBe(true);
    expect(canControl(first.job, "guess")).toBe(false);
    expect(canControl(first.job, undefined)).toBe(false);
  });

  it("holds at the next step while paused and carries on after a resume", async () => {
    const run = stepwiseRun(3);
    const job = start("delta");
    await vi.waitFor(() => expect(run.reached).toEqual([1]));
    expect(job.control("pause")).toBeNull();
    run.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run.reached).toEqual([1]);
    expect(job.paused).toBe(true);
    expect(job.control("resume")).toBeNull();
    await finish(job);
    expect(run.reached).toEqual([1, 2, 3]);
    expect(types(job)).toEqual(["paused", "resumed", "done"]);
  });

  it("aborts a paused run without publishing anything", async () => {
    vi.mocked(saveGuide).mockClear();
    const run = stepwiseRun(3);
    const job = start("epsilon");
    await vi.waitFor(() => expect(run.reached).toEqual([1]));
    job.control("pause");
    run.release();
    expect(job.control("abort")).toBeNull();
    await finish(job);
    expect(run.reached).toEqual([1]);
    expect(saveGuide).not.toHaveBeenCalled();
    expect(job.events.at(-1)).toMatchObject({ type: "aborted", message: expect.stringContaining("You aborted") });
    expect(job.control("resume")).toMatch(/already finished/);
  });

  it("doesn't publish when the abort arrives during the last step", async () => {
    vi.mocked(saveGuide).mockClear();
    const run = stepwiseRun(1);
    const job = start("zeta");
    await vi.waitFor(() => expect(run.reached).toEqual([1]));
    job.control("abort");
    run.release();
    await finish(job);
    expect(saveGuide).not.toHaveBeenCalled();
    expect(job.events.at(-1)).toMatchObject({ type: "aborted" });
  });

  it("frees the app for a new run once aborted", async () => {
    const run = stepwiseRun(1);
    const job = start("eta");
    job.control("abort");
    run.release();
    await finish(job);
    stepwiseRun(1).release();
    expect(startJob("eta", "test-ip", {} as Groq).created).toBe(true);
  });
});
