/**
 * Server-side PostHog capture for paths that never touch the browser — MCP tool
 * calls from Cursor, Claude, VS Code, etc.
 *
 * Same privacy boundary as the client helper: no schemas, server names, or URLs.
 */
export function mcpAuditMode(mode: "paste" | "url"): "snapshot" | "url" {
  return mode === "paste" ? "snapshot" : "url";
}

export function trackServer(
  event: string,
  properties: Record<string, unknown>,
  distinctId: string
): void {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return;

  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";
  void fetch(`${host}/capture/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      event,
      distinct_id: distinctId,
      properties: {
        ...properties,
        $lib: "mcplint-server"
      }
    })
  }).catch((error) => {
    console.error("PostHog capture failed", error);
  });
}
