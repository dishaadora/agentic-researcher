import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { checkText, DifficultyMark, EvidenceChip, OwnerTag } from "@/components/badges";
import { PathExplorer, type PathRow } from "@/components/path-explorer";
import { ShareActions } from "@/components/share-actions";
import { catalogStatus, CATALOG } from "@/lib/catalog";
import { CONNECT_STEPS, DECISION, WHEN_YOU_NEED_YOUR_OWN } from "@/lib/composio";
import { evidenceCounts } from "@/lib/evidence";
import { EVIDENCE_TEXT } from "@/lib/markdown";
import { EVIDENCE_LABELS, isWebUrl, type Claim, type Guide, type Path } from "@/lib/schema";
import { formatHours, formatWait, gateLabel, LEVEL_LABEL, scorePath } from "@/lib/score";
import { getGuide } from "@/lib/store";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const guide = getGuide((await params).slug);
  return guide ? { title: `${guide.name} OAuth setup guide`, description: guide.summary } : { title: "Guide not found" };
}

const LABEL_MEANING = {
  tested: "We observed this directly with a read-only request.",
  sourced: "A cited page says this.",
  inferred: "Reasoned from other facts, or the source couldn't be confirmed.",
  unknown: "We couldn't establish this.",
};

function Chips({ ids, claims }: { ids: string[]; claims: Map<string, Claim> }) {
  const found = ids.flatMap((id) => claims.get(id) ?? []);
  if (found.length === 0) return null;
  return <span className="chips">{found.map((claim) => <EvidenceChip key={claim.id} claim={claim} />)}</span>;
}

function stepTime(range: { min: number; max: number } | null) {
  if (range === null) return "Wait";
  const one = (value: number) => (value >= 120 ? `${Math.round(value / 60)} hr` : `${value} min`);
  return range.min === range.max ? one(range.min) : `${one(range.min)} to ${one(range.max)}`;
}

