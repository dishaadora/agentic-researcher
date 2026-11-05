import type { GuideDraft } from "../src/lib/schema";

/**
 * Hand-reviewed guides, researched in a Claude Code session from the pages cited here.
 * `npm run sources:check` builds them into data/guides, re-fetching each source and running each
 * probe, so check results and "tested" labels always come from a real run.
 *
 * `reviewed` records that the researching agent read the page but no exact passage could be
 * machine-matched, usually because the site renders with JavaScript. The UI shows this separately.
 */
export type SeedClaim = GuideDraft["claims"][number] & { reviewed?: string };
export type Seed = Omit<GuideDraft, "claims"> & { slug: string; claims: SeedClaim[]; probeUrls: string[] };

const source = (id: string, text: string, url: string, title: string, quote: string | null, reviewed?: string): SeedClaim => ({
  id,
  text,
  label: "sourced",
  sources: [{ url, title, quote }],
  probeRefs: [],
  ...(reviewed ? { reviewed } : {}),
});
const tested = (id: string, text: string, ...probeRefs: string[]): SeedClaim => ({ id, text, label: "tested", sources: [], probeRefs });
const inferred = (id: string, text: string): SeedClaim => ({ id, text, label: "inferred", sources: [], probeRefs: [] });
const unknown = (id: string, text: string): SeedClaim => ({ id, text, label: "unknown", sources: [], probeRefs: [] });

const NO_WAIT = { minDays: null, maxDays: null, basis: "none" as const, note: "No approval step on this path.", claimId: null };

const GH_CREATE = "https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app";
const GH_AUTH = "https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps";
const GH_DIFF = "https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps";

const github: Seed = {
  slug: "github",
  name: "GitHub",
  website: "https://github.com",
  category: "Developer tools",
  oauthSupport: "yes",
  summary: "Registering takes minutes and we found no approval step. The real decision is whether to use an OAuth app at all, because its scopes are broad and GitHub prefers GitHub Apps.",
  biggestRisk: "An OAuth app's repo scope also grants access to code, which is a lot of power for an agent that only needs to read issues.",
  paths: [
    {
      id: "oauth-app",
      name: "Register an OAuth app",
      whenToUse: "You want your own name on the consent screen and broad scopes are acceptable.",
      gates: [],
      gatesKnown: true,
      handsOnHours: { min: 0.25, max: 0.5 },
      wait: NO_WAIT,
      steps: [
        { title: "Choose the scopes your agent actually needs", owner: "agent", detail: "List the agent's actions and map them to scopes. If the only fit is repo, read the note on GitHub Apps first.", minutes: { min: 5, max: 10 }, confirm: "You have a short written list of scopes and a reason for each.", handoffReason: null, claimIds: ["gh-repo", "gh-prefer"] },
        { title: "Register the app", owner: "you", detail: "Go to Settings, Developer settings, OAuth apps, New OAuth App. Enter an application name, homepage URL and callback URL. Use the redirect URI from your Composio auth config as the callback.", minutes: { min: 5, max: 5 }, confirm: "The app page shows a client ID.", handoffReason: "This requires signing in to your GitHub account.", claimIds: ["gh-fields", "gh-signin"] },
        { title: "Generate a client secret", owner: "you", detail: "Generate a secret on the app page and paste it straight into Composio.", minutes: { min: 2, max: 2 }, confirm: "Your Composio auth config saves and shows an ac_ ID.", handoffReason: "The secret should only be handled by you, not passed through an agent.", claimIds: [] },
        { title: "Connect a test account", owner: "you", detail: "Complete one connection with your own account and check the consent screen shows your app's name.", minutes: { min: 3, max: 5 }, confirm: "The agent can make one API call as that user.", handoffReason: "A person has to approve the consent screen.", claimIds: [] },
      ],
      blockers: [
        { symptom: "The redirect fails with a redirect_uri mismatch", cause: "With wildcard matching off, the redirect URL must exactly match the callback URL.", action: "Copy the URI from Composio again. Check for trailing slashes and http versus https.", claimIds: ["gh-redirect"] },
        { symptom: "Older sessions start failing after repeated connections", cause: "GitHub keeps ten tokens per user, app and scope combination, and revokes older ones beyond that.", action: "Reuse stored connections so each reconnect doesn't mint a new token, especially in testing.", claimIds: ["gh-tokens"] },
      ],
    },
  ],
  nuances: [
    { title: "GitHub prefers GitHub Apps", detail: "OAuth apps remain the right choice mainly when you need enterprise-level resources. Check that Composio's toolkit supports the flow you choose before you commit.", claimIds: ["gh-prefer"] },
    { title: "Broad scopes", detail: "Reading issues or pull requests with an OAuth app takes the repo scope, which also covers code. That's a meaningful risk for an agent exposed to untrusted input.", claimIds: ["gh-repo"] },
    { title: "Expiring tokens are on by default", detail: "Your integration must handle refresh. Each refresh token is single-use, and the old pair stops working.", claimIds: ["gh-expiry", "gh-expiry-default"] },
    { title: "No automatic discovery", detail: "GitHub didn't serve OIDC discovery at either standard path, so tools that auto-configure from metadata will need endpoints set by hand.", claimIds: ["gh-no-oidc"] },
  ],
  claims: [
    inferred("gh-no-review", "The registration docs describe no review or approval step. Registration appears to finish when you click Register application, though we didn't create an app to confirm it."),
    source("gh-fields", "Registering needs an application name, homepage URL and authorization callback URL.", GH_CREATE, "Creating an OAuth app", "type the callback URL of your app"),
    source("gh-limit", "A user or organization can own up to 100 OAuth apps.", GH_CREATE, "Creating an OAuth app", "A user or organization can own up to 100 OAuth apps."),
    source("gh-prefer", "GitHub prefers GitHub Apps over OAuth apps in general.", GH_DIFF, "Differences between GitHub Apps and OAuth apps", "In general, GitHub Apps are preferred over OAuth apps."),
    source("gh-repo", "Reading issues or pull requests through an OAuth app requires the repo scope, which also covers code.", GH_DIFF, "Differences between GitHub Apps and OAuth apps", "GitHub Apps can request separate access to issues and pull requests without accessing the actual contents of the repository."),
    source("gh-redirect", "With wildcard matching off, the redirect URL must exactly match the callback URL.", GH_AUTH, "Authorizing OAuth apps", "the redirect URL must exactly match the callback URL"),
    source("gh-tokens", "GitHub limits tokens to ten per user, application and scope combination, and revokes existing tokens beyond that.", GH_AUTH, "Authorizing OAuth apps", "There is a limit of ten tokens that are issued per user/application/scope combination"),
    source("gh-expiry", "Expiring access tokens last eight hours, and refresh tokens last six months without use.", GH_AUTH, "Authorizing OAuth apps", "The access token expires after eight hours, and the refresh token expires after six months without use."),
    source("gh-expiry-default", "The option to expire user access tokens is enabled by default.", GH_CREATE, "Creating an OAuth app", "Expire user access tokens is enabled by default."),
    tested("gh-no-oidc", "GitHub returned 404 for OIDC discovery at both standard paths on github.com.", "p1", "p2"),
    tested("gh-signin", "The new-app page redirects to sign-in, so registering needs an account.", "p3"),
  ],
  unknowns: ["We didn't create an app, so the steps come from GitHub's docs rather than a completed run."],
  probeUrls: ["https://github.com/.well-known/openid-configuration", "https://github.com/.well-known/oauth-authorization-server", "https://github.com/settings/applications/new"],
};

