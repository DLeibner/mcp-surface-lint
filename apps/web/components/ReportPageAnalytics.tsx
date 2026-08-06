"use client";

import { PageAnalytics } from "@/components/PageAnalytics";

export function ReportPageAnalytics({
  id,
  visibility
}: {
  id: string;
  visibility: "public" | "unlisted";
}) {
  return (
    <PageAnalytics
      event="report_opened"
      properties={{
        id,
        visibility,
        entry_surface: visibility === "public" ? "public_report" : "web"
      }}
    />
  );
}
