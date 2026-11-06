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

export type Passage = { url: string; quote: string };

const PASSAGE_IDS = /^\W*P\d+(\W+P\d+)*\W*$/i;

/**
 * The model cites passages by id and code fills in the exact words and URL, so it can't reword a
 * quote or attach one to another page. A citation to a passage that doesn't exist is dropped.
 */
export function resolvePassages(claims: GuideDraft["claims"], passages: Map<string, Passage>): GuideDraft["claims"] {
  return claims.map((claim) => ({
    ...claim,
    sources: claim.sources.flatMap((source) => {
      if (!source.quote || !PASSAGE_IDS.test(source.quote)) return [source];
      const ids = source.quote.match(/P\d+/gi) ?? [];
      return ids.flatMap((id) => {
        const passage = passages.get(id.toUpperCase());
        return passage ? [{ title: source.title || passage.url, ...passage }] : [];
      });
    }),
  }));
}

/**
 * In live runs only code writes "tested" claims. A model can cite a real probe for something it never
 * showed: one marked PKCE support as tested using a discovery document from a company's online store.
 */
export function demoteModelTested(claims: GuideDraft["claims"]): GuideDraft["claims"] {
  return claims.map((claim) =>
    claim.label === "tested" ? { ...claim, label: claim.sources.length > 0 ? "sourced" : "inferred", probeRefs: [] } : claim,
  );
}

/** Writes "tested" claims directly from what probes saw, stating only what was observed. */
export function probeClaims(probes: Probe[]): GuideDraft["claims"] {
  const ran = probes.filter((probe) => probe.status !== null);
  const tested = (id: string, text: string, probeRefs: string[]): GuideDraft["claims"][number] => ({ id, text, label: "tested", sources: [], probeRefs });
  const result = ran
    .filter((probe) => /^(Publishes OAuth metadata|Serves OAuth metadata|Redirects to a sign-in page)/.test(probe.observation))
    .map((probe) => tested(`probe-${probe.id}`, `${probe.url}: ${probe.observation}`, [probe.id]));

  // Only a clear 404 counts as "not found". A foreign issuer or a redirect says nothing about this API.
  const discovery = ran.filter((probe) => probe.url.includes("/.well-known/"));
  const missing = discovery.filter((probe) => probe.status === 404);
  if (missing.length > 0 && !discovery.some((probe) => probe.observation.startsWith("Publishes OAuth metadata"))) {
    const urls = missing.map((probe) => probe.url).join(", ");
    result.push(tested("probe-no-discovery", `No OAuth discovery document was found at ${urls}, so endpoints must be taken from the provider's docs.`, missing.map((probe) => probe.id)));
  }
  return result;
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

const confirmedIds = (claims: Guide["claims"]) =>
  new Set(claims.filter((claim) => claim.label === "sourced" || claim.label === "tested").map((claim) => claim.id));

/**
 * Finding no gates doesn't show there are none. A path only stays self-serve if a claim that survived
 * checking says so, and otherwise its rating and wait both say that it's unclear.
 */
export function requireApprovalEvidence(paths: GuideDraft["paths"], claims: Guide["claims"]): GuideDraft["paths"] {
  const confirmed = confirmedIds(claims);
  return paths.map((path) => {
    if (path.gates.length > 0) return path;
    if (path.gatesKnown && path.wait.claimId !== null && confirmed.has(path.wait.claimId)) return path;
    return {
      ...path,
      gatesKnown: false,
      wait: path.wait.basis === "none" ? { minDays: null, maxDays: null, basis: "unknown" as const, note: "We couldn't confirm whether this route needs approval.", claimId: null } : path.wait,
    };
  });
}

const HANDOFF_FALLBACK = {
  you: "An agent can't do this for you, because it has no access to your account.",
  provider: "Only the provider can do this, so you have to wait for it.",
};

/** The prompt asks for a reason on every handoff, but the model sometimes leaves it out. */
export function explainHandoffs(paths: GuideDraft["paths"]): GuideDraft["paths"] {
  return paths.map((path) => ({
    ...path,
    steps: path.steps.map((step) => (step.owner === "agent" || step.handoffReason?.trim() ? step : { ...step, handoffReason: HANDOFF_FALLBACK[step.owner] })),
  }));
}

/** A wait can only be called provider-stated if the claim behind it survived checking. */
export function reconcileWaits(paths: GuideDraft["paths"], claims: Guide["claims"]): GuideDraft["paths"] {
  const ids = new Set(claims.map((claim) => claim.id));
  const keepKnown = (list: string[]) => list.filter((id) => ids.has(id));
  const confirmed = confirmedIds(claims);
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
