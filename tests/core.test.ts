import { describe, expect, it } from "vitest";
import { z } from "zod";
import { domainStem, findInCatalog } from "../src/lib/catalog";
import { applyChecks, demoteModelTested, explainHandoffs, normalizeClaims, probeClaims, reconcileWaits, requireApprovalEvidence, resolvePassages } from "../src/lib/evidence";
import { guideToMarkdown } from "../src/lib/markdown";
import { excerpt, excerptAcross, toPassages } from "../src/lib/page-text";
import { probeTargets } from "../src/lib/probe-targets";
import { isStrongQuote, normalizeText, quoteAppears, toPlainText } from "../src/lib/quote-check";
import { assertAllowedUrl, BlockedUrlError, isBlockedAddress } from "../src/lib/safe-fetch";
import { GuideDraftSchema, GuideSchema, type GuideDraft, type Path, type Probe } from "../src/lib/schema";
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

  describe("paths with no gates", () => {
    const selfServe = (over: Partial<Path> = {}) =>
      ({ gates: [], gatesKnown: true, wait: { minDays: null, maxDays: null, basis: "none", note: "Immediate.", claimId: "c1" }, ...over }) as Path;
    const checked = (status: "quote_matched" | "unverified" | "contradicted") =>
      applyChecks([claim()], new Map([["c1", { status, note: null }]]));

    it("stays easy when a claim that survived checking says no approval is needed", () => {
      const [result] = requireApprovalEvidence([selfServe()], checked("quote_matched"));
      expect(scorePath(result!).level).toBe("easy");
      expect(formatWait(result!.wait)).toBe("No approval wait");
    });

    it.each(["unverified", "contradicted"] as const)("becomes unclear, not easy, when that claim is %s", (status) => {
      const [result] = requireApprovalEvidence([selfServe()], checked(status));
      expect(scorePath(result!).level).toBe("unclear");
      expect(formatWait(result!.wait)).toBe("Unknown");
      expect(result!.wait.note).not.toBe("Immediate.");
    });

    it("becomes unclear when no claim is cited at all", () => {
      const path = selfServe({ wait: { minDays: null, maxDays: null, basis: "none", note: "", claimId: null } });
      expect(scorePath(requireApprovalEvidence([path], checked("quote_matched"))[0]!).level).toBe("unclear");
    });

    it("doesn't promise no wait when the model already said the gates are unclear", () => {
      const [result] = requireApprovalEvidence([selfServe({ gatesKnown: false })], checked("quote_matched"));
      expect(formatWait(result!.wait)).toBe("Unknown");
    });

    it("leaves a path with a known gate alone", () => {
      const path = selfServe({ gates: ["provider_review"], wait: { minDays: null, maxDays: null, basis: "unknown", note: "Unpublished.", claimId: null } });
      expect(requireApprovalEvidence([path], [])[0]).toEqual(path);
    });
  });

  it("explains every handoff, and keeps a reason the model gave", () => {
    const step = (owner: "agent" | "you" | "provider", handoffReason: string | null) => ({ owner, handoffReason }) as Path["steps"][number];
    const [result] = explainHandoffs([{ steps: [step("agent", null), step("you", null), step("provider", "  "), step("you", "Needs your signature.")] } as Path]);
    const reasons = result!.steps.map((item) => item.handoffReason);
    expect(reasons[0]).toBeNull();
    expect(reasons[1]).toMatch(/your account/);
    expect(reasons[2]).toMatch(/provider/);
    expect(reasons[3]).toBe("Needs your signature.");
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

describe("page excerpts", () => {
  const filler = "unrelated words about something else entirely. ".repeat(200);
  const page = `${filler}Apps need a security assessment before approval is granted. ${filler}`;

  it("keeps the passage about the topic, word for word and within budget", () => {
    const result = excerpt(page, "security assessment approval", 1_200);
    expect(result.length).toBeLessThanOrEqual(1_200 + 20);
    expect(result).toContain("security assessment");
  });

  it("returns short pages whole, and the start of a page when nothing matches", () => {
    expect(excerpt("Short page.", "anything", 1_000)).toBe("Short page.");
    expect(excerpt(page, "zzzz", 100)).toBe(page.slice(0, 100));
  });

  it("keeps a page's original case in plain text", () => {
    expect(toPlainText("<p>Use  <b>PKCE</b> &amp; HTTPS</p><script>x()</script>")).toBe("Use PKCE & HTTPS");
  });
});

describe("structured output schema", () => {
  /** Groq's strict mode rejects a schema unless every object lists all its fields and forbids extras. */
  function assertStrict(node: unknown): void {
    if (Array.isArray(node)) return node.forEach(assertStrict);
    if (typeof node !== "object" || node === null) return;
    const { properties, required, additionalProperties } = node as Record<string, unknown>;
    if (properties) {
      expect(additionalProperties).toBe(false);
      expect([...(required as string[])].sort()).toEqual(Object.keys(properties).sort());
    }
    Object.values(node).forEach(assertStrict);
  }

  it("meets the strict mode rules", () => {
    assertStrict(z.toJSONSchema(GuideDraftSchema));
  });
});

describe("cited passages", () => {
  const passages = new Map([["P1", { url: "https://docs.test/a", quote: "The exact words on the page." }], ["P2", { url: "https://docs.test/b", quote: "Other exact words here today." }]]);

  it("replaces passage ids with the exact words and URL", () => {
    const [result] = resolvePassages([claim({ sources: [{ url: "", title: "Docs", quote: "P1" }] })], passages);
    expect(result?.sources).toEqual([{ url: "https://docs.test/a", title: "Docs", quote: "The exact words on the page." }]);
  });

  it("expands several ids, and tolerates brackets", () => {
    const [result] = resolvePassages([claim({ sources: [{ url: "", title: "Docs", quote: "[P1], [P2]" }] })], passages);
    expect(result?.sources.map((source) => source.url)).toEqual(["https://docs.test/a", "https://docs.test/b"]);
  });

  it("drops an id that doesn't exist, so the claim can't stay sourced", () => {
    const resolved = resolvePassages([claim({ sources: [{ url: "https://made-up.test", title: "Docs", quote: "P9" }] })], passages);
    expect(resolved[0]?.sources).toEqual([]);
    expect(normalizeClaims({ claims: resolved } as GuideDraft, [])[0]?.label).toBe("inferred");
  });

  it("leaves a written-out quote alone, for the quote check to judge", () => {
    const [result] = resolvePassages([claim()], passages);
    expect(result?.sources[0]?.quote).toBe("a long enough exact quote");
  });

  it("splits excerpts into passages that are long enough and word for word", () => {
    const result = toPassages("Short one. This sentence is long enough to count. [...] And this one is long enough too.");
    expect(result).toEqual(["This sentence is long enough to count.", "And this one is long enough too."]);
    const long = toPassages(`${"word ".repeat(200)}end.`);
    expect(Math.max(...long.map((passage) => passage.length))).toBeLessThanOrEqual(300);
    expect(long.join(" ")).toBe(`${"word ".repeat(200)}end.`);
  });
});

describe("evidence across pages", () => {
  const filler = "nothing relevant in this part of the page at all. ".repeat(40);
  const pages = [{ url: "https://a.test", text: `${filler}${filler}` }, { url: "https://b.test", text: `${filler}Refresh tokens expire after thirty days. ${filler}` }];

  it("finds the page that states a fact", () => {
    const [best] = excerptAcross(pages, "refresh tokens expire", 600);
    expect(best?.url).toBe("https://b.test");
    expect(best?.text).toContain("Refresh tokens expire");
  });

  it("returns nothing when no page mentions it, so there's nothing to misattribute", () => {
    expect(excerptAcross(pages, "zzzzz qqqqq", 600)).toEqual([]);
  });
});

describe("automatic probes", () => {
  const probe = (id: string, url: string, observation: string, status: number | null = 200): Probe => ({ id, url, status, observation, checkedAt: "2026-01-01" });

  it("checks discovery on the provider's domain and setup links in its docs", () => {
    const targets = probeTargets([{ url: "https://developers.acme.com/docs", text: "Send users to https://api.acme.com/v1/oauth/authorize, then read https://developers.acme.com/guides." }], "Acme");
    expect(targets).toEqual([
      "https://acme.com/.well-known/openid-configuration",
      "https://acme.com/.well-known/oauth-authorization-server",
      "https://api.acme.com/v1/oauth/authorize",
      "https://api.acme.com/.well-known/openid-configuration",
      "https://api.acme.com/.well-known/oauth-authorization-server",
    ]);
  });

  it("ignores links to other domains and placeholder URLs, since page text is untrusted", () => {
    const text = "See https://evil.test/oauth/authorize and https://api.acme.com/{tenant}/oauth and https://example.acme.com/oauth/authorize.";
    const targets = probeTargets([{ url: "https://acme.com/docs", text }], "Acme");
    expect(targets.join(" ")).not.toMatch(/evil|tenant|example/);
  });

  it("uses a submitted website, and does nothing with no pages or website", () => {
    expect(probeTargets([], "https://www.acme.co.uk/pricing")[0]).toBe("https://acme.co.uk/.well-known/openid-configuration");
    expect(probeTargets([], "Acme")).toEqual([]);
  });

  it("writes tested claims from what probes observed", () => {
    const claims = probeClaims([probe("p1", "https://a.test/.well-known/openid-configuration", "Publishes OAuth metadata. issuer: x."), probe("p2", "https://a.test/portal", "Redirects to a sign-in page (a.test/login), so this page needs an account."), probe("p3", "https://a.test/other", "Returned HTTP 200.")]);
    expect(claims.map((item) => item.probeRefs)).toEqual([["p1"], ["p2"]]);
    expect(claims.every((item) => item.label === "tested")).toBe(true);
  });

  it("reports missing discovery documents, but not requests that failed", () => {
    const missing = probeClaims([probe("p1", "https://a.test/.well-known/openid-configuration", "No discovery document at this path.", 404)]);
    expect(missing[0]?.text).toContain("No OAuth discovery document");
    expect(probeClaims([probe("p1", "https://a.test/.well-known/openid-configuration", "Request failed: timeout", null)])).toEqual([]);
  });

  it("doesn't count a redirect as a missing discovery document", () => {
    expect(probeClaims([probe("p1", "https://a.test/.well-known/openid-configuration", "Redirects to www.a.test.", 302)])).toEqual([]);
  });

  it("reports another system's discovery document as exactly that, not as missing or as this API's", () => {
    const foreign = "Serves OAuth metadata for an issuer on another domain (shopify.com), so it may belong to a different system, not this API.";
    const claims = probeClaims([probe("p1", "https://a.test/.well-known/openid-configuration", foreign), probe("p2", "https://a.test/.well-known/oauth-authorization-server", "No discovery document at this path.", 404)]);
    expect(claims[0]?.text).toContain("may belong to a different system");
    expect(claims.find((item) => item.id === "probe-no-discovery")?.probeRefs).toEqual(["p2"]);
  });

  it("won't let the model keep a tested label, even when citing a probe that ran", () => {
    const [withSource, withoutSource] = demoteModelTested([claim({ label: "tested", probeRefs: ["p1"] }), claim({ label: "tested", probeRefs: ["p1"], sources: [] })]);
    expect(withSource).toMatchObject({ label: "sourced", probeRefs: [] });
    expect(withoutSource).toMatchObject({ label: "inferred", probeRefs: [] });
  });
});
