import type { Probe } from "./schema";
import { safeFetch } from "./safe-fetch";

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
    const response = await safeFetch(url, { signal, maxBytes: 500_000, maxRedirects: 0 });
    return { id, url, status: response.status, observation: describe(url, response), checkedAt };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { id, url, status: null, observation: `Request failed: ${reason}`, checkedAt };
  }
}

function describe(url: string, response: Awaited<ReturnType<typeof safeFetch>>) {
  const location = response.redirectedTo;
  if (location) {
    return LOGIN_PATTERN.test(location)
      ? `Redirects to a sign-in page (${hostOf(location)}), so this page needs an account.`
      : `Redirects to ${hostOf(location)}.`;
  }
  if (url.includes("/.well-known/") && response.status === 200) {
    try {
      const document = JSON.parse(response.body) as Record<string, unknown>;
      const parts = DISCOVERY_FIELDS.filter((key) => document[key]).map((key) => `${key}: ${JSON.stringify(document[key])}`);
      if (parts.length > 0) return `Publishes OAuth metadata. ${parts.join("; ")}.`;
    } catch {
      return "Returned 200, but the response wasn't valid discovery JSON.";
    }
  }
  if (url.includes("/.well-known/") && response.status === 404) return "No discovery document at this path.";
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
