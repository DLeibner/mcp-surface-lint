import { NextResponse, type NextRequest } from "next/server";
import { checkAdminAuth } from "@/lib/admin-auth";

export const config = { matcher: ["/admin/:path*"] };

/**
 * `/admin` shows what the LLM layer spends. It sits behind HTTP Basic auth with
 * the password in `ADMIN_PASSWORD`; with that unset it is open in development
 * and does not exist in production — the page must never be reachable by
 * accident.
 */
export function middleware(request: NextRequest): NextResponse {
  const verdict = checkAdminAuth(
    request.headers.get("authorization"),
    process.env.ADMIN_PASSWORD,
    process.env.NODE_ENV === "production"
  );
  if (verdict === "allow") return NextResponse.next();
  if (verdict === "not-configured") return new NextResponse("Not found.", { status: 404 });
  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="MCP Surface Lint admin", charset="UTF-8"' }
  });
}
