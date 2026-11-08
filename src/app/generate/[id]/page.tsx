"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { loadControlToken } from "@/lib/run-control";

type Stage = "identify" | "research" | "draft" | "verify" | "publish";
type RunEvent =
  | { type: "progress"; stage: Stage; message: string }
  | { type: "paused" }
  | { type: "resumed" }
  | { type: "done"; slug: string }
  | { type: "aborted"; message: string }
  | { type: "failed"; message: string };

const isFinal = (event: RunEvent) => event.type === "done" || event.type === "aborted" || event.type === "failed";

/** Drawn inline so they follow the text colour in both themes. */
const PauseIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
    <rect x="3.5" y="2.5" width="3" height="11" rx="0.75" fill="currentColor" />
    <rect x="9.5" y="2.5" width="3" height="11" rx="0.75" fill="currentColor" />
  </svg>
);
const PlayIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
    <path d="M4.5 2.6v10.8a.6.6 0 0 0 .9.5l8.6-5.4a.6.6 0 0 0 0-1L5.4 2.1a.6.6 0 0 0-.9.5Z" fill="currentColor" />
  </svg>
);
const AbortIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
  </svg>
);

const STAGES: { id: Stage; label: string }[] = [
  { id: "identify", label: "Find the app" },
  { id: "research", label: "Investigate" },
  { id: "draft", label: "Write" },
  { id: "verify", label: "Check claims" },
  { id: "publish", label: "Publish" },
];

function Run() {
  const { id } = useParams<{ id: string }>();
  const app = useSearchParams().get("app");
  const router = useRouter();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [lost, setLost] = useState(false);
  const logBox = useRef<HTMLOListElement>(null);
  const [token, setToken] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [confirmingAbort, setConfirmingAbort] = useState(false);
  // Set once an abort is accepted, so the controls go away before the run's final event arrives.
  const [aborting, setAborting] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);

  // Read after mounting, since session storage only exists in the browser.
  useEffect(() => setToken(loadControlToken(id)), [id]);

  useEffect(() => {
    const source = new EventSource(`/api/jobs/${id}/events`);
    source.onmessage = (message) => {
      setLost(false);
      const event = JSON.parse(message.data as string) as RunEvent;
      setEvents((previous) => [...previous, event]);
      if (isFinal(event)) source.close();
      if (event.type === "done") setTimeout(() => router.push(`/guides/${event.slug}`), 1500);
    };
    // EventSource reconnects by itself. CLOSED means the server refused, so the run is gone.
    source.onerror = () => setLost(source.readyState === EventSource.CLOSED);
    return () => source.close();
  }, [id, router]);

  // Scroll only the log box, so the page itself doesn't jump as lines arrive.
  useEffect(() => {
    const box = logBox.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [events.length]);

  const progress = events.filter((event) => event.type === "progress");
  const current = progress.at(-1)?.stage ?? "identify";
  const currentIndex = STAGES.findIndex((stage) => stage.id === current);
  const failed = events.find((event) => event.type === "failed");
  const done = events.find((event) => event.type === "done");
  const aborted = events.find((event) => event.type === "aborted");
  const finished = events.some(isFinal);
  // Replayed in order, so the latest pause or resume is the current state for every viewer.
  const paused = !finished && events.filter((event) => event.type === "paused" || event.type === "resumed").at(-1)?.type === "paused";

  async function control(action: "pause" | "resume" | "abort") {
    if (!token) return;
    setSending(true);
    setControlError(null);
    try {
      const response = await fetch(`/api/jobs/${id}/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, token }),
      });
      if (response.ok && action === "abort") setAborting(true);
      if (!response.ok) setControlError(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "That didn't work. Please try again.");
    } catch {
      setControlError("Couldn't reach the server. Check your connection and try again.");
    }
    setConfirmingAbort(false);
    setSending(false);
  }

  return (
    <section className="run">
      <h1>{app ? `Investigating ${app}` : "Investigating"}</h1>
      <p className="lede">An agent is reading the provider's docs and testing public endpoints. You can share this page while it runs.</p>

      <ol className="stages" aria-label="Progress">
        {STAGES.map((stage, index) => {
          const state = done || index < currentIndex ? "done" : index === currentIndex && !failed && !aborted ? (paused ? "paused" : "active") : "todo";
          return <li key={stage.id} className={`stage stage-${state}`} aria-current={state === "active" ? "step" : undefined}>{stage.label}</li>;
        })}
      </ol>

      {paused ? (
        <p className="notice" role="status">
          {token
            ? "Paused. The step that was running finishes first, then nothing more runs until you resume. A run paused for 10 minutes is aborted."
            : "The person who started this run has paused it."}
        </p>
      ) : null}
      {controlError ? <p className="form-error" role="alert">{controlError}</p> : null}

      <div className="log-panel">
        {!finished && !lost && !aborting && token ? (
          <div className="run-controls" role="toolbar" aria-label="Run controls">
            {confirmingAbort ? (
              <>
                <span className="small">Abort? Nothing will be published.</span>
                <button type="button" className="control danger" onClick={() => void control("abort")} disabled={sending}>
                  <AbortIcon /> Abort
                </button>
                <button type="button" className="control" onClick={() => setConfirmingAbort(false)} disabled={sending}>Keep going</button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="control icon-only"
                  onClick={() => void control(paused ? "resume" : "pause")}
                  disabled={sending}
                  aria-label={paused ? "Resume" : "Pause"}
                  title={paused ? "Resume" : "Pause"}
                >
                  {paused ? <PlayIcon /> : <PauseIcon />}
                </button>
                <button type="button" className="control" onClick={() => setConfirmingAbort(true)} disabled={sending}>
                  <AbortIcon /> Abort
                </button>
              </>
            )}
          </div>
        ) : null}
        <ol className="log" aria-live="polite" ref={logBox}>
          {progress.map((event, index) => <li key={index}>{event.message}</li>)}
        </ol>
      </div>

      {done ? <p className="notice">The guide is ready. <Link href={`/guides/${done.slug}`}>Open it now</Link>.</p> : null}
      {aborted ? <p className="form-error" role="alert">{aborted.message} <Link href="/">Back to the library</Link>.</p> : null}
      {failed ? <p className="form-error" role="alert">{failed.message} <Link href="/">Back to the library</Link>.</p> : null}
      {lost ? <p className="form-error" role="alert">This run has expired or the server restarted. <Link href="/">Start again</Link>.</p> : null}
    </section>
  );
}

export default function GeneratePage() {
  return <Suspense><Run /></Suspense>;
}
