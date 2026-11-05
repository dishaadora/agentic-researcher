"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

type Stage = "identify" | "research" | "draft" | "verify" | "publish";
type RunEvent = { type: "progress"; stage: Stage; message: string } | { type: "done"; slug: string } | { type: "failed"; message: string };

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

  useEffect(() => {
    const source = new EventSource(`/api/jobs/${id}/events`);
    source.onmessage = (message) => {
      setLost(false);
      const event = JSON.parse(message.data as string) as RunEvent;
      setEvents((previous) => [...previous, event]);
      if (event.type !== "progress") source.close();
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

  return (
    <section className="run">
      <h1>{app ? `Investigating ${app}` : "Investigating"}</h1>
      <p className="lede">An agent is reading the provider's docs and testing public endpoints. You can share this page while it runs.</p>

      <ol className="stages" aria-label="Progress">
        {STAGES.map((stage, index) => {
          const state = done || index < currentIndex ? "done" : index === currentIndex && !failed ? "active" : "todo";
          return <li key={stage.id} className={`stage stage-${state}`} aria-current={state === "active" ? "step" : undefined}>{stage.label}</li>;
        })}
      </ol>

      <ol className="log" aria-live="polite" ref={logBox}>
        {progress.map((event, index) => <li key={index}>{event.message}</li>)}
      </ol>

      {done ? <p className="notice">The guide is ready. <Link href={`/guides/${done.slug}`}>Open it now</Link>.</p> : null}
      {failed ? <p className="form-error" role="alert">{failed.message} <Link href="/">Back to the library</Link>.</p> : null}
      {lost ? <p className="form-error" role="alert">This run has expired or the server restarted. <Link href="/">Start again</Link>.</p> : null}
    </section>
  );
}

export default function GeneratePage() {
  return <Suspense><Run /></Suspense>;
}
