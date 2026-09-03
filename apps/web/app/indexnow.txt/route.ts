/**
 * IndexNow key verification file. IndexNow lets the key live at any path on the
 * host as long as the ping declares `keyLocation`, so this stays a fixed route
 * rather than a `{key}.txt` file that would change whenever the key rotates.
 */
export const dynamic = "force-static";

export function GET(): Response {
  const key = process.env.INDEXNOW_KEY;
  if (!key) return new Response("Not found", { status: 404 });
  return new Response(key, {
    headers: { "content-type": "text/plain; charset=utf-8" }
  });
}
