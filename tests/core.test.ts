import { describe, expect, it } from "vitest";
import { domainStem, findInCatalog } from "../src/lib/catalog";
import { applyChecks, normalizeClaims, reconcileWaits } from "../src/lib/evidence";
import { guideToMarkdown } from "../src/lib/markdown";
import { isStrongQuote, normalizeText, quoteAppears } from "../src/lib/quote-check";
import { assertAllowedUrl, BlockedUrlError, isBlockedAddress } from "../src/lib/safe-fetch";
import { GuideSchema, type GuideDraft, type Path, type Probe } from "../src/lib/schema";
import { formatWait, scoreGuide, scorePath } from "../src/lib/score";
import { getGuide, listGuides } from "../src/lib/store";

const claim = (over: Partial<GuideDraft["claims"][number]> = {}): GuideDraft["claims"][number] => ({
  id: "c1",
  text: "A fact",
  label: "sourced",
  sources: [{ url: "https://example.com/a", title: "A", quote: "a long enough exact quote" }],
  probeRefs: [],
  ...over,
});

describe("difficulty rating", () => {
  it("rates by the hardest gate", () => {
    expect(scorePath({ gates: [], gatesKnown: true }).level).toBe("easy");
    expect(scorePath({ gates: ["fee"], gatesKnown: true }).level).toBe("easy");
    expect(scorePath({ gates: ["provider_review", "fee"], gatesKnown: true }).level).toBe("moderate");
    expect(scorePath({ gates: ["provider_review", "security_assessment"], gatesKnown: true }).level).toBe("very_hard");
    expect(scorePath({ gates: ["usage_threshold", "provider_review"], gatesKnown: true }).level).toBe("gated");
  });

  it("refuses to call a path easy when gates aren't known", () => {
    expect(scorePath({ gates: [], gatesKnown: false }).level).toBe("unclear");
  });

  it("gives no rating to an app without OAuth", () => {
    expect(scoreGuide({ paths: [], oauthSupport: "no" })).toEqual({ from: "unclear", to: "unclear" });
  });

  it("doesn't invent a wait when the duration is unknown", () => {
    const wait = { minDays: null, maxDays: null, basis: "unknown", note: "", claimId: null } as Path["wait"];
    expect(formatWait(wait)).toBe("Unknown");
  });
});

describe("URL safety", () => {
  it.each(["127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "172.16.0.1", "::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254"])(
    "blocks private address %s",
    (address) => expect(isBlockedAddress(address)).toBe(true),
  );

  it.each(["8.8.8.8", "140.82.112.3", "2606:4700:4700::1111"])("allows public address %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it.each([
    "file:///etc/passwd",
    "ftp://example.com",
    "http://localhost/",
    "http://metadata.google.internal/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "https://user:pass@example.com/",
    "https://example.com:8443/",
    "not a url",
  ])("rejects %s", (url) => expect(() => assertAllowedUrl(url)).toThrow(BlockedUrlError));

  it("accepts a normal https URL", () => {
    expect(assertAllowedUrl("https://docs.github.com/en").hostname).toBe("docs.github.com");
  });
});

describe("quote checking", () => {
  it("matches across HTML tags, entities, curly quotes and markdown links", () => {
    expect(quoteAppears("<p>You can&#x27;t <b>change</b> the method.</p>", "You can't change the method.")).toBe(true);
    expect(quoteAppears("You can’t change the method.", "You can't change the method.")).toBe(true);
    expect(quoteAppears("changes quota, not [token custody](/x) at all", "not token custody at all")).toBe(true);
  });

  it("ignores script contents and absent text", () => {
    expect(quoteAppears("<script>hidden words live here</script><p>hi</p>", "hidden words live here")).toBe(false);
    expect(normalizeText("  A\n\tB ")).toBe("a b");
  });

  it("treats short quotes as weak", () => {
    expect(isStrongQuote("403")).toBe(false);
    expect(isStrongQuote("at least 250k users")).toBe(true);
  });
});