const G_RESTRICTED = "https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification";
const G_OAUTH = "https://developers.google.com/identity/protocols/oauth2";
const G_SCOPES = "https://developers.google.com/workspace/gmail/api/auth/scopes";
const G_AUDIENCE = "https://support.google.com/cloud/answer/15549945?hl=en";

const gmail: Seed = {
  slug: "gmail",
  name: "Gmail",
  website: "https://mail.google.com",
  category: "Email",
  oauthSupport: "yes",
  summary: "Difficulty depends almost entirely on which Gmail scope you need. Sending mail needs Google's review, but reading mail for public users uses restricted scopes, which take weeks of review and a yearly third-party security assessment.",
  biggestRisk: "An agent that reads email needs restricted scopes such as gmail.readonly, so plan for a security assessment before public launch.",
  paths: [
    {
      id: "testing",
      name: "Test with up to 100 named users",
      whenToUse: "You're building or running a pilot with people you can list by email.",
      gates: [],
      gatesKnown: true,
      handsOnHours: { min: 0.5, max: 1 },
      wait: NO_WAIT,
      steps: [
        { title: "Decide the exact Gmail scopes", owner: "agent", detail: "Map each agent action to the narrowest scope. This decides which path you end up on, so do it first.", minutes: { min: 10, max: 20 }, confirm: "Each scope is labeled sensitive or restricted in your notes.", handoffReason: null, claimIds: ["gm-send", "gm-read"] },
        { title: "Create a project and consent screen", owner: "you", detail: "In Google Cloud Console, create a project, enable the Gmail API, set the audience to External and leave the status as Testing. Add your test users.", minutes: { min: 15, max: 25 }, confirm: "Test users are listed under the app's audience settings.", handoffReason: "This requires your Google account and accepting Google's terms.", claimIds: ["gm-console", "gm-test-users"] },
        { title: "Create a web OAuth client", owner: "you", detail: "Create a Web application client and add the redirect URI from your Composio auth config.", minutes: { min: 5, max: 10 }, confirm: "A test user connects and sees the unverified-app warning, which is expected.", handoffReason: "Creating credentials requires your account.", claimIds: [] },
      ],
      blockers: [
        { symptom: "Connections stop working after a week", cause: "External apps in Testing get refresh tokens that expire in 7 days unless they only use basic identity scopes.", action: "Reconnect during testing, and don't treat this as a bug in your integration. It goes away once the app is in production.", claimIds: ["gm-7day"] },
      ],
    },
    {
      id: "internal",
      name: "Internal to your organization",
      whenToUse: "Everyone who will connect is in your own Google Workspace or Cloud Identity organization.",
      gates: [],
      gatesKnown: true,
      handsOnHours: { min: 0.5, max: 1 },
      wait: NO_WAIT,
      steps: [
        { title: "Set the user type to Internal", owner: "you", detail: "Follow the testing setup, but choose Internal as the audience. This requires a project inside your organization.", minutes: { min: 20, max: 40 }, confirm: "Colleagues can connect without an unverified-app warning.", handoffReason: "This requires an account in that organization.", claimIds: ["gm-internal"] },
      ],
      blockers: [
        { symptom: "Internal isn't offered as an option", cause: "Internal needs a project in a Workspace or Cloud Identity organization. A personal Gmail account doesn't have one.", action: "Create the project under your organization, or use the testing path.", claimIds: ["gm-internal"] },
      ],
    },
    {
      id: "public-send",
      name: "Public launch, sending only",
      whenToUse: "Your agent sends email for any user but doesn't need to read their mailbox.",
      gates: ["provider_review"],
      gatesKnown: true,
      handsOnHours: { min: 6, max: 16 },
      wait: { minDays: null, maxDays: null, basis: "unknown", note: "Brand verification typically takes 2 to 3 business days. We found no stated time for sensitive-scope review, and a resubmission would extend it.", claimId: null },
      steps: [
        { title: "Prepare your public pages", owner: "agent", detail: "Draft a home page and a privacy policy that describes your Gmail data use, on the same domain.", minutes: { min: 60, max: 180 }, confirm: "Both pages load publicly without sign-in on the domain you'll verify.", handoffReason: null, claimIds: ["gm-brand"] },
        { title: "Verify your domain", owner: "you", detail: "Verify ownership in Google Search Console with an account that's an Owner or Editor on the project.", minutes: { min: 15, max: 30 }, confirm: "Search Console shows the domain as verified.", handoffReason: "This requires DNS or site access.", claimIds: ["gm-domain"] },
        { title: "Record the demo video", owner: "you", detail: "Show the consent flow with your app name and client ID visible, then show what each scope does. Upload it as Unlisted on YouTube.", minutes: { min: 60, max: 180 }, confirm: "The client ID is readable in the browser address bar on the video.", handoffReason: "It has to show your real, running product.", claimIds: ["gm-video"] },
        { title: "Submit for verification and wait", owner: "provider", detail: "Submit from the Cloud Console and watch the project's contact email closely for questions.", minutes: null, confirm: "The console shows the app as verified.", handoffReason: "Google reviews the submission.", claimIds: ["gm-brand-time"] },
      ],
      blockers: [
        { symptom: "Google asks you to justify a scope", cause: "Apps must request only the least privilege their features need.", action: "Show each scope in use in the video, and drop any scope you can't show.", claimIds: ["gm-least"] },
      ],
    },
    {
      id: "public-restricted",
      name: "Public launch, reading mail",
      whenToUse: "Your agent reads, modifies or manages mail for users outside your organization.",
      gates: ["provider_review", "security_assessment"],
      gatesKnown: true,
      handsOnHours: { min: 40, max: 120 },
      wait: { minDays: 21, maxDays: 90, basis: "estimate", note: "Google says only that review can take several weeks. The range is our estimate and includes assessor time, which we couldn't source.", claimId: null },
      steps: [
        { title: "Check you're a permitted application type", owner: "agent", detail: "Compare your product against Google's Limited Use and permitted app types before spending anything else. A general assistant may not qualify automatically.", minutes: { min: 30, max: 60 }, confirm: "You can name the permitted category your product falls into.", handoffReason: null, claimIds: ["gm-permitted"] },
        { title: "Complete everything on the sending path", owner: "you", detail: "Public pages, domain verification and the demo video are all still required. Task automation platforms must also show how API workflows are created and where user data flows.", minutes: { min: 180, max: 420 }, confirm: "Your submission package is complete.", handoffReason: "These need your domain and running product.", claimIds: ["gm-video", "gm-domain"] },
        { title: "Pass the security assessment", owner: "you", detail: "Engage a Google-approved assessor and fix what they find. The agent can help prepare evidence, but you own the remediation.", minutes: { min: 1200, max: 6000 }, confirm: "The assessor issues a Letter of Assessment.", handoffReason: "An independent assessor has to evaluate your systems.", claimIds: ["gm-casa"] },
        { title: "Wait for Google's review", owner: "provider", detail: "Respond quickly to any follow-up questions, then publish within the 7-day validity window of your results.", minutes: null, confirm: "The console shows the app as verified.", handoffReason: "Google reviews the submission.", claimIds: ["gm-weeks", "gm-window"] },
      ],
      blockers: [
        { symptom: "Access is threatened 12 months after approval", cause: "Reverification is required at least every 12 months.", action: "Put the renewal on your calendar and keep project contacts current, as Google emails those addresses.", claimIds: ["gm-casa-annual"] },
      ],
    },
  ],
  nuances: [
    { title: "Composio's app may remove this work", detail: "Gmail is listed as managed, so you could use Composio's app and skip registration while your users see Composio's name. We couldn't confirm which scopes it's approved for, so check them against your needs.", claimIds: ["gm-managed-scopes"] },
    { title: "Changing a password can break the connection", detail: "Tokens with Gmail scopes can stop working when a user changes their password. Your agent should handle this by asking the user to reconnect.", claimIds: ["gm-password"] },
    { title: "Token limit in testing", detail: "Each Google Account can hold 100 refresh tokens per OAuth client, and the oldest is silently invalidated beyond that. Heavy reconnect testing can hit this.", claimIds: ["gm-100tokens"] },
  ],
  claims: [
    source("gm-send", "gmail.send is classified as a sensitive scope.", G_SCOPES, "Choose Gmail API scopes", null, "Read in the scope table by the research agent. The classification is a table cell, so there's no sentence to match."),
    source("gm-read", "gmail.readonly, gmail.modify, gmail.compose and full mail access are classified as restricted.", G_SCOPES, "Choose Gmail API scopes", null, "Read in the scope table by the research agent. The classification is a table cell, so there's no sentence to match."),
    source("gm-test-users", "Projects in Testing are limited to up to 100 test users.", G_AUDIENCE, "Manage App Audience", "are limited to up to 100 test users"),
    source("gm-7day", "An External app in Testing gets a refresh token that expires in 7 days, unless it only requests basic identity scopes.", G_OAUTH, "Using OAuth 2.0 to access Google APIs", "is issued a refresh token expiring in 7 days"),
    source("gm-100tokens", "There is a limit of 100 refresh tokens per Google Account per OAuth client, and the oldest is invalidated without warning.", G_OAUTH, "Using OAuth 2.0 to access Google APIs", "limit of 100 refresh tokens per Google Account per OAuth 2.0 client ID"),
    source("gm-password", "A refresh token can stop working when a user changes their password and the token has Gmail scopes.", G_OAUTH, "Using OAuth 2.0 to access Google APIs", "the refresh token contains Gmail scopes"),
    source("gm-internal", "Verification isn't required when an app is used only by people in your Workspace or Cloud Identity organization.", G_RESTRICTED, "Restricted scope verification", "the app is used only by people in your Google Workspace or Cloud Identity organization"),
    source("gm-brand", "Your home page must be public, and your privacy policy must be on the same domain and linked from the consent screen.", G_RESTRICTED, "Restricted scope verification", null, "Read on the page by the research agent, which summarized this requirement rather than copying a passage."),
    source("gm-brand-time", "Brand verification typically takes 2 to 3 business days if branding has changed.", G_RESTRICTED, "Restricted scope verification", "which typically takes 2-3 business days"),
    source("gm-domain", "Domain ownership is verified in Google Search Console by an Owner or Editor on the project.", G_RESTRICTED, "Restricted scope verification", "Verify ownership of your project's authorized domains within the Google Search Console"),
    source("gm-video", "The demo video must show the consent flow, the app name and the client ID in the address bar, and be uploaded as Unlisted on YouTube.", G_RESTRICTED, "Restricted scope verification", "browser address bar of the OAuth consent screen correctly includes your app's OAuth client ID"),
    source("gm-least", "Apps must request only the least privilege their features need.", G_RESTRICTED, "Restricted scope verification", "uses the least privilege necessary to provide the feature"),
    source("gm-permitted", "Apps requesting restricted scopes must show they are a permitted application type.", G_RESTRICTED, "Restricted scope verification", "demonstrate that they are a permitted application type"),
    source("gm-casa", "Apps that can reach restricted data through a third-party server must pass a security assessment from Google-empanelled assessors.", G_RESTRICTED, "Restricted scope verification", "must go through a security assessment from Google-empanelled security assessors"),
    source("gm-casa-annual", "Reverification is required at least every 12 months after Letter of Assessment approval.", G_RESTRICTED, "Restricted scope verification", "complete a security assessment at least every 12 months"),
    source("gm-weeks", "Restricted scope review can take several weeks.", G_RESTRICTED, "Restricted scope verification", "can potentially take several weeks to complete"),
    source("gm-window", "Compliant verification results are valid for 7 days.", G_RESTRICTED, "Restricted scope verification", "Compliant verification results are valid for 7 days"),
    tested("gm-console", "The Cloud Console's OAuth page redirects to sign-in, and Google publishes OAuth metadata including S256 PKCE.", "p1", "p2"),
    unknown("gm-managed-scopes", "Which Gmail scopes Composio's managed app is approved to request wasn't established."),
    unknown("gm-casa-cost", "The cost of the security assessment wasn't stated on Google's pages. Ask assessors for a quote."),
  ],
  unknowns: [
    "Security assessment cost and duration. Google's pages we checked don't state either.",
    "How long sensitive-scope review takes. Only brand verification and restricted review have any stated timing.",
    "Which scopes Composio's managed Gmail app can request.",
  ],
  probeUrls: ["https://accounts.google.com/.well-known/openid-configuration", "https://console.cloud.google.com/auth/overview"],
};

