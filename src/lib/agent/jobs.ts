import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import Groq from "groq-sdk";
import { saveGuide } from "../store";
import { createClient, generateGuide, type ProgressEvent } from "./pipeline";

/** Counts only time spent running, so a pause doesn't use it up. */
const TIME_LIMIT_MS = 8 * 60_000;
/** A paused run holds memory and a place in the queue, so it can't wait forever. */
const PAUSE_LIMIT_MS = 10 * 60_000;
const JOB_RETENTION_MS = 60 * 60_000;

class SaveError extends Error {}

type AbortReason = "user" | "time_limit" | "pause_limit";

export type JobEvent =
  | ({ type: "progress" } & ProgressEvent)
  | { type: "paused" }
  | { type: "resumed" }
  | { type: "done"; slug: string }
  | { type: "aborted"; message: string }
  | { type: "failed"; message: string };

export type JobControl = "pause" | "resume" | "abort";

export type Job = {
  id: string;
  query: string;
  events: JobEvent[];
  listeners: Set<() => void>;
  finished: boolean;
  paused: boolean;
  /** Only the person who started the run gets this, since the progress page can be shared. */
  controlToken: string;
  control: (action: JobControl) => string | null;
};

/** Kept on globalThis so jobs survive dev-mode reloads. Runs in-process, so deploy as one long-lived server. */
type JobState = { jobs: Map<string, Job>; dayStart: number; dayCount: number; perIp: Map<string, number[]> };
const state: JobState = ((globalThis as unknown as { __jobs?: JobState }).__jobs ??= {
  jobs: new Map(),
  dayStart: 0,
  dayCount: 0,
  perIp: new Map(),
});

export const getJob = (id: string) => state.jobs.get(id) ?? null;

export const isConfigured = () => Boolean(process.env.GROQ_API_KEY);

const dedupeKey = (query: string) => query.trim().toLowerCase();

export function canControl(job: Job, token: unknown) {
  if (typeof token !== "string") return false;
  const given = Buffer.from(token);
  const expected = Buffer.from(job.controlToken);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Limits exist because each run spends real money and the endpoint is public. */
export function checkLimits(ip: string): string | null {
  const now = Date.now();
  if (now - state.dayStart > 24 * 60 * 60_000) {
    state.dayStart = now;
    state.dayCount = 0;
  }
  if (state.dayCount >= Number(process.env.MAX_GENERATIONS_PER_DAY || 5)) {
    return "This demo has reached its daily generation limit. Try again tomorrow, or browse the library.";
  }
  const recent = (state.perIp.get(ip) ?? []).filter((time) => now - time < 60 * 60_000);
  state.perIp.set(ip, recent);
  if (recent.length >= Number(process.env.MAX_GENERATIONS_PER_IP_PER_HOUR || 5)) {
    return "You've generated several guides recently. Please try again in an hour.";
  }
  return null;
}

/** `created` is false when the same app is already being investigated, and that run is shared instead. */
export function startJob(query: string, ip: string, client = createClient()): { job: Job; created: boolean } {
  for (const job of state.jobs.values()) {
    if (!job.finished && dedupeKey(job.query) === dedupeKey(query)) return { job, created: false };
  }
  state.dayCount += 1;
  state.perIp.get(ip)?.push(Date.now()) ?? state.perIp.set(ip, [Date.now()]);

  const abort = new AbortController();
  const signal = abort.signal;
  const end = (reason: AbortReason) => abort.abort(reason);

  // The time limit runs only while the run does: a pause banks what's left, a resume restarts it.
  let remaining = TIME_LIMIT_MS;
  let runningSince = Date.now();
  let runTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => end("time_limit"), remaining);
  let pauseTimer: ReturnType<typeof setTimeout> | undefined;
  let waiting: (() => void)[] = [];
  const clearTimers = () => {
    clearTimeout(runTimer);
    clearTimeout(pauseTimer);
  };

  const job: Job = {
    id: randomUUID(),
    query,
    events: [],
    listeners: new Set(),
    finished: false,
    paused: false,
    controlToken: randomBytes(24).toString("base64url"),
    control(action) {
      if (job.finished) return "This run has already finished.";
      // The run is already winding down after an abort, so a repeat click or a late pause changes nothing.
      if (signal.aborted) return null;
      if (action === "abort") {
        end("user");
        return null;
      }
      if (action === "pause") {
        if (job.paused) return null;
        job.paused = true;
        clearTimeout(runTimer);
        remaining -= Date.now() - runningSince;
        pauseTimer = setTimeout(() => end("pause_limit"), PAUSE_LIMIT_MS);
        push({ type: "paused" });
        return null;
      }
      if (!job.paused) return null;
      job.paused = false;
      clearTimeout(pauseTimer);
      runningSince = Date.now();
      runTimer = setTimeout(() => end("time_limit"), Math.max(remaining, 0));
      push({ type: "resumed" });
      for (const resume of waiting) resume();
      waiting = [];
      return null;
    },
  };
  state.jobs.set(job.id, job);
  const push = (event: JobEvent) => {
    job.events.push(event);
    for (const listener of job.listeners) listener();
  };

  const checkpoint = async () => {
    signal.throwIfAborted();
    while (job.paused) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        waiting.push(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        });
      });
    }
    signal.throwIfAborted();
  };

  generateGuide(query, { client, signal, checkpoint, emit: (event) => push({ type: "progress", ...event }) })
    .then((guide) => {
      // An abort that arrives during the last step still means nothing gets published.
      signal.throwIfAborted();
      try {
        saveGuide(guide);
      } catch (cause) {
        throw new SaveError("The guide couldn't be saved.", { cause });
      }
      job.finished = true;
      push({ type: "done", slug: guide.slug });
    })
    .catch((error: unknown) => {
      job.finished = true;
      job.paused = false;
      if (signal.reason === "user") return push({ type: "aborted", message: "You aborted this run, so no guide was published." });
      if (signal.reason === "pause_limit") return push({ type: "aborted", message: "This run was paused for more than 10 minutes, so it was aborted and no guide was published." });
      console.error(`Generation failed for ${job.id}:`, error);
      push({ type: "failed", message: describeFailure(error, signal) });
    })
    .finally(() => {
      clearTimers();
      const cleanup = setTimeout(() => state.jobs.delete(job.id), JOB_RETENTION_MS);
      cleanup.unref?.();
    });
  return { job, created: true };
}

function describeFailure(error: unknown, signal: AbortSignal) {
  if (error instanceof SaveError) return "The guide was written, but the server couldn't save it, so it wasn't published. Please try again later.";
  if (signal.reason === "time_limit") return "The investigation hit its 8-minute limit before finishing, so no guide was published.";
  if (error instanceof Groq.AuthenticationError) return "Live generation isn't set up correctly: the API key was rejected.";
  if (error instanceof Groq.RateLimitError) return "This demo has hit its AI usage limit. Please try again later, or browse the library.";
  if (error instanceof Groq.APIError && error.status === 413) return "This investigation grew too large for this demo's AI usage limit, so no guide was published.";
  if (error instanceof Groq.APIError) return "The AI service returned an error. Please try again.";
  return error instanceof Error && /step|turn limit|format/.test(error.message) ? error.message : "Something went wrong during generation. Please try again.";
}
