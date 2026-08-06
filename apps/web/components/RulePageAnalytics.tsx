"use client";

import { PageAnalytics } from "@/components/PageAnalytics";

export function RulePageAnalytics() {
  return <PageAnalytics event="rule_page_opened" properties={{ entry_surface: "rule_page" }} />;
}