const SP_QUOTA = "https://developer.spotify.com/documentation/web-api/concepts/quota-modes";
const SP_POLICY = "https://developer.spotify.com/policy";

const spotify: Seed = {
  slug: "spotify",
  name: "Spotify",
  website: "https://www.spotify.com",
  category: "Media",
  oauthSupport: "yes",
  summary: "You can register an app quickly, but without extended quota only 5 allowlisted users can use it. Extended quota is limited to established organizations with at least 250k monthly active users, so most new products can't launch publicly.",
  biggestRisk: "Two non-technical limits could stop you: the 250k user threshold, and a policy against ingesting Spotify Content into AI models.",
  paths: [
    {
      id: "development",
      name: "Development mode, up to 5 users",
      whenToUse: "A personal tool, prototype or demo for people you can list by name.",
      gates: ["paid_account"],
      gatesKnown: true,
      handsOnHours: { min: 0.25, max: 0.75 },
      wait: NO_WAIT,
      steps: [
        { title: "Register the app", owner: "you", detail: "In the Developer Dashboard, create an app and add the redirect URI from your Composio auth config. The app owner needs Spotify Premium.", minutes: { min: 5, max: 15 }, confirm: "The app page shows a client ID.", handoffReason: "This requires your Spotify account and accepting the developer terms.", claimIds: ["sp-premium"] },
        { title: "Allowlist your users", owner: "you", detail: "Add each person to the app's allowlist before they connect.", minutes: { min: 2, max: 10 }, confirm: "That user can connect and make an API call.", handoffReason: "This needs each user's account details.", claimIds: ["sp-5users"] },
      ],
      blockers: [
        { symptom: "A user gets a 403 error", cause: "Requests from users who aren't allowlisted receive a 403.", action: "Add them to the allowlist. If you've hit 5 users, you've reached the limit of this path.", claimIds: ["sp-403"] },
      ],
    },
    {
      id: "extended",
      name: "Extended quota, public launch",
      whenToUse: "An established company with a launched service and at least 250k monthly active users.",
      gates: ["usage_threshold", "business_verification", "partner_agreement", "provider_review"],
      gatesKnown: true,
      handsOnHours: { min: 4, max: 12 },
      wait: { minDays: null, maxDays: 42, basis: "provider_stated", note: "Spotify says the review can take up to six weeks. That's after your partner application is approved, and we found no timing for that application.", claimId: "sp-weeks" },
      steps: [
        { title: "Check your eligibility first", owner: "agent", detail: "Compare your company against each criterion: registered business, launched service, 250k monthly active users, key markets and commercial viability. If you miss one, stop here.", minutes: { min: 10, max: 20 }, confirm: "You meet every criterion and have the numbers to show it.", handoffReason: null, claimIds: ["sp-org", "sp-mau"] },
        { title: "Check that your agent's use is allowed", owner: "agent", detail: "Compare your agent's behavior against Spotify's Developer Policy, especially the rules on AI and machine learning.", minutes: { min: 15, max: 30 }, confirm: "You can explain how the agent complies with each relevant rule.", handoffReason: null, claimIds: ["sp-ai"] },
        { title: "Apply as a partner", owner: "you", detail: "Submit the partner application from a company email address.", minutes: { min: 30, max: 90 }, confirm: "You receive an approval.", handoffReason: "This is a business application made by your company.", claimIds: ["sp-partner"] },
        { title: "Request the quota extension", owner: "you", detail: "In the Developer Dashboard, open Quota extension Request and complete the questionnaire.", minutes: { min: 30, max: 60 }, confirm: "The dashboard shows your request as submitted.", handoffReason: "This requires your dashboard account.", claimIds: ["sp-partner"] },
        { title: "Wait for review", owner: "provider", detail: "Spotify tests the app against its Developer Policy and replies by email.", minutes: null, confirm: "Spotify confirms by email and your app can serve users who aren't allowlisted.", handoffReason: "Spotify reviews the app.", claimIds: ["sp-weeks"] },
      ],
      blockers: [
        { symptom: "You don't have 250k monthly active users", cause: "Spotify requires this minimum for extended quota.", action: "We found no alternative route. Keep Spotify features in a 5-user pilot, or design your product so it doesn't depend on them.", claimIds: ["sp-mau"] },
      ],
    },
  ],
  nuances: [
    { title: "Your agent may conflict with the AI rule", detail: "Spotify's policy bans ingesting Spotify Content into an AI model. Passing track data to a language model could fall under that, on any path. Get this answered before you build, ideally by asking Spotify.", claimIds: ["sp-ai", "sp-ai-agent"] },
    { title: "Individuals can't apply", detail: "Since May 15, 2025, Spotify only accepts extended quota applications from organizations.", claimIds: ["sp-org"] },
    { title: "Composio can't shortcut this", detail: "Spotify is listed as bring-your-own, so you'd register the app and be subject to these limits yourself.", claimIds: [] },
    { title: "Spotify publishes OAuth metadata", detail: "OIDC discovery responded at the standard path, so endpoints can be read from it.", claimIds: ["sp-oidc"] },
  ],
  claims: [
    source("sp-5users", "Up to 5 authenticated users can use an app in development mode, and each must be allowlisted.", SP_QUOTA, "Quota modes", "Up to 5 authenticated Spotify users can use an app that is in development mode"),
    source("sp-premium", "The app owner needs Spotify Premium for development mode apps to work.", SP_QUOTA, "Quota modes", "must have a Spotify Premium account"),
    source("sp-403", "Requests from users who aren't allowlisted receive a 403.", SP_QUOTA, "Quota modes", "will receive a 403 status code error"),
    source("sp-org", "As of May 15, 2025, Spotify only accepts extended quota applications from organizations.", SP_QUOTA, "Quota modes", "only accepts applications from organizations"),
    source("sp-mau", "Extended quota requires at least 250k monthly active users.", SP_QUOTA, "Quota modes", "Maintaining a minimum of active users (at least 250k MAUs)"),
    source("sp-partner", "You apply through a partner form from a company email, then request the move in the dashboard.", SP_QUOTA, "Quota modes", "Tap on the Quota extension Request tab"),
    source("sp-weeks", "The extended quota review can take up to six weeks.", SP_QUOTA, "Quota modes", "can take up to six weeks"),
    source("sp-ai", "Spotify's Developer Policy prohibits using its platform or content to train a machine learning or AI model, or ingesting Spotify Content into one.", SP_POLICY, "Spotify Developer Policy", "Do not use the Spotify Platform or any Spotify Content to train a machine learning or AI model"),
    inferred("sp-ai-agent", "An agent that sends Spotify Content to a language model could count as ingesting it. The policy doesn't mention agents, so this is our reading rather than Spotify's statement."),
    tested("sp-oidc", "accounts.spotify.com responded with HTTP 200 at the OIDC discovery path.", "p1"),
    unknown("sp-partner-time", "How long the partner application itself takes wasn't established."),
  ],
  unknowns: [
    "How long the partner application takes before the six-week review begins.",
    "Whether any exceptions to the 250k threshold exist. We found none.",
  ],
  probeUrls: ["https://accounts.spotify.com/.well-known/openid-configuration"],
};

