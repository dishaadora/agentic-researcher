import { randomUUID } from "node:crypto";
import Groq from "groq-sdk";
import { saveGuide } from "../store";
import { createClient, generateGuide, type ProgressEvent } from "./pipeline";

const TIME_LIMIT_MS = 8 * 60_000;
const JOB_RETENTION_MS = 60 * 60_000;

export type JobEvent =
  | ({ type: "progress" } & ProgressEvent)
  | { type: "done"; slug: string }
  | { type: "failed"; message: string };

export type Job = { id: string; query: string; events: JobEvent[]; listeners: Set<() => void>; finished: boolean };

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

export function startJob(query: string, ip: string, client = createClient()): Job {
  for (const job of state.jobs.values()) {
    if (!job.finished && dedupeKey(job.query) === dedupeKey(query)) return job;
  }
  state.dayCount += 1;
  state.perIp.get(ip)?.push(Date.now()) ?? state.perIp.set(ip, [Date.now()]);

  const job: Job = { id: randomUUID(), query, events: [], listeners: new Set(), finished: false };
  state.jobs.set(job.id, job);
  const push = (event: JobEvent) => {
    job.events.push(event);
    for (const listener of job.listeners) listener();
  };

  const timeout = AbortSignal.timeout(TIME_LIMIT_MS);
  generateGuide(query, { client, signal: timeout, emit: (event) => push({ type: "progress", ...event }) })
    .then((guide) => {
      saveGuide(guide);
      job.finished = true;
      push({ type: "done", slug: guide.slug });
    })
    .catch((error: unknown) => {
      console.error(`Generation failed for ${job.id}:`, error);
      job.finished = true;
      push({ type: "failed", message: describeFailure(error, timeout) });
    })
    .finally(() => {
      const cleanup = setTimeout(() => state.jobs.delete(job.id), JOB_RETENTION_MS);
      cleanup.unref?.();
    });
  return job;
}

function describeFailure(error: unknown, timeout: AbortSignal) {
  if (timeout.aborted) return "The investigation hit its 8-minute limit before finishing, so no guide was published.";
  if (error instanceof Groq.AuthenticationError) return "Live generation isn't set up correctly: the API key was rejected.";
  if (error instanceof Groq.RateLimitError) return "This demo has hit its AI usage limit. Please try again later, or browse the library.";
  if (error instanceof Groq.APIError && error.status === 413) return "This investigation grew too large for this demo's AI usage limit, so no guide was published.";
  if (error instanceof Groq.APIError) return "The AI service returned an error. Please try again.";
  return error instanceof Error && /step|turn limit|format/.test(error.message) ? error.message : "Something went wrong during generation. Please try again.";
}
