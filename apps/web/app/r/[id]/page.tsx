import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { projectReport } from "mcp-surface-lint";
import { ReportView } from "@/components/ReportView";
import { ReportPageAnalytics } from "@/components/ReportPageAnalytics";
import { ShareControls } from "@/components/ShareControls";
import { AuditCta } from "@/components/AuditCta";
import { currentTier } from "@/lib/lint";
import { SITE_NAME } from "@/lib/seo";
import { getStore } from "@/lib/store";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const run = await getStore().get(id);
  if (!run) return { title: `Report not found — ${SITE_NAME}` };

  return {
    title: `${run.report.server.name ?? "MCP server"} — ${run.report.scores.composite}/100 — ${SITE_NAME}`,
    // User-submitted reports never enter the index, public or not: they are
    // someone else's surface, they duplicate the directory's own pages, and a
    // shared link should not turn into a search result. robots.txt disallows
    // /r/ as well. Anyone holding the URL can still open one.
    robots: { index: false, follow: false }
  };
}

export default async function ReportPage({ params }: Props) {
  const { id } = await params;
  const run = await getStore().get(id);
  if (!run) notFound();

  const jar = await cookies();
  const isOwner = Boolean(jar.get(`mcplint_owner_${id}`));

  return (
    <main>
      <ReportPageAnalytics id={id} visibility={run.visibility} />
      <ReportView report={projectReport(run.report, currentTier())} />
      {isOwner && <ShareControls id={id} initialVisibility={run.visibility} />}
      <AuditCta id={id} />
    </main>
  );
}
