import { expect, test } from "@playwright/test";

test("renders the public example report without auditing", async ({ page }) => {
  await page.goto("/example");
  await expect(page.locator(".composite")).toContainText("/100");
  await expect(page.getByText("example-catalog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Findings" })).toBeVisible();
  await expect(page.locator(".finding").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Audit your own server" })).toHaveAttribute("href", "/");
});

test("redirects /r/example to the public example report", async ({ page }) => {
  await page.goto("/r/example");
  await expect(page).toHaveURL(/\/example$/);
  await expect(page.locator(".composite")).toContainText("/100");
});

test("audits the sample and renders an unlisted report", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Load sample" }).click();
  await expect(page.getByLabel("tools/list JSON")).toContainText("search_hotels");

  await page.getByRole("button", { name: "Audit surface" }).click();
  await expect(page).toHaveURL(/\/r\/[A-Za-z0-9]+$/);
  await expect(page.locator(".composite")).toContainText("/100");
  await expect(page.locator(".share .hint")).toContainText(
    "Unlisted — anyone with the link can see it."
  );
  await expect(page.getByRole("heading", { name: "Findings" })).toBeVisible();
  await expect(page.locator(".rule-id").first()).toHaveAttribute("href", /\/rules#/);
});

test("loads a tools/list JSON file", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({
    name: "snapshot.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        tools: [{ name: "search_items", description: "Search items by query." }]
      })
    )
  });
  await expect(page.getByLabel("tools/list JSON")).toContainText("search_items");
});

test("rejects a non-HTTPS remote endpoint", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Remote MCP URL" }).click();
  await page.getByLabel("MCP server URL").fill("http://example.com/mcp");
  await page.getByRole("button", { name: "Audit surface" }).click();
  await expect(page.getByText(/Only https:\/\//)).toBeVisible();
});

test("shows provider install links and the installed Grafana prompt", async ({ page }) => {
  await page.goto("/install");
  await expect(
    page.getByText("Check my installed Grafana MCP server using the MCPLint tool.")
  ).toBeVisible();

  const cursor = page.getByRole("link", { name: "Install in Cursor" });
  await expect(cursor).toHaveAttribute(
    "href",
    /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install/
  );

  await page.getByRole("tab", { name: "VS Code" }).click();
  await expect(page.getByRole("link", { name: "Install in VS Code" })).toHaveAttribute(
    "href",
    /^vscode:mcp\/install\?/
  );

  await page.getByRole("tab", { name: "Claude" }).click();
  await expect(page.getByText(/claude mcp add --transport http/)).toBeVisible();
});
