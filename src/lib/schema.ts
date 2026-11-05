import { z } from "zod";

/** Only http(s) links may be stored, because source URLs are rendered as hrefs. */
export const isWebUrl = (value: string) => {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

export const EVIDENCE_LABELS = ["tested", "sourced", "inferred", "unknown"] as const;
export const OWNERS = ["agent", "you", "provider"] as const;
export const WAIT_BASES = ["provider_stated", "community_reported", "estimate", "none", "unknown"] as const;
export const GATES = [
  "paid_account",
  "fee",
  "provider_review",
  "business_verification",
  "customer_references",
  "partner_agreement",
  "sales_contact",
  "security_assessment",
  "usage_threshold",
] as const;

export const SourceSchema = z.strictObject({
  url: z.string().describe("Absolute https URL of the page this came from"),
  title: z.string(),
  quote: z
    .string()
    .nullable()
    .describe("Short passage copied word for word from the page, or null if there is no exact passage"),
});

export const RangeSchema = z.strictObject({ min: z.number(), max: z.number() });

export const ClaimDraftSchema = z.strictObject({
  id: z.string().describe("Short unique id such as c1"),
  text: z.string().describe("One factual statement a developer can rely on"),
  label: z.enum(EVIDENCE_LABELS),
  sources: z.array(SourceSchema),
  probeRefs: z.array(z.string()).describe("Ids of probes that directly observed this. Required when label is tested"),
});

export const StepSchema = z.strictObject({
  title: z.string(),
  owner: z.enum(OWNERS),
  detail: z.string(),
  minutes: RangeSchema.nullable().describe("Hands-on minutes, or null if the step is only waiting"),
  confirm: z.string().describe("How the developer knows this step worked"),
  handoffReason: z.string().nullable().describe("Why a person or the provider must do this. Null when owner is agent"),
  claimIds: z.array(z.string()),
});

export const BlockerSchema = z.strictObject({
  symptom: z.string(),
  cause: z.string(),
  action: z.string(),
  claimIds: z.array(z.string()),
});

export const WaitSchema = z.strictObject({
  minDays: z.number().nullable(),
  maxDays: z.number().nullable(),
  basis: z.enum(WAIT_BASES),
  note: z.string(),
  claimId: z.string().nullable().describe("Claim supporting a provider_stated or community_reported wait"),
});

export const PathSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  whenToUse: z.string(),
  gates: z.array(z.enum(GATES)).describe("Every approval or commercial gate on this path. Empty means self-serve"),
  gatesKnown: z.boolean().describe("False when evidence is too thin to say whether other gates exist"),
  handsOnHours: RangeSchema,
  wait: WaitSchema,
  steps: z.array(StepSchema),
  blockers: z.array(BlockerSchema),
});

export const NuanceSchema = z.strictObject({
  title: z.string(),
  detail: z.string(),
  claimIds: z.array(z.string()),
});

/** The part of a guide the model writes. Code adds everything else. */
export const GuideDraftSchema = z.strictObject({
  name: z.string(),
  website: z.string(),
  category: z.string(),
  oauthSupport: z.enum(["yes", "no", "unclear"]),
  summary: z.string().describe("Two sentences at most: the real shape of the job and its biggest risk"),
  biggestRisk: z.string(),
  paths: z.array(PathSchema),
  nuances: z.array(NuanceSchema),
  claims: z.array(ClaimDraftSchema),
  unknowns: z.array(z.string()).describe("Questions the research could not answer"),
});

export const ClaimCheckSchema = z.strictObject({
  status: z.enum(["quote_matched", "model_confirmed", "unverified", "contradicted", "not_checked"]),
  note: z.string().nullable(),
});

export const ProbeSchema = z.strictObject({
  id: z.string(),
  url: z.string(),
  status: z.number().nullable(),
  observation: z.string(),
  checkedAt: z.string(),
});

export const GuideSchema = GuideDraftSchema.extend({
  slug: z.string(),
  generatedAt: z.string(),
  origin: z.enum(["reviewed_seed", "live_agent"]),
  model: z.string().nullable(),
  probes: z.array(ProbeSchema),
  claims: z.array(ClaimDraftSchema.extend({ check: ClaimCheckSchema })),
});

export type Guide = z.infer<typeof GuideSchema>;
export type GuideDraft = z.infer<typeof GuideDraftSchema>;
export type Path = z.infer<typeof PathSchema>;
export type Claim = Guide["claims"][number];
export type Probe = z.infer<typeof ProbeSchema>;
export type Gate = (typeof GATES)[number];
export type Owner = (typeof OWNERS)[number];
export type WaitBasis = (typeof WAIT_BASES)[number];
