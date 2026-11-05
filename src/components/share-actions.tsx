"use client";

import { useState } from "react";

export function ShareActions({ slug }: { slug: string }) {
  const [message, setMessage] = useState("");

  async function copy(text: () => Promise<string> | string, done: string) {
    try {
      await navigator.clipboard.writeText(await text());
      setMessage(done);
    } catch {
      setMessage("Couldn't copy here. Use the address bar or the Markdown link instead.");
    }
  }

  const markdownUrl = `/guides/${slug}/markdown`;
  return (
    <div className="share">
      <button type="button" onClick={() => copy(() => window.location.href, "Link copied.")}>Copy link</button>
      <button type="button" onClick={() => copy(async () => (await fetch(markdownUrl)).text(), "Markdown copied.")}>Copy as Markdown</button>
      <a href={markdownUrl}>View Markdown</a>
      <span className="small muted" role="status">{message}</span>
    </div>
  );
}
