#!/usr/bin/env node
/**
 * Pings IndexNow with the URLs a scan changed. One HTTP call, no account, and
 * it reaches Bing and its partners far faster than waiting for a recrawl.
 *
 * Needs INDEXNOW_KEY and NEXT_PUBLIC_SITE_URL. Without either it exits quietly:
 * an unconfigured optional ping must never fail a deploy.
 *
 * Usage: node scripts/indexnow.mjs github,linear,notion
 */
const key = process.env.INDEXNOW_KEY;
const origin = process.env.NEXT_PUBLIC_SITE_URL;
const slugs = (process.argv[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

if (!key || !origin) {
  console.log("indexnow: INDEXNOW_KEY or NEXT_PUBLIC_SITE_URL unset — skipping.");
  process.exit(0);
}
if (slugs.length === 0) {
  console.log("indexnow: nothing changed — skipping.");
  process.exit(0);
}

const host = new URL(origin).host;
const urlList = [
  `${origin}/servers`,
  ...slugs.map((slug) => `${origin}/servers/${slug}`)
];

const response = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify({
    host,
    key,
    keyLocation: `${origin}/indexnow.txt`,
    urlList
  })
});

// 200 and 202 both mean accepted; anything else is worth seeing in the log but
// is not a reason to fail the run.
console.log(`indexnow: ${response.status} for ${urlList.length} URLs`);
if (!response.ok) console.log(await response.text());
