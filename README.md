# OAuth Trailhead

Tells a developer building an AI agent what it really takes to get a provider's OAuth app ready: how hard it is, how long it takes, what could block approval, and which parts an agent can do for them.

Look up an app and you get a shareable guide. If there's no guide yet, an agent investigates the app live and publishes one.

**Live site:** https://oauth-trailhead.onrender.com/

## Run it

Requires Node 20.9 or later.

```bash
npm install
cp .env.example .env   # add GROQ_API_KEY to enable live generation
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

Deploy the `Dockerfile` to any host that runs a long-lived container (Railway, Render, Fly.io), with a persistent volume at `/data` and `GROQ_API_KEY` set. Don't use a serverless host: runs last several minutes and are held in memory.

## Key decisions

**Start with whether you need your own app at all.** Composio's directory lists 402 OAuth toolkits, and 127 have a managed app. For those, a developer can start today and only needs their own app for branding, extra scopes, dedicated quota or faster polling. Every guide answers this first.

**Rate the route, not the app.** "How hard is Gmail?" has no single answer. Sending mail, reading mail and internal use are very different jobs, so each guide compares routes.

**Rate difficulty with a fixed rule.** A route's hardest requirement sets its level, so ratings are comparable and explainable. If evidence can't rule out further gates, the rating is "Unclear" instead of an optimistic "Easy".

**Make claims earn their evidence label, in code:**

- `Tested` requires a real request made by our code, so the model can't award this label itself. In live runs, code picks the checks and writes these claims from what it observed.
- `Sourced` requires a link, and code then looks for the cited passage on the live page. Passages under 4 words don't count.
- In live runs, the model cites numbered passages and code fills in the exact words and URL. Testing showed that asking the model to copy quotes didn't work: 9 of 13 weren't on the cited page.
- A separate agent then checks that the text supports each claim, without seeing the draft, because a real quote can be attached to the wrong claim. Contradicted claims are marked as disputed, and unconfirmed ones drop to `Inferred`.
- A wait only counts as provider-stated if the claim behind it survives.
- In live runs, a route with no gates is only rated `Easy` if a claim that survived checking says no approval is needed. Otherwise it's `Unclear`, with an unknown wait.

**Say what's unknown.** Most providers don't publish approval times. Where we couldn't find one, the guide says "Unknown" instead of inventing a number.

**Give each step an owner, and explain handoffs.** Agents research, draft and check. People sign in, accept terms, handle secrets and verify businesses.

### How generation works

1. **Identify:** look the app up in the directory snapshot.
2. **Research:** an agent finds links with Groq's browser search, then reads pages with our own tool. Given browser search directly, the model read pages inside Groq and cited opaque markers, so its notes had no URLs or quotes that could be checked. Code then runs read-only probes on the provider's discovery documents and setup links.
3. **Draft:** a second model call with no tools turns the notes into structured output, and code fills in the cited passages.
4. **Verify:** check quotes in code, then get a second opinion on every sourced claim. Our code supplies the text, so this model call has no tools either.
5. **Publish:** save the guide and stream progress to the page throughout.

Prompts are in `src/lib/agent/prompts.ts`, and the evidence rules are in `src/lib/evidence.ts`.

Live runs use `openai/gpt-oss-120b` on Groq. Override it with `GROQ_MODEL`, but browser search only runs on Groq's gpt-oss models.

Groq's base limits for this model are 8K tokens per minute and 200K per day, and that shaped the pipeline. A request can't exceed the per-minute limit, so research reads excerpts instead of whole pages, and notes and guides have length caps. Set `GROQ_TOKENS_PER_MINUTE` to your account's limit, and each step's budget scales from it.

### Safety

- Fetched pages are treated as untrusted. The drafting step has no tools, and the research agent has read-only tools and no credentials.
- Agent-supplied URLs go through `src/lib/safe-fetch.ts`, which blocks private addresses, checks them at connection time to stop DNS rebinding, and re-checks each redirect.
- Each run is limited to 8 minutes, 2 searches, 10 probes and 5 page reads. Generation is limited per day and per IP, because each run uses up a limited token allowance.
- Stored source links must be http or https.

## Validation

See `/validation` in the app for the results and what checking changed, including a stale Xero limit, weak quotes that proved nothing, and docs served in Hindi based on location.

## Limitations

- **No real app was created with any provider**, and no approval was requested, because this was built without provider accounts. Steps come from documentation, and hands-on times are estimates. Doing a few real setups is the most valuable next step.
- **Probes are read-only HTTP requests.** They can show that OAuth metadata exists or a page requires sign-in, but not that a flow works end to end. The Playwright sign-up exploration in the original plan was cut because it added cost and fragility without getting past sign-in.
- **The library guides were researched in a supervised agent session**, not by the live pipeline, and no provider has confirmed them.
- **Live guides are shorter than the library guides.** Token limits cap them at 3 paths and 15 claims, and research runs at most 2 searches and reads at most 5 pages. At base limits, a day's tokens cover only a few runs, and runs pause when they reach the per-minute limit.
- **Many live claims stay `Inferred`.** In a test run on Withings, 6 of 15 claims ended up `Sourced` or `Tested`, and the other 9 were shown as inferred. An `Easy` rating needs one surviving claim that no approval is needed, but that claim may only cover part of the route, so check it. Many providers never state this, so some self-serve routes will show as `Unclear`.
- **Pages rendered with JavaScript can't be quote-checked.** They fall back to the agent check, or stay `Inferred`.
- **Runs are in memory, on one server.** A restart loses runs in progress, though published guides persist. The IP limit trusts `x-forwarded-for`, so the daily cap is the real spending limit.
- **Guides don't refresh themselves.** Each shows when it was last checked.

## Getting to 100 guides

1. Pick apps from `data/composio-catalog.json`, favoring bring-your-own toolkits, because those developers have the most need.
2. Run `npm run generate` on each, a few per day at base limits or more on a higher Groq plan.
3. Review anything with `Unclear` ratings or many `Inferred` claims, and re-check on a schedule.
