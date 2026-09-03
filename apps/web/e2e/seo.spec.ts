import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * The Section 9 acceptance checks that can only be made against rendered HTML.
 * Everything data-shaped (sitemap membership, word counts, title ladder) is a
 * unit test in lib/directory/directory.test.ts; this file crawls what a search
 * engine would actually receive.
 */

interface Fetched {
  path: string;
  html: string;
  title: string;
  description: string;
  canonical: string;
  h1Count: number;
  robots: string;
  links: string[];
  jsonLd: string[];
}

function extract(pattern: RegExp, html: string): string {
  return pattern.exec(html)?.[1] ?? "";
}

function extractAll(pattern: RegExp, html: string): string[] {
  return [...html.matchAll(pattern)].map((m) => m[1] ?? "");
}

async function fetchPage(request: APIRequestContext, path: string): Promise<Fetched> {
  const response = await request.get(path);
  expect(response.status(), `${path} status`).toBe(200);
  const html = await response.text();

  return {
    path,
    html,
    title: extract(/<title>([^<]*)<\/title>/, html),
    description: extract(/<meta name="description" content="([^"]*)"/, html),
    canonical: extract(/<link rel="canonical" href="([^"]*)"/, html),
    h1Count: (html.match(/<h1[\s>]/g) ?? []).length,
    robots: extract(/<meta name="robots" content="([^"]*)"/, html),
    links: extractAll(/href="(\/[^"#?]*)"/g, html),
    jsonLd: extractAll(
      /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g,
      html
    )
  };
}

test.describe("indexable surface", () => {
  test("every sitemap URL is unique, canonical, single-h1 and structured", async ({ request }) => {
    const sitemap = await request.get("/sitemap.xml");
    expect(sitemap.status()).toBe(200);
    const xml = await sitemap.text();

    const urls = extractAll(/<loc>([^<]+)<\/loc>/g, xml);
    expect(urls.length, "sitemap should not be empty").toBeGreaterThan(10);

    const origins = new Set(urls.map((u) => new URL(u).origin));
    expect(origins.size, "sitemap must use one canonical origin").toBe(1);

    const paths = urls.map((u) => new URL(u).pathname);
    const pages: Fetched[] = [];
    for (const path of paths) pages.push(await fetchPage(request, path));

    for (const page of pages) {
      expect(page.h1Count, `${page.path} h1 count`).toBe(1);
      expect(page.title.length, `${page.path} title`).toBeGreaterThan(0);
      expect(page.description.length, `${page.path} description`).toBeGreaterThan(0);
      expect(page.robots, `${page.path} must not be noindex`).not.toContain("noindex");

      expect(page.canonical, `${page.path} canonical`).not.toBe("");
      const canonicalPath = new URL(page.canonical).pathname.replace(/\/$/, "") || "/";
      expect(canonicalPath, `${page.path} canonical path`).toBe(page.path.replace(/\/$/, "") || "/");
      expect(new URL(page.canonical).origin, `${page.path} canonical origin`).toBe(
        [...origins][0]
      );

      for (const block of page.jsonLd) {
        const parsed = JSON.parse(block) as { "@context"?: string; "@type"?: string };
        expect(parsed["@context"], `${page.path} JSON-LD context`).toBe("https://schema.org");
        expect(parsed["@type"], `${page.path} JSON-LD type`).toBeTruthy();
      }
    }

    const titles = pages.map((p) => p.title);
    expect(new Set(titles).size, `duplicate titles: ${titles.join(" | ")}`).toBe(titles.length);

    const descriptions = pages.map((p) => p.description);
    expect(new Set(descriptions).size, "duplicate descriptions").toBe(descriptions.length);

    // No orphans: every indexable page must be linked from some other page.
    const inbound = new Map<string, number>();
    for (const page of pages) {
      for (const href of page.links) {
        const target = href.replace(/\/$/, "") || "/";
        if (target === page.path) continue;
        inbound.set(target, (inbound.get(target) ?? 0) + 1);
      }
    }
    for (const page of pages) {
      if (page.path === "/") continue;
      expect(inbound.get(page.path) ?? 0, `${page.path} has no inbound internal link`).toBeGreaterThan(0);
    }
  });

  test("server pages carry BreadcrumbList and SoftwareApplication, never a rating", async ({
    request
  }) => {
    const xml = await (await request.get("/sitemap.xml")).text();
    const serverPath = extractAll(/<loc>([^<]+)<\/loc>/g, xml)
      .map((u) => new URL(u).pathname)
      .find((p) => p.startsWith("/servers/"));
    expect(serverPath, "expected at least one indexed server page").toBeTruthy();

    const page = await fetchPage(request, serverPath!);
    const types = page.jsonLd.map((block) => (JSON.parse(block) as { "@type": string })["@type"]);
    expect(types).toContain("BreadcrumbList");
    expect(types).toContain("SoftwareApplication");
    // Rating markup on somebody else's product is how you collect a manual action.
    expect(page.html).not.toContain("AggregateRating");
    expect(page.html).not.toContain('"@type":"Review"');
  });
});

test.describe("withheld from the index", () => {
  test("robots.txt names the sitemap and keeps /r/ crawlable", async ({ request }) => {
    const response = await request.get("/robots.txt");
    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toContain("Disallow: /api/");
    // A crawler must be able to fetch a report to see its noindex; blocking the
    // path here would strand discovered report URLs in the index.
    expect(body).not.toContain("Disallow: /r/");
    expect(body).toMatch(/Sitemap: https?:\/\/[^\s]+\/sitemap\.xml/);
  });

  test("a user-submitted report renders noindex", async ({ request }) => {
    const created = await request.post("/api/lint", {
      data: {
        mode: "paste",
        snapshot: {
          tools: [{ name: "seo_probe", description: "A throwaway tool used by the SEO crawl test." }]
        }
      }
    });
    // A workstation with real Upstash credentials in .env enforces the hourly
    // paste budget, which repeated local runs can exhaust. CI configures no
    // Upstash, so limiting is off there and a 429 can never mask a real failure.
    test.skip(created.status() === 429, "local paste rate limit reached");
    expect(created.status(), await created.text()).toBe(200);
    const { id } = (await created.json()) as { id: string };

    const report = await request.get(`/r/${id}`);
    expect(report.status()).toBe(200);
    expect(await report.text()).toContain('name="robots" content="noindex');
  });

  test("unknown slugs and rules 404 rather than rendering an empty page", async ({ request }) => {
    for (const path of [
      "/servers/not-a-real-server",
      "/servers/not-a-real-server/opengraph-image",
      "/rules/not-a-real-rule"
    ]) {
      expect((await request.get(path)).status(), path).toBe(404);
    }
  });

  test("a trailing slash redirects to the canonical path", async ({ request }) => {
    const response = await request.get("/rules/", { maxRedirects: 0 });
    expect([301, 308]).toContain(response.status());
    expect(response.headers()["location"]).toMatch(/\/rules$/);
  });
});
