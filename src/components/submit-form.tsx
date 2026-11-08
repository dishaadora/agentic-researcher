"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { checkApp, squash, type AppCheck } from "@/lib/app-check";
import { saveControlToken } from "@/lib/run-control";

type Problem = Exclude<AppCheck, { ok: true }>;

export function SubmitForm({ names }: { names: string[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [stage, setStage] = useState<"idle" | "checking" | "starting">("idle");
  const pending = useRef<AbortController | null>(null);

  /** The app has passed every check, so this is the first time the server sees it. */
  async function start(app: string) {
    setStage("starting");
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: app }),
      });
      const result = (await response.json()) as { slug?: string; jobId?: string; controlToken?: string; error?: string };
      if (result.slug) return router.push(`/guides/${result.slug}`);
      if (result.jobId && result.controlToken) saveControlToken(result.jobId, result.controlToken);
      if (result.jobId) return router.push(`/generate/${result.jobId}?app=${encodeURIComponent(app)}`);
      setError(result.error ?? "That didn't work. Please try again.");
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    }
    setStage("idle");
  }

  async function verify(app: string, skipSpelling = false) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setError(null);
    setProblem(null);
    setStage("checking");
    const result = await checkApp(app, names, { skipSpelling, signal: controller.signal });
    if (controller.signal.aborted) return;
    if (result.ok) return start(result.query);
    setProblem(result);
    setStage("idle");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void verify(query);
  }

  function pickSuggestion(suggestion: string) {
    setQuery(suggestion);
    void verify(suggestion);
  }

  const busy = stage !== "idle";
  return (
    <form className="submit" onSubmit={submit}>
      <label htmlFor="app">App name or website</label>
      <div className="submit-row">
        <input
          id="app"
          list="catalog-names"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            // A note about what was typed before no longer applies once the text changes.
            if (problem && squash(event.target.value) !== squash(query)) setProblem(null);
          }}
          placeholder="Try Notion, or linear.app"
          autoComplete="off"
          spellCheck
          required
          minLength={2}
          maxLength={200}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? "app-check" : undefined}
        />
        <button type="submit" disabled={busy}>
          {stage === "checking" ? "Checking…" : stage === "starting" ? "Starting…" : "Get the guide"}
        </button>
      </div>
      <datalist id="catalog-names">
        {names.map((name) => <option key={name} value={name} />)}
      </datalist>
      <p className="small muted">We check the app exists first. If there's no guide yet, an agent investigates it live, which usually takes a few minutes.</p>
      {problem ? (
        <div id="app-check" className="form-error" role="alert">
          <p>{problem.message}</p>
          {problem.reason !== "format" && (problem.suggestion || (problem.reason === "spelling" && problem.canSearchAnyway)) ? (
            <div className="check-actions">
              {problem.suggestion ? (
                <button type="button" onClick={() => pickSuggestion(problem.suggestion!)} disabled={busy}>
                  Use {problem.suggestion}
                </button>
              ) : null}
              {problem.reason === "spelling" && problem.canSearchAnyway ? (
                <button type="button" onClick={() => void verify(query, true)} disabled={busy}>
                  No, search “{query.trim()}”
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </form>
  );
}
