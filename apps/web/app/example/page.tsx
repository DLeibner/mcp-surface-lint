import type { Metadata } from "next";
import Link from "next/link";
import { projectReport } from "mcp-surface-lint";
import { ReportView } from "@/components/ReportView";
import { ReportPageAnalytics } from "@/components/ReportPageAnalytics";
import { currentTier } from "@/lib/lint";
import { getExampleReport } from "@/lib/example-report";

export const metadata: Metadata = {
  title: "Example report — mcplint",
  description:
    "Public sample audit of a fictional MCP tool surface. See token footprint, category scores, and design findings without installing anything."
};

export default function ExampleReportPage() {
  const raw = getExampleReport();
  const report = projectReport(raw, currentTier());

  return (
    <main>
      <ReportPageAnalytics id="example" visibility="public" />
      <div className="panel example-banner">
        <p className="hint" style={{ margin: 0 }}>
          Public example — a fictional catalog server with deliberate design smells. No install or
          paste required.
        </p>
        <Link className="button-link" href="/">
          Audit your own server
        </Link>
      </div>
      <ReportView report={report} />
    </main>
  );
}
