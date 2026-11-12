import { errorMessage } from "./client";

/**
 * Orders scorecards by how often they were read in the last 30 days, from the
 * pageviews PostHog already records. Needs a personal API key with query
 * access (POSTHOG_PERSONAL_API_KEY) and the project id (POSTHOG_PROJECT_ID).
 * Without them, or if the query fails, the given order stands: until the
 * directory outgrows the pass, every server is in it anyway.
 */
export async function rankByViews(
  slugs: readonly string[],
  log: (line: string) => void,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<string[]> {
  const apiKey = env.POSTHOG_PERSONAL_API_KEY;
  const project = env.POSTHOG_PROJECT_ID;
  if (!apiKey || !project) return [...slugs];

  const host = (env.POSTHOG_API_HOST || "https://us.posthog.com").replace(/\/$/, "");
  const query =
    "SELECT properties.$pathname AS path, count() AS views FROM events " +
    "WHERE event = '$pageview' AND timestamp > now() - INTERVAL 30 DAY " +
    "AND properties.$pathname LIKE '/servers/%' GROUP BY path ORDER BY views DESC LIMIT 1000";
  try {
    const response = await fetchImpl(`${host}/api/projects/${encodeURIComponent(project)}/query/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query } })
    });
    if (!response.ok) throw new Error(`PostHog answered ${response.status}`);
    const { results } = (await response.json()) as { results?: [unknown, unknown][] };
    const views = new Map<string, number>();
    for (const [path, count] of results ?? []) {
      const slug = typeof path === "string" ? /^\/servers\/([a-z0-9-]+)\/?$/.exec(path)?.[1] : undefined;
      if (slug) views.set(slug, (views.get(slug) ?? 0) + Number(count));
    }
    return [...slugs].sort((a, b) => (views.get(b) ?? 0) - (views.get(a) ?? 0) || slugs.indexOf(a) - slugs.indexOf(b));
  } catch (caught) {
    log(`Could not rank scorecards by views (${errorMessage(caught)}); using directory order.`);
    return [...slugs];
  }
}
