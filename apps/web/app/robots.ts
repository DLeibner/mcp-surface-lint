import type { MetadataRoute } from "next";
import { canonicalUrl } from "@/lib/seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // `/r/` is deliberately NOT disallowed. Reports carry `noindex`, and a
        // crawler has to be able to fetch the page to see it — a robots.txt
        // block would leave a discovered report URL sitting in results as a
        // URL-only entry that nothing can remove. Crawlable + noindex is the
        // combination that actually deindexes.
        //
        // `/api/` has no HTML to carry a directive, so blocking is right there.
        // AI crawlers are not blocked at all: a citation is the point.
        disallow: ["/api/"]
      }
    ],
    sitemap: canonicalUrl("/sitemap.xml"),
    host: canonicalUrl("/")
  };
}
