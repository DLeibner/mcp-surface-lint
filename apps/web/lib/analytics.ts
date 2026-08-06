"use client";

import posthog from "posthog-js";

let started = false;
const CAMPAIGN_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "campaign_post",
  "entry_surface",
  "install_target",
  "audit_mode"
] as const;

function campaignProperties(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const fromUrl = new URLSearchParams(window.location.search);
  const current = Object.fromEntries(
    CAMPAIGN_KEYS.flatMap((key) => {
      const value = fromUrl.get(key);
      return value ? [[key, value.slice(0, 100)]] : [];
    })
  );

  if (Object.keys(current).length > 0) {
    window.sessionStorage.setItem("mcplint_campaign", JSON.stringify(current));
    return current;
  }

  try {
    const stored = JSON.parse(
      window.sessionStorage.getItem("mcplint_campaign") ?? "{}"
    ) as Record<string, unknown>;
    return Object.fromEntries(
      CAMPAIGN_KEYS.flatMap((key) =>
        typeof stored[key] === "string" ? [[key, stored[key] as string]] : []
      )
    );
  } catch {
    return {};
  }
}

/**
 * PostHog, initialised lazily and only when a key is configured — so local dev
 * and self-hosting produce no network traffic at all.
 *
 * We never send report contents, server names, or tool schemas. Only the shape
 * of the interaction: which mode was used, whether it worked, what it scored.
 *
 * MCP tool calls from AI clients are tracked server-side in analytics-server.ts.
 */
export function initAnalytics(): void {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key || started || typeof window === "undefined") return;
  posthog.init(key, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
    person_profiles: "always",
    capture_pageview: true
  });
  const campaign = campaignProperties();
  posthog.register(campaign);
  if (Object.keys(campaign).length > 0 && !window.sessionStorage.getItem("mcplint_campaign_landing_sent")) {
    window.sessionStorage.setItem("mcplint_campaign_landing_sent", "1");
    posthog.capture("campaign_landing", campaign);
  }
  started = true;
}

export function track(event: string, properties?: Record<string, unknown>): void {
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY || typeof window === "undefined") return;
  posthog.capture(event, { ...campaignProperties(), ...properties });
}
