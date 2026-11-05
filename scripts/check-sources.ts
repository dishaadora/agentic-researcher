import { mkdirSync, writeFileSync } from "node:fs";
import { COMPOSIO_FACTS } from "../src/lib/composio";
import { probeUrl } from "../src/lib/probe";
import { checkQuote } from "../src/lib/quote-check";
import { GuideSchema, type Guide, type Probe } from "../src/lib/schema";
import { SEEDS } from "./seed-guides";

/**
 * Builds the reviewed guides from scripts/seed-guides.ts using real checks: runs each probe and
 * looks for each quote on its live page. Results go to data/guides and data/validation.json.
 */
const today = new Date().toISOString();
const outDir = new URL("../data/guides/", import.meta.url);
mkdirSync(outDir, { recursive: true });

type Row = { guide: string; claim: string; text: string; url: string | null; quote: string | null; result: string; note: string | null };
const rows: Row[] = [];
const probeRows: (Probe & { guide: string })[] = [];

for (const seed of SEEDS) {
  const { probeUrls, claims, ...rest } = seed;
  const probes: Probe[] = [];
  for (const [index, url] of probeUrls.entries()) {
    const probe = await probeUrl(url, `p${index + 1}`);
    probes.push(probe);
    probeRows.push({ ...probe, guide: seed.name });
  }

  const checked: Guide["claims"] = [];
  for (const { reviewed, ...claim } of claims) {
    const firstSource = claim.sources[0] ?? null;
    const row: Row = { guide: seed.name, claim: claim.id, text: claim.text, url: firstSource?.url ?? null, quote: firstSource?.quote ?? null, result: "", note: null };
    let check: Guide["claims"][number]["check"] = { status: "not_checked", note: null };
    let label = claim.label;

    if (claim.label === "tested") {
      const failed = claim.probeRefs.filter((ref) => probes.find((probe) => probe.id === ref)?.status == null);
      if (failed.length > 0) label = "unknown";
      row.result = failed.length > 0 ? "probe_failed" : "probe_ran";
    } else if (claim.label === "sourced" && firstSource) {
      const result = firstSource.quote ? await checkQuote(firstSource.url, firstSource.quote) : null;
      if (result?.status === "matched") {
        check = { status: "quote_matched", note: null };
        row.result = "quote_matched";
      } else if (reviewed) {
        check = { status: "model_confirmed", note: reviewed };
        row.result = "agent_read_only";
        row.note = result ? `${reviewed} Automatic check: ${result.note}` : reviewed;
      } else {
        check = { status: "unverified", note: result?.note ?? "No exact passage was available to check." };
        label = "inferred";
        row.result = "failed";
        row.note = check.note;
      }
    } else {
      row.result = claim.label;
    }
    rows.push(row);
    checked.push({ ...claim, label, check });
  }

  const guide = GuideSchema.parse({ ...rest, claims: checked, generatedAt: today, origin: "reviewed_seed", model: null, probes });
  writeFileSync(new URL(`${seed.slug}.json`, outDir), `${JSON.stringify(guide, null, 2)}\n`);
  const tally = (name: string) => rows.filter((row) => row.guide === seed.name && row.result === name).length;
  console.log(`${seed.name}: ${tally("quote_matched")} matched, ${tally("agent_read_only")} agent-read, ${tally("failed")} failed, ${tally("probe_ran")} tested`);
}

const composio = [];
for (const fact of COMPOSIO_FACTS) {
  const result = await checkQuote(fact.url, fact.quote);
  composio.push({ id: fact.id, text: fact.text, url: fact.url, quote: fact.quote, result: result.status });
  console.log(`Composio ${fact.id}: ${result.status}`);
}

writeFileSync(new URL("../data/validation.json", import.meta.url), `${JSON.stringify({ checkedAt: today, claims: rows, probes: probeRows, composio }, null, 1)}\n`);
for (const row of rows.filter((candidate) => ["failed", "probe_failed", "agent_read_only"].includes(candidate.result))) {
  console.log(`  ${row.result.padEnd(16)} ${row.guide}/${row.claim}: ${row.note ?? ""}`);
}
for (const probe of probeRows) console.log(`  probe ${String(probe.status).padEnd(4)} ${probe.url}\n        ${probe.observation.slice(0, 150)}`);
