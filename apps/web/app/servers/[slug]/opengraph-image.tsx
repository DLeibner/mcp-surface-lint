import { ImageResponse } from "next/og";
import { Scorer } from "mcp-surface-lint";
import { findEntry, loadCatalog } from "@/lib/directory/catalog";

export const alt = "MCP Surface Lint audit";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Rendered at build time into a static PNG for every server, because the route
 * is statically generated. No runtime image endpoint, no vendor logos — text
 * only, which sidesteps the trademark question entirely.
 */
export function generateStaticParams(): { slug: string }[] {
  return loadCatalog().entries.map((entry) => ({ slug: entry.seed.slug }));
}

function color(score: number): string {
  if (score >= 90) return "#34d399";
  if (score >= 50) return "#fbbf24";
  return "#f87171";
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const entry = findEntry(loadCatalog(), slug);
  const scanned = entry?.scanned;

  const shell = (children: React.ReactNode) => (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#0b0d10",
        color: "#e6e9ef",
        padding: "64px 72px",
        fontFamily: "sans-serif"
      }}
    >
      {children}
    </div>
  );

  if (!entry || !scanned) {
    return new ImageResponse(
      shell(
        <>
          <div style={{ display: "flex", fontSize: 30, color: "#939cab" }}>MCP Surface Lint</div>
          <div style={{ display: "flex", fontSize: 62, fontWeight: 700 }}>
            {entry?.seed.name ?? "MCP server"} MCP server
          </div>
          <div style={{ display: "flex", fontSize: 32, color: "#939cab" }}>
            Tool surface audit pending
          </div>
        </>
      ),
      size
    );
  }

  const { composite } = scanned.score;
  const accent = color(composite);

  return new ImageResponse(
    shell(
      <>
        <div style={{ display: "flex", fontSize: 30, color: "#939cab" }}>
          MCP Surface Lint · {entry.seed.name} MCP server
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 68, fontWeight: 700, letterSpacing: "-0.03em" }}>
            ~{scanned.token_footprint.tokens.toLocaleString("en-US")} tokens
          </div>
          <div style={{ display: "flex", fontSize: 34, color: "#939cab", marginTop: 8 }}>
            per conversation · {scanned.tool_count} tools
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 128,
              height: 128,
              borderRadius: 20,
              border: `4px solid ${accent}`,
              color: accent,
              fontSize: 72,
              fontWeight: 700
            }}
          >
            {Scorer.grade(composite)}
          </div>
          <div style={{ display: "flex", fontSize: 56, fontWeight: 600 }}>{composite}/100</div>
        </div>
      </>
    ),
    size
  );
}
