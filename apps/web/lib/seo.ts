import type { Metadata } from "next";
import { siteUrl } from "./site";

export const SITE_NAME = "MCP Surface Lint";

/**
 * Absolute URL on the canonical apex host. Every indexable page emits one of
 * these, so a page served from a `*.vercel.app` alias or the legacy subdomain
 * still points search engines at the apex.
 *
 * Trailing slashes are stripped to match the framework's redirect policy
 * (`trailingSlash: false`); only the root keeps one, as is conventional.
 */
export function canonicalUrl(path: string): string {
  const origin = siteUrl();
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? `${origin}/` : `${origin}/${trimmed}`;
}

export interface PageSeo {
  /** Path relative to the apex, e.g. `/rules`. */
  path: string;
  title: string;
  description: string;
  /** Keeps the page out of search indexes and out of the sitemap. */
  noindex?: boolean;
  ogType?: "website" | "article";
}

/**
 * The single place a page's title, description, canonical, and social tags are
 * derived from one another. Pages that build metadata by hand drift; the SEO
 * acceptance checks assert against what this returns.
 */
export function pageMetadata({
  path,
  title,
  description,
  noindex,
  ogType = "website"
}: PageSeo): Metadata {
  const url = canonicalUrl(path);
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, siteName: SITE_NAME, type: ogType },
    twitter: { card: "summary_large_image", title, description },
    ...(noindex ? { robots: { index: false, follow: false } } : {})
  };
}