describe("evidence rules", () => {
  const probes: Probe[] = [{ id: "p1", url: "https://example.com", status: 200, observation: "ok", checkedAt: "2026-01-01" }];
  const draft = (claims: GuideDraft["claims"]) => ({ claims }) as GuideDraft;

  it("won't let the model claim tested without a real probe", () => {
    const [noProbe, fake, real] = normalizeClaims(
      draft([
        claim({ id: "a", label: "tested", sources: [] }),
        claim({ id: "b", label: "tested", probeRefs: ["p99"] }),
        claim({ id: "c", label: "tested", sources: [], probeRefs: ["p1"] }),
      ]),
      probes,
    );
    expect(noProbe?.label).toBe("inferred");
    expect(fake?.label).toBe("sourced");
    expect(real?.label).toBe("tested");
  });

  it("drops unsafe links, so a sourced claim without one becomes inferred", () => {
    const [result] = normalizeClaims(draft([claim({ sources: [{ url: "javascript:alert(1)", title: "x", quote: null }] })]), []);
    expect(result?.sources).toEqual([]);
    expect(result?.label).toBe("inferred");
  });

  it("weakens claims that fail checking", () => {
    const checks = new Map([
      ["bad", { status: "contradicted" as const, note: "No" }],
      ["unsure", { status: "unverified" as const, note: null }],
      ["good", { status: "quote_matched" as const, note: null }],
    ]);
    const [bad, unsure, good] = applyChecks([claim({ id: "bad" }), claim({ id: "unsure" }), claim({ id: "good" })], checks);
    expect(bad?.label).toBe("unknown");
    expect(bad?.text).toMatch(/^Disputed/);
    expect(unsure?.label).toBe("inferred");
    expect(good?.label).toBe("sourced");
  });

  it("stops calling a wait provider-stated if its claim didn't survive", () => {
    const path = {
      wait: { minDays: null, maxDays: 42, basis: "provider_stated", note: "", claimId: "c1" },
      steps: [{ claimIds: ["c1", "ghost"] }],
      blockers: [],
    } as unknown as Path;
    const weakened = applyChecks([claim()], new Map([["c1", { status: "unverified" as const, note: null }]]));
    const [result] = reconcileWaits([path], weakened);
    expect(result?.wait.basis).toBe("estimate");
    expect(result?.wait.claimId).toBeNull();
    expect(result?.steps[0]?.claimIds).toEqual(["c1"]);
  });
});

describe("directory", () => {
  it("finds apps by name, slug or website", () => {
    expect(findInCatalog("gmail")?.status).toBe("managed");
    expect(findInCatalog("Shopify")?.status).toBe("byo");
    expect(findInCatalog("https://www.shopify.com/pricing")?.status).toBe("byo");
    expect(findInCatalog("no-such-app-xyz")).toBeNull();
    expect(domainStem("linear.app")).toBe("linear");
    expect(domainStem("Google Sheets")).toBeNull();
  });
});

describe("reviewed guides", () => {
  it("includes five valid guides with varied difficulty", () => {
    const guides = listGuides().filter((guide) => guide.origin === "reviewed_seed");
    expect(guides.map((guide) => guide.slug).sort()).toEqual(["github", "gmail", "shopify", "spotify", "xero"]);
    for (const guide of guides) expect(GuideSchema.safeParse(guide).success).toBe(true);
    expect(new Set(guides.map((guide) => scoreGuide(guide).to)).size).toBeGreaterThan(2);
  });

  it("links every step, blocker and nuance only to claims that exist", () => {
    for (const guide of listGuides()) {
      const ids = new Set(guide.claims.map((claim) => claim.id));
      const refs = [
        ...guide.nuances.flatMap((nuance) => nuance.claimIds),
        ...guide.paths.flatMap((path) => [...path.steps.flatMap((step) => step.claimIds), ...path.blockers.flatMap((blocker) => blocker.claimIds), ...(path.wait.claimId ? [path.wait.claimId] : [])]),
      ];
      expect(refs.filter((ref) => !ids.has(ref)), guide.slug).toEqual([]);
    }
  });

  it("backs every tested claim with a probe that ran", () => {
    for (const guide of listGuides()) {
      for (const item of guide.claims.filter((candidate) => candidate.label === "tested")) {
        expect(item.probeRefs.length, item.id).toBeGreaterThan(0);
        for (const ref of item.probeRefs) {
          const probe = guide.probes.find((candidate) => candidate.id === ref);
          expect(probe?.status, `${guide.slug}/${item.id}`).not.toBeNull();
        }
      }
    }
  });

  it("exports to Markdown with the key sections", () => {
    const markdown = guideToMarkdown(getGuide("spotify")!, "https://example.com");
    expect(markdown).toContain("# Setting up a Spotify OAuth app");
    expect(markdown).toContain("Gated");
    expect(markdown).toContain("## Evidence");
    expect(markdown).toContain("https://example.com/guides/spotify");
  });
});
