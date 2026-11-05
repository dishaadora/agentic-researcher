import { catalogStatus } from "./catalog";
import { CONNECT_STEPS, DECISION, WHEN_YOU_NEED_YOUR_OWN } from "./composio";
import type { Claim, Guide } from "./schema";
import { formatHours, formatWait, gateLabel, LEVEL_LABEL, scorePath } from "./score";

export const OWNER_LABEL = { agent: "Agent can do", you: "You do", provider: "Waiting on provider" } as const;
export const EVIDENCE_TEXT = { tested: "Tested", sourced: "Sourced", inferred: "Inferred", unknown: "Unknown" } as const;

const minutes = (range: { min: number; max: number } | null) => (range === null ? "wait" : range.min === range.max ? `${range.min} min` : `${range.min} to ${range.max} min`);

function claimLine(claim: Claim) {
  const link = claim.sources[0] ? ` ([${claim.sources[0].title}](${claim.sources[0].url}))` : "";
  return `- **${EVIDENCE_TEXT[claim.label]}:** ${claim.text}${link}`;
}

/** A portable copy of the guide, for pasting into a ticket or handing to a coding agent. */
export function guideToMarkdown(guide: Guide, baseUrl: string) {
  const status = catalogStatus(guide.name);
  const lines: string[] = [
    `# Setting up a ${guide.name} OAuth app`,
    "",
    `${guide.summary}`,
    "",
    `**Biggest risk:** ${guide.biggestRisk}`,
    "",
    `Guide: ${baseUrl}/guides/${guide.slug}. Last checked ${guide.generatedAt.slice(0, 10)}.`,
    "",
    `## ${DECISION[status].title}`,
    "",
    DECISION[status].body,
  ];
  if (status === "managed") {
    lines.push("", "Register your own app when:", "", ...WHEN_YOU_NEED_YOUR_OWN.map((item) => `- ${item}`));
  }

  for (const path of guide.paths) {
    const { level, reason } = scorePath(path);
    lines.push(
      "",
      `## ${path.name}`,
      "",
      `*${path.whenToUse}*`,
      "",
      `- **Difficulty:** ${LEVEL_LABEL[level]}. ${reason}`,
      `- **Hands-on time:** ${formatHours(path.handsOnHours)} (estimate)`,
      `- **Approval wait:** ${formatWait(path.wait)}. ${path.wait.note}`,
    );
    if (path.gates.length > 0) lines.push(`- **Requirements:** ${path.gates.map(gateLabel).join(", ")}`);
    lines.push("", "### Steps", "");
    path.steps.forEach((step, index) => {
      lines.push(`${index + 1}. **${step.title}** (${OWNER_LABEL[step.owner]}, ${minutes(step.minutes)})`, `   ${step.detail}`, `   - Done when: ${step.confirm}`);
      if (step.handoffReason) lines.push(`   - Why you: ${step.handoffReason}`);
    });
    if (path.blockers.length > 0) {
      lines.push("", "### If you get stuck", "");
      for (const blocker of path.blockers) lines.push(`- **${blocker.symptom}.** ${blocker.cause} ${blocker.action}`);
    }
  }

  if (guide.paths.length > 0) {
    lines.push("", "## Connect it to Composio", "", ...CONNECT_STEPS.map((step, index) => `${index + 1}. ${step}`));
  }
  if (guide.nuances.length > 0) {
    lines.push("", "## Good to know", "", ...guide.nuances.map((nuance) => `- **${nuance.title}.** ${nuance.detail}`));
  }
  lines.push("", "## Evidence", "", ...guide.claims.map(claimLine));
  if (guide.unknowns.length > 0) lines.push("", "## Still unknown", "", ...guide.unknowns.map((item) => `- ${item}`));
  return `${lines.join("\n")}\n`;
}
