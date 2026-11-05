# OAuth Trailhead

Tells a developer building an AI agent what it really takes to get a provider's OAuth app ready: how hard it is, how long it takes, what could block approval, and which parts an agent can do for them.

Look up an app and you get a shareable guide. If there's no guide yet, an agent investigates the app live and publishes one.

## Run it

Requires Node 20.9 or later.

```bash
npm install
cp .env.example .env   # add ANTHROPIC_API_KEY to enable live generation
npm run dev            # http://localhost:3000
```

The library works without a key, but live generation needs one.

| Command | What it does |
|---|---|
| `npm test` | Runs the unit and pipeline tests. They make no network or model calls. |
| `npm run sources:check` | Rebuilds the library guides, re-running every probe and looking for every quote on its live page. |
| `npm run catalog:sync` | Refreshes the snapshot of Composio's directory. |
| `npm run generate -- "Notion" "Linear"` | Generates guides from the command line. |

### Deploy

Deploy the `Dockerfile` to any host that runs a long-lived container (Railway, Render, Fly.io), with a persistent volume at `/data` and `ANTHROPIC_API_KEY` set. Don't use a serverless host: runs last several minutes and are held in memory.

## Key decisions

**Start with whether you need your own app at all.** Composio's directory lists 402 OAuth toolkits, and 127 have a managed app. For those, a developer can start today and only needs their own app for branding, extra scopes, dedicated quota or faster polling. Every guide answers this first.

**Rate the route, not the app.** "How hard is Gmail?" has no single answer. Sending mail, reading mail and internal use are very different jobs, so each guide compares routes.

**Rate difficulty with a fixed rule.** A route's hardest requirement sets its level, so ratings are comparable and explainable. If evidence can't rule out further gates, the rating is "Unclear" instead of an optimistic "Easy".

**Make claims earn their evidence label, in code:**

- `Tested` requires a real request made by our code, so the model can't award this label itself.
- `Sourced` requires a link, and code then looks for the cited passage on the live page. Passages under 4 words don't count.
- If that fails, a separate agent reads the page without seeing the draft. Contradicted claims are marked as disputed, and unconfirmed ones drop to `Inferred`.
- A wait only counts as provider-stated if the claim behind it survives.

**Say what's unknown.** Most providers don't publish approval times. Where we couldn't find one, the guide says "Unknown" instead of inventing a number.

**Give each step an owner, and explain handoffs.** Agents research, draft and check. People sign in, accept terms, handle secrets and verify businesses.

### How generation works

1. **Identify:** look the app up in the directory snapshot.
2. **Research:** an agent uses web search, web fetch and a read-only probe tool.
3. **Draft:** a second model call with no tools turns the notes into structured output.
4. **Verify:** check quotes in code, then get a second opinion on what remains.
5. **Publish:** save the guide and stream progress to the page throughout.

Prompts are in `src/lib/agent/prompts.ts`, and the evidence rules are in `src/lib/evidence.ts`.

Live runs use `claude-opus-5-5`, with Anthropic's server-side refusal fallback turned on. Override the model with `ANTHROPIC_MODEL`.

### Safety

- Fetched pages are treated as untrusted. The drafting step has no tools, and the research agent has read-only tools and no credentials.
- Agent-supplied URLs go through `src/lib/safe-fetch.ts`, which blocks private addresses, checks them at connection time to stop DNS rebinding, and re-checks each redirect.
- Each run is limited to 8 minutes and 10 probes. Generation is limited per day and per IP, because each run costs money.
- Stored source links must be http or https.

## Validation

See `/validation` in the app for the results and what checking changed, including a stale Xero limit, weak quotes that proved nothing, and docs served in Hindi based on location.

## Limitations

- **No real app was created with any provider**, and no approval was requested, because this was built without provider accounts. Steps come from documentation, and hands-on times are estimates. Doing a few real setups is the most valuable next step.
- **Probes are read-only HTTP requests.** They can show that OAuth metadata exists or a page requires sign-in, but not that a flow works end to end. The Playwright sign-up exploration in the original plan was cut because it added cost and fragility without getting past sign-in.
- **The library guides were researched in a supervised agent session**, not by the live pipeline, and no provider has confirmed them.
- **Pages rendered with JavaScript can't be quote-checked.** They fall back to the agent check, or stay `Inferred`.
- **Runs are in memory, on one server.** A restart loses runs in progress, though published guides persist. The IP limit trusts `x-forwarded-for`, so the daily cap is the real spending limit.
- **Guides don't refresh themselves.** Each shows when it was last checked.

## Getting to 100 guides

1. Pick apps from `data/composio-catalog.json`, favoring bring-your-own toolkits, because those developers have the most need.
2. Run `npm run generate` on each. The Batches API would reduce the cost of drafting and checking.
3. Review anything with `Unclear` ratings or many `Inferred` claims, and re-check on a schedule.
