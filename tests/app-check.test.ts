import { describe, expect, it, vi } from "vitest";
import { checkApp, closestKnown, editDistance, exactKnown, formatProblem, hostOf } from "../src/lib/app-check";

const KNOWN = ["Notion", "Salesforce", "Linear", "Zoom", "Google Drive"];

/** Fakes DNS (registered hosts) and Wikipedia (titles, plus an optional spelling suggestion). */
function fakeWeb({ hosts = [] as string[], titles = [] as string[], suggestion = undefined as string | undefined, down = false } = {}) {
  return vi.fn(async (input: string) => {
    if (down) throw new TypeError("Failed to fetch");
    const url = new URL(input);
    if (url.hostname === "cloudflare-dns.com") {
      return Response.json({ Status: hosts.includes(url.searchParams.get("name") ?? "") ? 0 : 3 });
    }
    return Response.json({ query: { searchinfo: suggestion ? { suggestion } : {}, search: titles.map((title) => ({ title })) } });
  });
}

describe("search bar checks", () => {
  it("rejects bad input without any network request", async () => {
    const fetch = fakeWeb();
    expect(formatProblem("a")).toMatch(/Enter/);
    expect(formatProblem("<script>")).toMatch(/Enter just/);
    expect(formatProblem("!!!")).toMatch(/Enter just/);
    expect((await checkApp(" ", KNOWN, { fetch })).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes known names and their websites straight through", async () => {
    const fetch = fakeWeb();
    expect(await checkApp("notion", KNOWN, { fetch })).toEqual({ ok: true, query: "Notion" });
    expect(await checkApp("https://www.notion.so/pricing", KNOWN, { fetch })).toEqual({ ok: true, query: "https://www.notion.so/pricing" });
    expect(exactKnown("googledrive", KNOWN)).toBe("Google Drive");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("suggests the known name a typo is closest to", async () => {
    expect(editDistance("notoin", "notion")).toBe(1);
    expect(closestKnown("Salesfroce", KNOWN)).toBe("Salesforce");
    expect(closestKnown("Lineer", KNOWN)).toBe("Linear");
    expect(closestKnown("Stripe", KNOWN)).toBeNull();
    const result = await checkApp("Notoin", KNOWN, { fetch: fakeWeb() });
    expect(result).toMatchObject({ ok: false, reason: "spelling", suggestion: "Notion", canSearchAnyway: true });
  });

  it("checks a near-miss on the web when the user searches it anyway", async () => {
    const loom = await checkApp("Loom", KNOWN, { skipSpelling: true, fetch: fakeWeb({ hosts: ["loom.com"] }) });
    expect(loom).toEqual({ ok: true, query: "Loom" });
    const missing = await checkApp("Zoomx", KNOWN, { skipSpelling: true, fetch: fakeWeb() });
    expect(missing).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("accepts an unknown app found in DNS or on Wikipedia", async () => {
    expect(await checkApp("Stripe", KNOWN, { fetch: fakeWeb({ hosts: ["stripe.com"] }) })).toEqual({ ok: true, query: "Stripe" });
    expect(await checkApp("Basecamp", KNOWN, { fetch: fakeWeb({ titles: ["Basecamp (company)"] }) })).toEqual({ ok: true, query: "Basecamp" });
  });

  it("uses Wikipedia's spelling suggestion for names we don't know", async () => {
    const real = await checkApp("Shopfy", KNOWN, { fetch: fakeWeb({ hosts: ["shopfy.com"], suggestion: "shopify" }) });
    expect(real).toMatchObject({ ok: false, reason: "spelling", suggestion: "Shopify", canSearchAnyway: true });
    const fake = await checkApp("Shopfy", KNOWN, { fetch: fakeWeb({ suggestion: "shopify" }) });
    expect(fake).toMatchObject({ ok: false, reason: "not_found", suggestion: "Shopify" });
    const anyway = await checkApp("Shopfy", KNOWN, { skipSpelling: true, fetch: fakeWeb({ hosts: ["shopfy.com"], suggestion: "shopify" }) });
    expect(anyway).toEqual({ ok: true, query: "Shopfy" });
  });

  it("blocks names and websites that can't be found", async () => {
    expect(await checkApp("qzxkvwplm", KNOWN, { fetch: fakeWeb() })).toMatchObject({ ok: false, reason: "not_found", suggestion: null });
    expect(hostOf("https://qzxkvwplm.io/x")).toBe("qzxkvwplm.io");
    expect(await checkApp("qzxkvwplm.io", KNOWN, { fetch: fakeWeb() })).toMatchObject({ ok: false, reason: "not_found" });
    expect(await checkApp("acme.io", KNOWN, { fetch: fakeWeb({ hosts: ["acme.io"] }) })).toEqual({ ok: true, query: "acme.io" });
  });

  it("lets the search through when the checks themselves can't run", async () => {
    expect(await checkApp("qzxkvwplm", KNOWN, { fetch: fakeWeb({ down: true }) })).toEqual({ ok: true, query: "qzxkvwplm" });
    expect(await checkApp("acme.io", KNOWN, { fetch: fakeWeb({ down: true }) })).toEqual({ ok: true, query: "acme.io" });
  });
});