function PathPanel({ path, claims }: { path: Path; claims: Map<string, Claim> }) {
  const { level, reason } = scorePath(path);
  return (
    <section className="path-panel" aria-label={path.name}>
      <h2>{path.name}</h2>
      <p className="rating-line"><DifficultyMark level={level} /> <strong>{LEVEL_LABEL[level]}.</strong> {reason}</p>
      {path.wait.basis !== "none" ? <p><strong>Approval wait:</strong> {formatWait(path.wait)}. {path.wait.note}</p> : null}
      {path.gates.length > 0 ? (
        <ul className="gates">{path.gates.map((gate) => <li key={gate}>{gateLabel(gate)}</li>)}</ul>
      ) : null}

      <h3>What to do</h3>
      <ol className="steps">
        {path.steps.map((step) => (
          <li key={step.title} className={`step step-${step.owner}`}>
            <div className="step-head">
              <h4>{step.title}</h4>
              <span className="step-meta"><OwnerTag owner={step.owner} /> <span className="small muted">{stepTime(step.minutes)}</span></span>
            </div>
            <p>{step.detail}</p>
            <p className="small"><strong>Done when:</strong> {step.confirm}</p>
            {step.handoffReason ? <p className="small muted">{step.handoffReason}</p> : null}
            <Chips ids={step.claimIds} claims={claims} />
          </li>
        ))}
      </ol>

      {path.blockers.length > 0 ? (
        <>
          <h3>If you get stuck</h3>
          <dl className="blockers">
            {path.blockers.map((blocker) => (
              <div key={blocker.symptom}>
                <dt>{blocker.symptom}</dt>
                <dd>{blocker.cause} <strong>What to do:</strong> {blocker.action} <Chips ids={blocker.claimIds} claims={claims} /></dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}
    </section>
  );
}

function EvidenceReport({ guide }: { guide: Guide }) {
  const counts = evidenceCounts(guide.claims);
  return (
    <section id="evidence" aria-labelledby="evidence-title">
      <h2 id="evidence-title">Evidence</h2>
      <p>
        {guide.origin === "live_agent"
          ? `An agent generated this guide on ${guide.generatedAt.slice(0, 10)}, and no person has reviewed it.`
          : `Researched in a supervised agent session, then re-checked against live pages by script on ${guide.generatedAt.slice(0, 10)}.`}{" "}
        No app was created and no approval was requested. Hands-on times are estimates.
      </p>
      {EVIDENCE_LABELS.map((label) => {
        const list = guide.claims.filter((claim) => claim.label === label);
        if (list.length === 0) return null;
        return (
          <div key={label} className="claim-group">
            <h3><span className={`chip chip-${label}`}>{EVIDENCE_TEXT[label]}</span> {counts[label]} <span className="small muted">{LABEL_MEANING[label]}</span></h3>
            <ul className="claims">
              {list.map((claim) => (
                <li key={claim.id} id={`claim-${claim.id}`}>
                  {claim.text}
                  {claim.sources.filter((source) => isWebUrl(source.url)).map((source) => (
                    <span key={source.url} className="claim-source small">
                      <a href={source.url} rel="noopener noreferrer nofollow" target="_blank">{source.title}</a>
                      {source.quote && claim.check.status === "quote_matched" ? <q>{source.quote}</q> : null}
                    </span>
                  ))}
                  {checkText(claim) ? <span className="small muted claim-check">{checkText(claim)}{claim.check.note ? `: ${claim.check.note}` : ""}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        );
      })}

      {guide.probes.length > 0 ? (
        <>
          <h3>What we tested</h3>
          <div className="table-scroll">
            <table className="probes">
              <thead><tr><th scope="col">Request</th><th scope="col">Status</th><th scope="col">What we saw</th></tr></thead>
              <tbody>
                {guide.probes.map((probe) => (
                  <tr key={probe.id}><td><code>{probe.url}</code></td><td>{probe.status ?? "Failed"}</td><td>{probe.observation}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {guide.unknowns.length > 0 ? (
        <>
          <h3>Still unknown</h3>
          <ul>{guide.unknowns.map((item) => <li key={item}>{item}</li>)}</ul>
        </>
      ) : null}
    </section>
  );
}

export default async function GuidePage({ params }: Props) {
  const guide = getGuide((await params).slug);
  if (!guide) notFound();

  const claims = new Map(guide.claims.map((claim) => [claim.id, claim]));
  const status = catalogStatus(guide.name);
  const decision = DECISION[status];
  const rows: PathRow[] = guide.paths.map((path) => {
    const { level } = scorePath(path);
    return {
      id: path.id,
      name: path.name,
      whenToUse: path.whenToUse,
      rating: <span className="nowrap"><DifficultyMark level={level} /> {LEVEL_LABEL[level]}</span>,
      hours: formatHours(path.handsOnHours),
      wait: formatWait(path.wait),
    };
  });
  const panels = Object.fromEntries(guide.paths.map((path) => [path.id, <PathPanel key={path.id} path={path} claims={claims} />]));

  return (
    <article className="guide">
      <header className="guide-head">
        <p className="small muted">
          {guide.category} · Last checked {guide.generatedAt.slice(0, 10)}
          {guide.origin === "live_agent" ? <span className="tag-live"> · Generated by agent, not reviewed</span> : null}
        </p>
        <h1>Setting up a {guide.name} OAuth app</h1>
        <p className="lede">{guide.summary}</p>
        <p className="risk"><strong>Biggest risk:</strong> {guide.biggestRisk}</p>
        <ShareActions slug={guide.slug} />
      </header>

      {guide.oauthSupport !== "yes" ? (
        <aside className="decision decision-warn">
          <h2>{guide.oauthSupport === "no" ? "This app doesn't appear to support OAuth" : "We couldn't confirm OAuth support"}</h2>
          <p>Check the evidence below before you plan around this.</p>
        </aside>
      ) : null}

      <aside className={`decision decision-${status}`}>
        <h2>{decision.title}</h2>
        <p>{decision.body}</p>
        {status === "managed" ? (
          <>
            <p className="small"><strong>Register your own app when:</strong></p>
            <ul className="small">{WHEN_YOU_NEED_YOUR_OWN.map((item) => <li key={item}>{item}</li>)}</ul>
          </>
        ) : null}
        <p className="small muted">
          From <a href={CATALOG.source} rel="noopener noreferrer" target="_blank">Composio's directory</a>, snapshot of {CATALOG.fetchedAt}. A listed toolkit may support other auth methods too, so check its page.
        </p>
      </aside>

      {rows.length > 0 ? (
        <section aria-labelledby="routes">
          <h2 id="routes">Choose your route</h2>
          <PathExplorer rows={rows} panels={panels} />
        </section>
      ) : null}

      {rows.length > 0 ? (
        <section aria-labelledby="connect">
          <h2 id="connect">Connect it to Composio</h2>
          <p>Once you have a client ID and secret:</p>
          <ol>{CONNECT_STEPS.map((step) => <li key={step}>{step}</li>)}</ol>
        </section>
      ) : null}

      {guide.nuances.length > 0 ? (
        <section aria-labelledby="nuances">
          <h2 id="nuances">Good to know</h2>
          <dl className="nuances">
            {guide.nuances.map((nuance) => (
              <div key={nuance.title}>
                <dt>{nuance.title}</dt>
                <dd>{nuance.detail} <Chips ids={nuance.claimIds} claims={claims} /></dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <EvidenceReport guide={guide} />
    </article>
  );
}
