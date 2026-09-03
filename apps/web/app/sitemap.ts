import type { MetadataRoute } from "next";
import { indexablePages } from "@/lib/directory/indexing";
import { canonicalUrl } from "@/lib/seo";

/**
 * Generated from the same list the pages derive their `noindex` from, so a page
 * can never be excluded from the index and advertised in the sitemap at once.
 * Next splits this into a sitemap index automatically past 50,000 URLs.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return indexablePages().map((page) => ({
    url: canonicalUrl(page.path),
    lastModified: page.lastModified
  }));
}
