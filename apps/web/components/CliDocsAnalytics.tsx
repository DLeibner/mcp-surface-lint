"use client";

import { PageAnalytics } from "@/components/PageAnalytics";

export function CliDocsAnalytics() {
  return <PageAnalytics event="cli_docs_opened" properties={{ entry_surface: "cli_docs" }} />;
}
