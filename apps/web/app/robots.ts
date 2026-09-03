import type { MetadataRoute } from "next";
import { canonicalUrl } from "@/lib/seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // User-submitted reports are somebody else's surface behind an
        // unguessable URL; they also carry a noindex tag. AI crawlers are
        // deliberately not blocked — a citation is the point.
        disallow: ["/r/", "/api/"]
      }
    ],
    sitemap: canonicalUrl("/sitemap.xml"),
    host: canonicalUrl("/")
  };
}
