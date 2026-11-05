import type { Metadata } from "next";
import log from "../../../data/validation-log.json";
import validation from "../../../data/validation.json";

export const metadata: Metadata = { title: "How we checked | OAuth Trailhead" };

const RESULT_TEXT: Record<string, string> = {
  quote_matched: "Passage found on the page",
  agent_read_only: "Read by an agent, no passage matched",
  failed: "Couldn't confirm, shown as inferred",
  probe_ran: "Tested",
  probe_failed: "Test failed",
  inferred: "Inferred",
  unknown: "Unknown",
};

export default function ValidationPage() {
  const tally = (result: string) => validation.claims.filter((claim) => claim.result === result).length;
  const stats = [
    { value: tally("quote_matched"), label: "passages found word for word on the live page" },
    { value: tally("agent_read_only"), label: "read by an agent, but no exact passage to match" },
    { value: tally("probe_ran"), label: "observed directly with read-only requests" },
    { value: tally("failed"), label: "couldn't be confirmed, so shown as inferred" },
    { value: tally("unknown") + tally("inferred"), label: "stated openly as inferred or unknown" },
  ];
  return (
    <article className="guide">
      <header className="guide-head">
        <h1>How we checked these guides</h1>
        <p className="lede">Agents can write confident, wrong guidance, so each claim has to earn its label. Here's what that found across the five library guides on {validation.checkedAt.slice(0, 10)}. These guides were researched in a supervised agent session, and guides generated live are checked by the same rules.</p>
      </header>

      <ul className="stats">
        {stats.map((stat) => <li key={stat.label}><strong>{stat.value}</strong> {stat.label}</li>)}
      </ul>

      <section aria-labelledby="method">
        <h2 id="method">How a claim earns its label</h2>
        <ol>
          <li><strong>Tested</strong> needs a real request made by our code. The model can't award this label itself.</li>
          <li><strong>Sourced</strong> needs a link. Code then looks for the cited passage on the live page, and a passage under {4} words doesn't count.</li>
          <li>If that fails, a separate agent reads the page without seeing the draft. If the page contradicts the claim, it's marked as disputed. If it can't tell, the claim drops to <strong>Inferred</strong>.</li>
          <li>Difficulty comes from a fixed rule based on each route's hardest requirement, not the model's opinion.</li>
        </ol>
      </section>

      <section aria-labelledby="corrections">
        <h2 id="corrections">What checking changed</h2>
        <dl className="nuances">
          {log.corrections.map((item) => (
            <div key={item.title}><dt>{item.title}</dt><dd>{item.detail}</dd></div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="limits">
        <h2 id="limits">What we couldn't verify</h2>
        <ul>{log.unverified.map((item) => <li key={item}>{item}</li>)}</ul>
      </section>

      <section aria-labelledby="all-claims">
        <h2 id="all-claims">Every claim</h2>
        <div className="table-scroll">
          <table className="probes">
            <thead><tr><th scope="col">Guide</th><th scope="col">Claim</th><th scope="col">Result</th></tr></thead>
            <tbody>
              {validation.claims.map((claim) => (
                <tr key={`${claim.guide}-${claim.claim}`}>
                  <td>{claim.guide}</td>
                  <td>{claim.url ? <a href={claim.url} rel="noopener noreferrer" target="_blank">{claim.text}</a> : claim.text}</td>
                  <td>{RESULT_TEXT[claim.result] ?? claim.result}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </article>
  );
}
