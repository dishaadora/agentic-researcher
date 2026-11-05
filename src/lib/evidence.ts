import { isWebUrl, type Claim, type Guide, type GuideDraft, type Probe } from "./schema";
import { checkQuote } from "./quote-check";

export type CheckResult = Claim["check"];

/**
 * Enforces the evidence rules in code, so the model can't award itself a stronger label:
 * "tested" needs a real probe, and "sourced" needs a real link.
 */
export function normalizeClaims(draft: GuideDraft, probes: Probe[]): GuideDraft["claims"] {
  const probeIds = new Set(probes.map((probe) => probe.id));
  return draft.claims.map((claim) => {
    const sources = claim.sources.filter((source) => isWebUrl(source.url));
    const probeRefs = claim.probeRefs.filter((id) => probeIds.has(id));
    let label = claim.label;
    if (label === "tested" && probeRefs.length === 0) label = sources.length > 0 ? "sourced" : "inferred";
    if (label === "sourced" && sources.length === 0) label = "inferred";
    return { ...claim, label, sources, probeRefs };
  });
}

/** Checks each sourced claim by looking for its quote on the page, with no model involved. */
export async function checkClaimQuotes(claims: GuideDraft["claims"], signal?: AbortSignal) {
  const results = new Map<string, CheckResult>();
  const sourced = claims.filter((claim) => claim.label === "sourced");
  const queue = [...sourced];
  const worker = async () => {
    for (let claim = queue.shift(); claim; claim = queue.shift()) {
      results.set(claim.id, await checkClaim(claim, signal));
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return results;
}

async function checkClaim(claim: GuideDraft["claims"][number], signal?: AbortSignal): Promise<CheckResult> {
  const quoted = claim.sources.filter((source) => source.quote);
  if (quoted.length === 0) return { status: "unverified", note: "The source has no exact passage to check." };
  let note: string | null = null;
  for (const source of quoted) {
    const result = await checkQuote(source.url, source.quote!, signal);
    if (result.status === "matched") return { status: "quote_matched", note: null };
    note = result.note;
  }
  return { status: "unverified", note };
}

/** Failed checks weaken a claim. Contradicted claims stop being presented as facts. */
export function applyChecks(claims: GuideDraft["claims"], checks: Map<string, CheckResult>): Guide["claims"] {
  return claims.map((claim) => {
    const check = checks.get(claim.id) ?? { status: "not_checked" as const, note: null };
    if (check.status === "contradicted") {
      return { ...claim, label: "unknown", text: `Disputed: ${claim.text}`, check };
    }
    if (claim.label === "sourced" && check.status === "unverified") {
      return { ...claim, label: "inferred", check };
    }
    return { ...claim, check };
  });
}

/** A wait can only be called provider-stated if the claim behind it survived checking. */
export function reconcileWaits(paths: GuideDraft["paths"], claims: Guide["claims"]): GuideDraft["paths"] {
  const ids = new Set(claims.map((claim) => claim.id));
  const keepKnown = (list: string[]) => list.filter((id) => ids.has(id));
  const confirmed = new Set(claims.filter((claim) => claim.label === "sourced" || claim.label === "tested").map((claim) => claim.id));
  return paths.map((path) => {
    const { wait } = path;
    const needsSupport = wait.basis === "provider_stated" || wait.basis === "community_reported";
    const supported = wait.claimId !== null && confirmed.has(wait.claimId);
    return {
      ...path,
      wait: needsSupport && !supported ? { ...wait, basis: wait.minDays === null && wait.maxDays === null ? ("unknown" as const) : ("estimate" as const), claimId: null } : wait,
      steps: path.steps.map((step) => ({ ...step, claimIds: keepKnown(step.claimIds) })),
      blockers: path.blockers.map((blocker) => ({ ...blocker, claimIds: keepKnown(blocker.claimIds) })),
    };
  });
}

export const evidenceCounts = (claims: Pick<Claim, "label">[]) => ({
  tested: claims.filter((claim) => claim.label === "tested").length,
  sourced: claims.filter((claim) => claim.label === "sourced").length,
  inferred: claims.filter((claim) => claim.label === "inferred").length,
  unknown: claims.filter((claim) => claim.label === "unknown").length,
});
