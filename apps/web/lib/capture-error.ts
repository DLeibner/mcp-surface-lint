/**
 * Turn MCP SDK transport failures into playground-friendly copy.
 * These errors come from the user-supplied MCP URL, not from our own /api/lint or /api/mcp.
 */

const REMOTE_SOURCE_NOTE =
  "(This response came from the MCP URL you entered, not from our audit API.)";

const OAUTH_AUTH_ERROR_CODES = new Set([
  "invalid_token",
  "invalid_client",
  "invalid_grant",
  "access_denied",
  "insufficient_scope",
  "unauthorized_client"
]);

export function humanizeCaptureError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);

  const payload = extractJsonPayload(raw);
  if (payload && isTargetAuthFailure(payload)) {
    return authFailureMessage();
  }

  if (isPlainTextAuthFailure(raw)) {
    return authFailureMessage();
  }

  const couldNotResolve = raw.match(/^Could not resolve ([^.\s]+(?:\.[^.\s]+)*)\.$/);
  if (couldNotResolve) {
    const host = couldNotResolve[1]!;
    return (
      `DNS does not list a public address for "${host}". Check the MCP URL for typos ` +
      "(some vendors publish both .com and .xyz). If the hostname is correct, the operator " +
      `may have moved or retired that endpoint. ${REMOTE_SOURCE_NOTE}`
    );
  }

  if (raw.includes("Streamable HTTP error")) {
    return `${stripStreamablePrefix(raw)} ${REMOTE_SOURCE_NOTE}`;
  }

  return raw;
}

function authFailureMessage(): string {
  return (
    "That MCP server requires authentication before we can read tools/list. " +
    "The playground connects from our server to your URL — it does not use your " +
    "Cursor session or browser cookies. " +
    'Expand Optional request headers and add credentials, for example {"Authorization":"Bearer …"} ' +
    "or the vendor-specific API key header the server documents. " +
    "If the server only supports interactive OAuth, switch to Paste tools/list or run the CLI locally. " +
    REMOTE_SOURCE_NOTE
  );
}

function stripStreamablePrefix(message: string): string {
  return message.replace(/^Streamable HTTP error:\s*/i, "").trim();
}

function isPlainTextAuthFailure(message: string): boolean {
  const core = stripStreamablePrefix(message);
  const lower = core.toLowerCase();

  if (/\bunauthorized\b/.test(lower)) return true;
  if (/\b401\b/.test(core)) return true;
  if (/www-authenticate/i.test(message)) return true;
  if (/\bauthentication required\b/.test(lower)) return true;
  if (/\binvalid[_\s-]?token\b/.test(lower)) return true;
  if (/\binvalid[_\s-]?client\b/.test(lower)) return true;
  if (/\baccess[_\s-]?denied\b/.test(lower)) return true;

  return false;
}

function extractJsonPayload(message: string): Record<string, unknown> | undefined {
  const start = message.indexOf("{");
  if (start === -1) return undefined;
  const candidate = message.slice(start);
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Trailing text after JSON — try the common `Error POSTing to endpoint: {...}` shape.
  }

  const match = message.match(/(\{[\s\S]*\})/);
  if (!match) return undefined;
  try {
    const parsed: unknown = JSON.parse(match[1]!);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isTargetAuthFailure(body: Record<string, unknown>): boolean {
  const errorCode = typeof body.error === "string" ? body.error : undefined;
  if (errorCode && OAUTH_AUTH_ERROR_CODES.has(errorCode)) return true;

  const name = typeof body.name === "string" ? body.name : undefined;
  if (name === "AuthenticationRequiredError" || name === "InvalidAuthenticationError") {
    return true;
  }

  const message = typeof body.message === "string" ? body.message.toLowerCase() : "";
  const errorDescription =
    typeof body.error_description === "string" ? body.error_description.toLowerCase() : "";

  return (
    message.includes("authentication required") ||
    message.includes("unauthorized") ||
    errorDescription.includes("access token") ||
    errorDescription.includes("invalid token")
  );
}
