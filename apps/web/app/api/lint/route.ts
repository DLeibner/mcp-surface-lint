import { NextResponse } from "next/server";
import { LintError, lintRequestSchema, runLint } from "@/lib/lint";
import { checkRateLimit } from "@/lib/rate-limit";
import { getStore, hashIp } from "@/lib/store";
import { ENGINE_VERSION } from "@/lib/version";

// The MCP SDK, undici and node:dns are all Node-only — this cannot run on Edge.
export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_BODY_BYTES = 1024 * 1024;

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "0.0.0.0";
}

export async function POST(request: Request): Promise<NextResponse> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "That snapshot is too large (limit 1 MB)." },
      { status: 413 }
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const parsed = lintRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const ipHash = hashIp(clientIp(request));
  const limit = await checkRateLimit(parsed.data.mode, ipHash);
  if (!limit.ok) {
    if (limit.reason === "not_configured") {
      return NextResponse.json(
        { error: "Audits are unavailable until production rate limiting is configured." },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: "Rate limit reached. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(Math.ceil((limit.resetAt - Date.now()) / 1000)) } }
    );
  }

  try {
    const { report, snapshot, durationMs } = await runLint(parsed.data);
    const { id, deleteToken } = await getStore().create({
      report,
      snapshot,
      ingestMethod: parsed.data.mode,
      durationMs,
      ipHash,
      engineVersion: ENGINE_VERSION
    });

    const response = NextResponse.json({ id, composite: report.scores.composite });
    // The delete token never goes in the URL or the page — it lives in an
    // httpOnly cookie so only the browser that created the run can remove it.
    // Cookie name predates the rename and is deliberately unchanged: renaming it
    // would sign every existing report owner out of their own share controls.
    response.cookies.set(`mcplint_owner_${id}`, deleteToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30
    });
    return response;
  } catch (error) {
    if (error instanceof LintError) {
      const status = error.kind === "too_large" ? 413 : 422;
      return NextResponse.json({ error: error.message, kind: error.kind }, { status });
    }
    console.error("lint failed", error);
    return NextResponse.json({ error: "Something went wrong linting that server." }, { status: 500 });
  }
}
