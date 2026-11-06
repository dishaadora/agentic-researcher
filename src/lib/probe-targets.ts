const MAX_TARGETS = 6;
const MAX_LINKED_URLS = 2;
const TWO_PART_SUFFIXES = new Set(["co", "com", "org", "net", "ac", "gov"]);
const SETUP_PATH = /authorize|\/oauth2?(\/|$)|\/my-|\/apps?(\/|$)|\/console|\/dashboard/i;
const SETUP_HOST = /^(app|apps|console|dashboard)\./i;
const NOT_A_REAL_URL = /[{}<>$]|your|example|\.(png|jpe?g|svg|gif|css|js|ico)(\?|$)/i;

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/** A simple guess at the registrable domain, such as notion.com from developers.notion.com. */
export function baseDomain(host: string) {
  const parts = host.split(".");
  const keep = parts.length > 2 && TWO_PART_SUFFIXES.has(parts.at(-2)!) ? 3 : 2;
  return parts.slice(-keep).join(".");
}

function mostReadDomain(pages: { url: string }[]) {
  const counts = new Map<string, number>();
  for (const { url } of pages) {
    const host = hostOf(url);
    if (host) counts.set(baseDomain(host), (counts.get(baseDomain(host)) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * Picks the URLs worth a read-only check, so a run gets real observations even when the model
 * doesn't ask for them. Links must be on the provider's own domain, because page text is untrusted.
 */
export function probeTargets(pages: { url: string; text: string }[], submitted: string): string[] {
  const submittedHost = /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+([/?#].*)?$/i.test(submitted.trim())
    ? hostOf(submitted.trim().replace(/^(?!https?:\/\/)/i, "https://"))
    : null;
  const domain = submittedHost ? baseDomain(submittedHost) : mostReadDomain(pages);
  if (!domain) return [];

  const linked = new Set<string>();
  for (const { text } of pages) {
    for (const match of text.match(/https?:\/\/[^\s"'`<>)\]\\]+/g) ?? []) {
      const url = match.replace(/[.,;:]+$/, "");
      const host = hostOf(url);
      if (!host || NOT_A_REAL_URL.test(url) || baseDomain(host) !== domain) continue;
      if (SETUP_PATH.test(new URL(url).pathname) || SETUP_HOST.test(host)) linked.add(url);
    }
  }
  const links = [...linked].slice(0, MAX_LINKED_URLS);
  const authHosts = links.map((url) => hostOf(url)!).filter((host) => host !== domain);
  const discovery = (host: string) => [`https://${host}/.well-known/openid-configuration`, `https://${host}/.well-known/oauth-authorization-server`];
  return [...new Set([...discovery(domain), ...links, ...authHosts.flatMap(discovery)])].slice(0, MAX_TARGETS);
}
