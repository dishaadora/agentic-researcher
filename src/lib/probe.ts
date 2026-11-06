import { baseDomain } from "./probe-targets";
import type { Probe } from "./schema";
import { safeFetch } from "./safe-fetch";

const FOREIGN_DISCOVERY = "Serves OAuth metadata for an issuer on another domain";
const hostnameOf = (value: string) => {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const DISCOVERY_FIELDS = ["issuer", "authorization_endpoint", "token_endpoint", "code_challenge_methods_supported"] as const;
const LOGIN_PATTERN = /(^|[/.])(log-?in|sign-?in|signin|servicelogin|oauth\/authorize|auth)([/?.]|$)/i;

/**
 * A read-only observation of a provider URL. It never logs in, submits a form or registers
 * anything. Fields come from what the server returned, so a probe is the only thing allowed to
 * back a "tested" label.
 */
export async function probeUrl(url: string, id: string, signal?: AbortSignal): Promise<Probe> {
  const checkedAt = new Date().toISOString();
  try {
    // Discovery documents often redirect to a www host. Other redirects are the observation itself.
    const maxRedirects = url.includes("/.well-known/") ? 2 : 0;
    const response = await safeFetch(url, { signal, maxBytes: 500_000, maxRedirects });
    return { id, url, status: response.status, observation: describe(url, response), checkedAt };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { id, url, status: null, observation: `Request failed: ${reason}`, checkedAt };
  }
}

function describe(url: string, response: Awaited<ReturnType<typeof safeFetch>>) {
  const isDiscovery = url.includes("/.well-known/");
  if (isDiscovery && response.status === 200) {
    try {
      const document = JSON.parse(response.body) as Record<string, unknown>;
      const parts = DISCOVERY_FIELDS.filter((key) => document[key]).map((key) => `${key}: ${JSON.stringify(document[key])}`);
      if (parts.length > 0) {
        // A company's main domain can host another system's login, such as its online store's.
        const issuer = typeof document.issuer === "string" ? hostnameOf(document.issuer) : null;
        const requested = hostnameOf(url);
        if (issuer && requested && baseDomain(issuer) !== baseDomain(requested)) {
          return `${FOREIGN_DISCOVERY} (${issuer}), so it may belong to a different system, not this API.`;
        }
        return `Publishes OAuth metadata. ${parts.join("; ")}.`;
      }
    } catch {
      return "Returned 200, but the response wasn't valid discovery JSON.";
    }
  }
  if (isDiscovery && response.status === 404) return "No discovery document at this path.";
  const location = response.redirectedTo;
  if (location && response.status >= 300 && response.status < 400) {
    return LOGIN_PATTERN.test(location)
      ? `Redirects to a sign-in page (${hostOf(location)}), so this page needs an account.`
      : `Redirects to ${hostOf(location)}.`;
  }
  return `Returned HTTP ${response.status}. A 200 here doesn't show the page is usable without an account.`;
}

function hostOf(location: string) {
  try {
    const { hostname, pathname } = new URL(location);
    return `${hostname}${pathname}`;
  } catch {
    return "another page";
  }
}
