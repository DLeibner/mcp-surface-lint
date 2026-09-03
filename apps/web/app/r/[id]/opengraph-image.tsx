import { ImageResponse } from "next/og";
import { Scorer } from "mcp-surface-lint";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const alt = "MCP Surface Lint report";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

function color(score: number): string {
  if (score >= 90) return "#34d399";
  if (score >= 50) return "#fbbf24";
  return "#f87171";
}

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await getStore().get(id);

  if (!run) {
    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#0b0d10",
            color: "#e6e9ef",
            fontSize: 48
          }}
        >
          MCP Surface Lint
        </div>
      ),
      size
    );
  }

  const { composite } = run.report.scores;
  const accent = color(composite);

  return new ImageResponse(
    (
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
        <div style={{ display: "flex", fontSize: 30, color: "#939cab" }}>
          MCP Surface Lint · {run.report.server.name ?? "MCP server"}
        </div>

        {/* The token bill is the headline. The score is the follow-up. */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 68, fontWeight: 700, letterSpacing: "-0.03em" }}>
            ~{run.report.stats.approxTokens.toLocaleString()} tokens
          </div>
          <div style={{ display: "flex", fontSize: 34, color: "#939cab", marginTop: 8 }}>
            per conversation · {run.report.stats.toolCount} tools
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
      </div>
    ),
    size
  );
}