const SH_DIST = "https://shopify.dev/docs/apps/launch/distribution";
const SH_PCD = "https://shopify.dev/docs/apps/launch/protected-customer-data";
const SH_SUBMIT = "https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review";

const shopify: Seed = {
  slug: "shopify",
  name: "Shopify",
  website: "https://www.shopify.com",
  category: "Commerce",
  oauthSupport: "yes",
  summary: "Your distribution choice decides the work, and you can't change it later. Custom distribution needs no review but is limited to one store or Plus organization, while public distribution needs App Store review, and customer data needs extra approval.",
  biggestRisk: "Picking a distribution method is irreversible, so a pilot on custom distribution won't convert into a public app.",
  paths: [
    {
      id: "custom",
      name: "Custom distribution, one merchant",
      whenToUse: "You're connecting one store, or stores in a single Plus organization.",
      gates: [],
      gatesKnown: true,
      handsOnHours: { min: 1, max: 3 },
      wait: NO_WAIT,
      steps: [
        { title: "Confirm one merchant is enough", owner: "agent", detail: "Check your plans against the limits of custom distribution, because this choice can't be changed afterward.", minutes: { min: 5, max: 15 }, confirm: "You've confirmed you won't need other merchants on this app.", handoffReason: null, claimIds: ["sh-permanent", "sh-custom"] },
        { title: "Create the app", owner: "you", detail: "Create an app in your Shopify developer account and select custom distribution. Add the Composio redirect URI to its configuration.", minutes: { min: 20, max: 45 }, confirm: "The app shows a client ID and secret.", handoffReason: "This requires your Shopify account.", claimIds: ["sh-signup"] },
        { title: "Install on the store", owner: "you", detail: "Generate the install link and approve it on the merchant's store.", minutes: { min: 10, max: 20 }, confirm: "The agent can read data from that store.", handoffReason: "A store owner has to approve the install.", claimIds: [] },
      ],
      blockers: [
        { symptom: "You want to charge through Shopify's billing", cause: "Custom apps can't charge merchants through Shopify's app billing system.", action: "Bill the merchant directly, or use public distribution from the start.", claimIds: ["sh-billing"] },
      ],
    },
    {
      id: "public",
      name: "Public distribution, App Store",
      whenToUse: "Many merchants will install your app.",
      gates: ["provider_review", "fee"],
      gatesKnown: true,
      handsOnHours: { min: 16, max: 60 },
      wait: { minDays: null, maxDays: null, basis: "unknown", note: "The Shopify pages we read don't state a review time. Repeatedly failing to fix issues can also trigger a cooldown that blocks resubmission.", claimId: null },
      steps: [
        { title: "Decide your customer data level", owner: "agent", detail: "List the fields your agent reads. Names, addresses, phones and emails put you at Level 2, which adds more requirements.", minutes: { min: 20, max: 45 }, confirm: "You know your level and can justify each field.", handoffReason: null, claimIds: ["sh-levels"] },
        { title: "Request protected data access first", owner: "you", detail: "Request access or opt out in the Partner Dashboard before you submit, because you can't apply while the app is under review.", minutes: { min: 20, max: 40 }, confirm: "The dashboard shows the request is complete.", handoffReason: "This requires your Partner Dashboard account.", claimIds: ["sh-pcd-timing"] },
        { title: "Meet the submission requirements", owner: "you", detail: "Subscribe to compliance webhooks, add a 1200 by 1200 icon, an emergency contact and a listing, then run the automated checks. The agent can draft the listing and test the webhooks.", minutes: { min: 480, max: 2400 }, confirm: "All automated checks pass on the review page.", handoffReason: "This requires your account and a real running app.", claimIds: ["sh-webhooks", "sh-checks"] },
        { title: "Submit and respond to review", owner: "provider", detail: "Add noreply@shopify.com to your allowed senders, and respond to review emails promptly.", minutes: null, confirm: "Your app is approved.", handoffReason: "Shopify's review team tests the app.", claimIds: ["sh-email"] },
      ],
      blockers: [
        { symptom: "Your submissions are paused", cause: "Repeatedly failing to fix issues or not responding to reviewers can trigger a cooldown.", action: "Resubmit on the date shown in the status banner, with all issues fixed.", claimIds: ["sh-cooldown"] },
      ],
    },
  ],
  nuances: [
    { title: "Testing is free of data review", detail: "Apps installed only on development stores don't need a protected customer data review, so you can build on those before you apply.", claimIds: ["sh-dev-stores"] },
    { title: "Data minimums are enforced", detail: "Shopify approves access based on need, so an agent asking for everything \"just in case\" is at risk.", claimIds: ["sh-minimum"] },
  ],
  claims: [
    source("sh-custom", "Custom distribution covers one store, stores in one Plus organization or development stores, and needs no approval.", SH_DIST, "Select a distribution method", "on multiple stores that belong to the same Plus organization"),
    source("sh-permanent", "You can't change the distribution method after you select it.", SH_DIST, "Select a distribution method", "You can't change the distribution method after you select it."),
    source("sh-billing", "Custom apps can't charge merchants through Shopify's billing system.", SH_DIST, "Select a distribution method", "Can't charge merchants through Shopify's app billing system"),
    source("sh-levels", "Level 2 covers customer data including name, address, phone or email fields.", SH_PCD, "Protected customer data", "Customer data including name, address, phone, or email fields"),
    source("sh-pcd-timing", "You can't apply for protected customer data while an app is under review.", SH_SUBMIT, "Submit your app for review", "isn't possible while the app is under review"),
    source("sh-webhooks", "Apps distributed through the App Store must subscribe to compliance webhooks.", SH_SUBMIT, "Submit your app for review", "must subscribe to compliance webhooks"),
    source("sh-checks", "You complete automated checks and prepare your app before submitting it for review.", SH_SUBMIT, "Submit your app for review", "After you complete the automated checks"),
    source("sh-email", "Shopify advises adding its address to your allowed senders to receive review emails.", SH_SUBMIT, "Submit your app for review", "to your allowed senders list"),
    source("sh-cooldown", "Repeatedly failing to address issues can put you in a temporary cooldown, during which you can't submit.", SH_SUBMIT, "Submit your app for review", "might be placed in a temporary cooldown period"),
    source("sh-dev-stores", "Apps installed only on development stores don't need a protected customer data review.", SH_PCD, "Protected customer data", "You don't need to submit a request for review for apps that are installed only on development stores."),
    source("sh-minimum", "Shopify approves protected data access if it's the minimum required.", SH_PCD, "Protected customer data", "the requested data is the minimum amount required by your app"),
    tested("sh-signup", "The partner signup page redirects to Shopify's sign-in, so creating an app needs an account.", "p1"),
    unknown("sh-time", "Shopify's review duration wasn't stated on the pages we read."),
    source("sh-fee", "Public distribution requires registering for the Shopify App Store, which has a one-time fee.", SH_DIST, "Select a distribution method", "Public distribution also requires registering for the Shopify App Store"),
    unknown("sh-fee-amount", "The amount of the one-time registration fee wasn't on the pages we read."),
  ],
  unknowns: ["App Store review duration.", "The amount of the App Store registration fee.", "Whether Shopify has specific rules for AI agents acting on merchant data."],
  probeUrls: ["https://partners.shopify.com/signup"],
};

