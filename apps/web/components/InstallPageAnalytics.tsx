"use client";

import { PageAnalytics } from "@/components/PageAnalytics";

export function InstallPageAnalytics() {
  return (
    <PageAnalytics event="install_page_opened" properties={{ entry_surface: "cursor_install" }} />
  );
}
