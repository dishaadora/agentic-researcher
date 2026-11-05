import type { Gate, Guide, Path } from "./schema";

export type Level = "easy" | "moderate" | "hard" | "very_hard" | "gated" | "unclear";

export const LEVEL_LABEL: Record<Level, string> = {
  easy: "Easy",
  moderate: "Moderate",
  hard: "Hard",
  very_hard: "Very hard",
  gated: "Gated",
  unclear: "Unclear",
};

const GATE_INFO: Record<Gate, { weight: number; label: string }> = {
  paid_account: { weight: 1, label: "Needs a paid account" },
  fee: { weight: 1, label: "Has a fee" },
  provider_review: { weight: 2, label: "Provider reviews your app" },
  business_verification: { weight: 3, label: "Business verification" },
  customer_references: { weight: 3, label: "Needs existing customers" },
  partner_agreement: { weight: 3, label: "Partner application" },
  sales_contact: { weight: 3, label: "Must contact the provider" },
  security_assessment: { weight: 4, label: "Security assessment" },
  usage_threshold: { weight: 5, label: "Minimum usage threshold" },
};

const LEVEL_BY_WEIGHT: Level[] = ["easy", "easy", "moderate", "hard", "very_hard", "gated"];
const LEVEL_ORDER: Level[] = ["easy", "moderate", "hard", "very_hard", "gated", "unclear"];

export const gateLabel = (gate: Gate) => GATE_INFO[gate].label;

/**
 * Difficulty comes from a fixed rule rather than the model's opinion, so two guides are comparable
 * and the rating can be explained. The hardest gate sets the level; if the evidence can't rule
 * out further gates, the path is unclear rather than optimistically easy.
 */
export function scorePath(path: Pick<Path, "gates" | "gatesKnown">): { level: Level; reason: string } {
  if (!path.gatesKnown) {
    return { level: "unclear", reason: "The evidence wasn't enough to rule out approval requirements." };
  }
  if (path.gates.length === 0) {
    return { level: "easy", reason: "Self-serve, with no provider approval found." };
  }
  const heaviest = Math.max(...path.gates.map((gate) => GATE_INFO[gate].weight));
  const labels = path.gates.map(gateLabel).join(", ");
  return { level: LEVEL_BY_WEIGHT[heaviest] ?? "gated", reason: `Rated by its hardest requirement. Includes: ${labels}.` };
}

/** Range of difficulty across a guide's paths, for library cards. */
export function scoreGuide(guide: Pick<Guide, "paths" | "oauthSupport">): { from: Level; to: Level } {
  const levels = guide.paths.map((path) => scorePath(path).level);
  if (guide.oauthSupport !== "yes" || levels.length === 0) return { from: "unclear", to: "unclear" };
  const sorted = [...levels].sort((a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b));
  return { from: sorted[0]!, to: sorted[sorted.length - 1]! };
}

export function formatDifficultyRange({ from, to }: { from: Level; to: Level }) {
  return from === to ? LEVEL_LABEL[from] : `${LEVEL_LABEL[from]} to ${LEVEL_LABEL[to].toLowerCase()}`;
}

export function formatHours({ min, max }: { min: number; max: number }) {
  const one = (hours: number) => (hours < 1 ? `${Math.round(hours * 60)} min` : `${hours} hr`);
  return min === max ? one(min) : `${one(min)} to ${one(max)}`;
}

export function formatWait(wait: Path["wait"]) {
  if (wait.basis === "none") return "No approval wait";
  if (wait.basis === "unknown" || (wait.minDays === null && wait.maxDays === null)) return "Unknown";
  const range =
    wait.minDays === wait.maxDays
      ? `${wait.maxDays} days`
      : wait.minDays === null
        ? `Up to ${wait.maxDays} days`
        : wait.maxDays === null
          ? `${wait.minDays}+ days`
          : `${wait.minDays} to ${wait.maxDays} days`;
  return wait.basis === "estimate" ? `About ${range.toLowerCase()} (estimate)` : range;
}