const X_FAQ = "https://developer.xero.com/faq";

const xero: Seed = {
  slug: "xero",
  name: "Xero",
  website: "https://www.xero.com",
  category: "Accounting",
  oauthSupport: "yes",
  summary: "Starting is free and self-serve, but your app is capped at 5 connections until you add payment details. Growth moves through paid tiers, and joining the App Store adds customer references and a yearly security assessment.",
  biggestRisk: "Your connection cap, not your code, limits growth. Plan your tier before onboarding your sixth customer.",
  paths: [
    {
      id: "starter",
      name: "Starter tier, up to 5 connections",
      whenToUse: "You're building, or piloting with a few organizations.",
      gates: [],
      gatesKnown: true,
      handsOnHours: { min: 0.5, max: 1 },
      wait: NO_WAIT,
      steps: [
        { title: "Register the app", owner: "you", detail: "In the Xero developer portal, create a web app and add the Composio redirect URI. Xero's PKCE support is S256 only.", minutes: { min: 10, max: 20 }, confirm: "The app page shows a client ID and you can generate a secret.", handoffReason: "This requires a Xero account and accepting developer terms.", claimIds: ["x-oidc"] },
        { title: "Test on the Demo Company", owner: "you", detail: "Connect the Demo Company first, so your testing doesn't use a real customer's connection.", minutes: { min: 10, max: 20 }, confirm: "Your agent can read invoices from the demo organization.", handoffReason: "A person must approve the consent screen.", claimIds: ["x-demo"] },
      ],
      blockers: [
        { symptom: "A sixth organization can't connect", cause: "Starter is capped at 5 connections.", action: "Add payment details to move to Core, or free up slots with connection management.", claimIds: ["x-starter", "x-sixth"] },
      ],
    },
    {
      id: "paid-tiers",
      name: "Paid tiers, up to thousands of connections",
      whenToUse: "You've outgrown 5 connections.",
      gates: ["fee"],
      gatesKnown: false,
      handsOnHours: { min: 0.25, max: 2 },
      wait: { minDays: null, maxDays: null, basis: "unknown", note: "Moving to Core looks immediate after adding payment details, but we couldn't confirm that. Moves above Core need an application, and we found no stated timing.", claimId: null },
      steps: [
        { title: "Estimate your tier", owner: "agent", detail: "Compare your connection forecast against the tier limits: Core 50, Plus 1,000, Advanced 10,000.", minutes: { min: 10, max: 20 }, confirm: "You know your tier and its monthly fee.", handoffReason: null, claimIds: ["x-tiers"] },
        { title: "Add payment or apply to move up", owner: "you", detail: "Add payment details to move to Core. Higher tiers need an application in the developer portal once you meet that tier's requirements.", minutes: { min: 5, max: 60 }, confirm: "The portal shows your new tier.", handoffReason: "This requires your billing details.", claimIds: ["x-sixth", "x-apply"] },
      ],
      blockers: [
        { symptom: "You're stuck at a tier's maximum", cause: "Connections are capped until you meet the next tier's requirements.", action: "Apply in the developer portal and ask Xero what the next tier requires, as we couldn't find the full list.", claimIds: ["x-cap", "x-tier-reqs"] },
      ],
    },
    {
      id: "app-partner",
      name: "Become an App Store partner",
      whenToUse: "You want to be listed in the Xero App Store.",
      gates: ["partner_agreement", "customer_references", "security_assessment"],
      gatesKnown: false,
      handsOnHours: { min: 40, max: 120 },
      wait: { minDays: null, maxDays: null, basis: "unknown", note: "We couldn't find a stated time for certification.", claimId: null },
      steps: [
        { title: "Find three customers", owner: "you", detail: "Xero's partner guide asks for at least three customers who love your app before certification.", minutes: null, confirm: "You have three named customers using the app.", handoffReason: "This depends on real customer relationships.", claimIds: ["x-three"] },
        { title: "Pass certification and security assessment", owner: "you", detail: "Work through Xero's certification checkpoints, then complete the security assessment, which repeats yearly.", minutes: { min: 1200, max: 4800 }, confirm: "Xero confirms your certification.", handoffReason: "Xero's security team reviews your submission.", claimIds: ["x-security"] },
      ],
      blockers: [],
    },
  ],
  nuances: [
    { title: "Sources disagree on uncertified limits", detail: "A search result from Xero's connections page said organizations can connect to no more than 5 uncertified apps, while its FAQ gives an example of 2. Older forum posts mention a limit of 25. Check with Xero if this affects you.", claimIds: ["x-conflict"] },
    { title: "Custom Connections are a different model", detail: "They're bought per organization and don't count toward the uncertified limit, so they can suit a single large customer.", claimIds: ["x-custom"] },
    { title: "Composio can't provide this app", detail: "Xero is listed as bring-your-own, so you'd be subject to these tiers yourself.", claimIds: [] },
  ],
  claims: [
    source("x-starter", "The Starter tier is capped at 5 connections.", X_FAQ, "Xero Developer FAQ", "has unlimited data access to enable early innovation but is capped at 5 connections"),
    source("x-sixth", "Adding a sixth connection requires payment details, which moves you to Core.", X_FAQ, "Xero Developer FAQ", "you will need to first add your payment details"),
    source("x-tiers", "Connection maximums are Starter 5, Core 50, Plus 1,000, Advanced 10,000. Monthly fees are no charge, $35, $245 and $1,445 AUD, excluding tax. Enterprise has no limit, and its price is on application.", X_FAQ, "Xero Developer FAQ", null, "Read in the pricing table by the research agent."),
    source("x-apply", "Since 2 March 2026 you can apply to move between tiers in the developer portal.", X_FAQ, "Xero Developer FAQ", "you can apply to move between tiers"),
    source("x-cap", "Connections are capped at the tier maximums until you meet that tier's requirements.", X_FAQ, "Xero Developer FAQ", "Your connections are capped at the tier maximums"),
    source("x-custom", "An organization can buy Custom Connections without affecting the uncertified app limit.", X_FAQ, "Xero Developer FAQ", "This won't affect the uncertified app limit"),
    source("x-demo", "Using a demo company carries no charge.", X_FAQ, "Xero Developer FAQ", "no charge when using a demo company"),
    source("x-three", "Certification asks for at least three customers who love your app. We saw this only in a search result, because the page has no readable text without JavaScript.", "https://developer.xero.com/documentation/xero-app-store/app-partner-guides/app-partner-steps/", "Xero app partner guide", null),
    source("x-security", "App partners undertake a security assessment reviewed by Xero's security team, and must pass it annually. We saw this only in a search result, because the page has no readable text without JavaScript.", "https://developer.xero.com/documentation/xero-app-store/app-partner-guides/certification-checkpoints/", "Certification checkpoints", null),
    tested("x-oidc", "Xero publishes OAuth metadata showing S256 as its only PKCE method.", "p1"),
    unknown("x-conflict", "The number of uncertified apps an organization can connect to is unresolved, because Xero's pages disagree."),
    unknown("x-tier-reqs", "The full requirements for moving above the Core tier weren't established."),
  ],
  unknowns: [
    "How many uncertified apps an organization can connect to, as sources conflict.",
    "What's needed to move above Core.",
    "How long certification takes.",
  ],
  probeUrls: ["https://identity.xero.com/.well-known/openid-configuration"],
};

export const SEEDS: Seed[] = [github, gmail, spotify, shopify, xero];
