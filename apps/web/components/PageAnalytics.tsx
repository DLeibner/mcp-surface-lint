"use client";

import { useEffect, useRef } from "react";
import { track } from "@/lib/analytics";

/** Fire a PostHog event once when the page mounts (Strict Mode safe). */
export function PageAnalytics({
  event,
  properties
}: {
  event: string;
  properties?: Record<string, unknown>;
}) {
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    track(event, properties);
    // Properties are fixed for the lifetime of the page view.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once on mount
  }, [event]);

  return null;
}
