"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { track } from "@/lib/analytics";

export function ShareControls({
  id,
  initialVisibility
}: {
  id: string;
  initialVisibility: "unlisted" | "public";
}) {
  const router = useRouter();
  const [visibility, setVisibility] = useState(initialVisibility);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    const next = visibility === "public" ? "unlisted" : "public";
    setBusy(true);
    const response = await fetch(`/api/report/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visibility: next })
    });
    setBusy(false);
    if (response.ok) {
      setVisibility(next);
      if (next === "public") track("report_shared", { id });
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function remove() {
    if (!confirm("Delete this report permanently? This cannot be undone.")) return;
    setBusy(true);
    const response = await fetch(`/api/report/${id}`, { method: "DELETE" });
    if (response.ok) router.push("/");
    else setBusy(false);
  }

  return (
    <div className="share">
      <button className="ghost" type="button" onClick={copy}>
        {copied ? "Copied" : "Copy link"}
      </button>
      <button className="ghost" type="button" onClick={toggle} disabled={busy}>
        {visibility === "public" ? "Make unlisted" : "Make public"}
      </button>
      <button className="ghost" type="button" onClick={remove} disabled={busy}>
        Delete
      </button>
      <span className="hint">
        {visibility === "public"
          ? "Public — anyone with the link can see it, and it stays available until you delete it. Reports remain excluded from search engines."
          : "Unlisted — anyone with the link can see it. Not indexed. Auto-deleted after 30 days."}
      </span>
    </div>
  );
}
