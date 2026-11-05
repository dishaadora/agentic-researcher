import type { CatalogStatus } from "./catalog";

const MANAGED_VS_CUSTOM = "https://docs.composio.dev/docs/authentication/custom-app-vs-managed-app";

/** Facts from Composio's docs, used by every guide. `npm run sources:check` re-checks these quotes. */
export const COMPOSIO_FACTS = [
  { id: "custody", text: "Your own OAuth app changes who owns the app, its branding, scopes and quota. Composio still stores and refreshes tokens.", url: MANAGED_VS_CUSTOM, quote: "Choosing your own OAuth app changes app ownership, branding, scopes, and provider quota" },
  { id: "default", text: "Toolkits you don't list in authConfigs keep using Composio managed auth, so you can switch one toolkit at a time.", url: MANAGED_VS_CUSTOM, quote: "Toolkits you leave out keep using Composio managed auth." },
] as const;

export const WHEN_YOU_NEED_YOUR_OWN = [
  "Your users should see your app's name on the consent screen, not Composio's",
  "You need scopes beyond Composio's defaults",
  "You're hitting quota shared across all Composio users",
  "You need polling faster than the 2-minute minimum",
  "You connect to a self-hosted or regional instance",
];

export const DECISION: Record<CatalogStatus, { title: string; body: string }> = {
  managed: {
    title: "You can start without registering anything",
    body: "Composio provides a managed OAuth app here, so you can build and test today. The rest of this guide is for when you need your own app.",
  },
  byo: {
    title: "You need your own OAuth app",
    body: "Composio's directory lists this toolkit as bring-your-own, so this guide applies before your users can connect.",
  },
  not_listed: {
    title: "This app isn't in Composio's directory",
    body: "The directory only lists toolkits with OAuth, and this one wasn't in the snapshot. You'd register your own app with the provider and may need a custom integration.",
  },
};

export const CONNECT_STEPS = [
  "In the Composio dashboard, choose Create Auth Config, select the toolkit and pick OAuth2 with your own credentials.",
  "Copy the redirect URI the dashboard shows into the provider's app settings. It must match exactly on both sides.",
  "Enter your client ID, client secret and scopes, then copy the resulting auth config ID (it starts with ac_).",
  "Pass that ID in your session's authConfigs, keyed by toolkit. Creating the config alone changes nothing.",
];
