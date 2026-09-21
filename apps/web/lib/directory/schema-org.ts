import { canonicalUrl, SITE_NAME } from "../seo";
import type { DirectoryEntry } from "./catalog";
import { CATEGORY_LABELS } from "./types";

export interface Crumb {
  name: string;
  /** Omitted for the current page, which is the last crumb. */
  path?: string;
}

export function breadcrumbList(crumbs: Crumb[]): object {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: crumb.name,
      ...(crumb.path ? { item: canonicalUrl(crumb.path) } : {})
    }))
  };
}

/**
 * Describes the audited server, not our audit of it.
 *
 * Deliberately no `AggregateRating` or `Review`: the score is a static analysis,
 * not a review, and rating markup applied to somebody else's product is how you
 * collect a manual action.
 */
export function softwareApplication(entry: DirectoryEntry): object {
  const { name, vendor, official_url, description, category } = entry.seed;
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: `${name} MCP Server`,
    url: official_url,
    description,
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: CATEGORY_LABELS[category],
    operatingSystem: "Any",
    author: { "@type": "Organization", name: vendor }
  };
}

export function directoryDataset(dateModified: string | undefined, count: number): object {
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "MCP Server Tool Surface Audits",
    description: `Static audits of ${count} public MCP server tool surfaces: token footprint, schema quality, and tool-selection design, scored out of 100.`,
    url: canonicalUrl("/servers"),
    ...(dateModified ? { dateModified: dateModified.slice(0, 10) } : {}),
    license: "https://creativecommons.org/licenses/by/4.0/",
    creator: { "@type": "Organization", name: "Petabyte", url: canonicalUrl("/") },
    isAccessibleForFree: true
  };
}

export function website(): object {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    url: canonicalUrl("/"),
    description:
      "Static, deterministic audits of MCP server tool surfaces: token footprint, schema quality, and design smells."
  };
}

/** Renders JSON-LD into a script tag. Escapes `<` so a payload cannot close the tag. */
export function jsonLdProps(schema: object): { __html: string } {
  return { __html: JSON.stringify(schema).replace(/</g, "\\u003c") };
}
