"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export function SubmitForm({ names }: { names: string[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const result = (await response.json()) as { slug?: string; jobId?: string; error?: string };
      if (result.slug) return router.push(`/guides/${result.slug}`);
      if (result.jobId) return router.push(`/generate/${result.jobId}?app=${encodeURIComponent(query)}`);
      setError(result.error ?? "That didn't work. Please try again.");
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    }
    setBusy(false);
  }

  return (
    <form className="submit" onSubmit={submit}>
      <label htmlFor="app">App name or website</label>
      <div className="submit-row">
        <input
          id="app"
          list="catalog-names"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Try Notion, or linear.app"
          autoComplete="off"
          required
          minLength={2}
          maxLength={200}
        />
        <button type="submit" disabled={busy}>{busy ? "Starting…" : "Get the guide"}</button>
      </div>
      <datalist id="catalog-names">
        {names.map((name) => <option key={name} value={name} />)}
      </datalist>
      <p className="small muted">If there's no guide yet, an agent investigates the app live, which usually takes a few minutes.</p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </form>
  );
}
