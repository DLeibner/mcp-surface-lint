export type AdminAuthVerdict = "allow" | "challenge" | "not-configured";

/** Compares every byte regardless of where the first mismatch is. Runs on the Edge runtime. */
function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/**
 * HTTP Basic auth for `/admin`. Any username is accepted; the password must
 * match `ADMIN_PASSWORD`. Unconfigured, the area is open in development and
 * absent in production.
 */
export function checkAdminAuth(
  header: string | null,
  password: string | undefined,
  production: boolean
): AdminAuthVerdict {
  if (!password) return production ? "not-configured" : "allow";
  if (!header?.startsWith("Basic ")) return "challenge";

  let decoded: string;
  try {
    // The challenge advertises charset="UTF-8", so browsers send UTF-8 bytes.
    const binary = atob(header.slice("Basic ".length).trim());
    decoded = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return "challenge";
  }
  const separator = decoded.indexOf(":");
  if (separator === -1) return "challenge";
  return constantTimeEqual(decoded.slice(separator + 1), password) ? "allow" : "challenge";
}
