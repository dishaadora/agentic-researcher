import type { Claim, Owner } from "@/lib/schema";
import { EVIDENCE_TEXT, OWNER_LABEL } from "@/lib/markdown";
import type { Level } from "@/lib/score";

/** Shapes follow trail-rating convention, so difficulty is readable without relying on color. */
const SHAPE: Record<Level, string> = { easy: "●", moderate: "■", hard: "◆", very_hard: "◆◆", gated: "✕", unclear: "?" };

export function DifficultyMark({ level }: { level: Level }) {
  return <span className={`mark mark-${level}`} aria-hidden="true">{SHAPE[level]}</span>;
}

export function OwnerTag({ owner }: { owner: Owner }) {
  return <span className={`owner owner-${owner}`}>{OWNER_LABEL[owner]}</span>;
}

export function EvidenceChip({ claim }: { claim: Claim }) {
  return (
    <a className={`chip chip-${claim.label}`} href={`#claim-${claim.id}`} title={claim.text}>
      {EVIDENCE_TEXT[claim.label]}
    </a>
  );
}

const CHECK_TEXT: Record<Claim["check"]["status"], string | null> = {
  quote_matched: "Passage found on the page",
  model_confirmed: "Read by an agent, no exact passage matched",
  unverified: "Couldn't be confirmed",
  contradicted: "Disputed by the source",
  not_checked: null,
};

export const checkText = (claim: Claim) => CHECK_TEXT[claim.check.status];
