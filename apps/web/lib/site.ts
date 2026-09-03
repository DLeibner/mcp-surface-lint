const LOCAL_SITE_URL = "http://localhost:3000";

function normalizeSiteUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("NEXT_PUBLIC_SITE_URL must use http or https.");
  }
  return url.origin;
}

let warnedAboutFallback = false;

export function siteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) return normalizeSiteUrl(configured);

  const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercelHost) {
    // This fallback is right for preview deployments and wrong for production:
    // every canonical, sitemap entry and OG URL would name the deployment host
    // instead of the apex. Say so loudly rather than shipping it quietly.
    if (!warnedAboutFallback && vercelHost.endsWith(".vercel.app")) {
      warnedAboutFallback = true;
      console.warn(
        `[site] NEXT_PUBLIC_SITE_URL is unset — canonical URLs will point at ` +
          `https://${vercelHost}. Set it to the apex origin for any production build.`
      );
    }
    return normalizeSiteUrl(`https://${vercelHost}`);
  }

  return LOCAL_SITE_URL;
}

export function mcpEndpointUrl(): string {
  return `${siteUrl()}/api/mcp`;
}
