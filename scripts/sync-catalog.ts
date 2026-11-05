import { writeFileSync } from "node:fs";

/** Snapshots Composio's managed OAuth directory, using the markdown version of the page. */
const SOURCE = "https://docs.composio.dev/toolkits/managed-auth.md";

const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`Directory returned HTTP ${response.status}`);
const markdown = await response.text();

const byoStart = markdown.search(/^## Bring your own OAuth app/m);
if (byoStart === -1) throw new Error("Directory format changed: no bring-your-own section");

const rows = [...markdown.matchAll(/^\| \[([^\]]+)\]\(([^)]+)\) \| `([^`]+)` \|$/gm)];
const entries = rows.map((row) => ({
  name: row[1]!,
  slug: row[3]!.toLowerCase(),
  status: row.index >= byoStart ? ("byo" as const) : ("managed" as const),
}));

const stated = [...markdown.matchAll(/^## .*\((\d+)\)$/gm)].map((match) => Number(match[1]));
const managed = entries.filter((entry) => entry.status === "managed").length;
if (stated[0] !== managed || stated[1] !== entries.length - managed) {
  throw new Error(`Parsed ${managed}/${entries.length - managed}, but the page states ${stated.join("/")}`);
}

writeFileSync(
  new URL("../data/composio-catalog.json", import.meta.url),
  `${JSON.stringify({ source: SOURCE.replace(/\.md$/, ""), fetchedAt: new Date().toISOString().slice(0, 10), entries }, null, 1)}\n`,
);
console.log(`Saved ${entries.length} toolkits: ${managed} managed, ${entries.length - managed} bring your own.`);
