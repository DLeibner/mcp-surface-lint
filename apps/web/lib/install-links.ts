function publicEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MCP endpoint must use HTTP or HTTPS.");
  }
  return url.toString();
}

export function cursorInstallUrl(endpoint: string): string {
  const config = { url: publicEndpoint(endpoint) };
  return (
    "cursor://anysphere.cursor-deeplink/mcp/install" +
    `?name=${encodeURIComponent("mcp-surface-lint")}` +
    `&config=${encodeURIComponent(btoa(JSON.stringify(config)))}`
  );
}

export function vscodeInstallUrl(endpoint: string): string {
  const config = {
    name: "mcp-surface-lint",
    type: "http",
    url: publicEndpoint(endpoint)
  };
  return `vscode:mcp/install?${encodeURIComponent(JSON.stringify(config))}`;
}
