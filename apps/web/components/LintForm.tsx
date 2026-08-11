"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { track } from "@/lib/analytics";
import { EXAMPLE_REPORT_PATH } from "@/lib/example-report-path";

type Mode = "paste" | "url";

const SAMPLE_SNAPSHOT = {
  serverInfo: { name: "example-travel", version: "1.0.0" },
  tools: [
    {
      name: "search_hotels",
      description: "Search available hotels by destination, dates, guests, and preferences.",
      inputSchema: {
        type: "object",
        properties: {
          destination: { type: "string", description: "City or region to search." },
          checkIn: { type: "string", format: "date" },
          checkOut: { type: "string", format: "date" }
        },
        required: ["destination", "checkIn", "checkOut"]
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    {
      name: "get_hotel",
      description: "Get details for one hotel by its stable identifier.",
      inputSchema: {
        type: "object",
        properties: { hotelId: { type: "string" } },
        required: ["hotelId"]
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    }
  ]
};

function parseHeaders(raw: string): Record<string, string> | undefined {
  if (!raw.trim()) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Headers must be a JSON object.");
  }
  if (Object.values(parsed).some((value) => typeof value !== "string")) {
    throw new Error("Every header value must be a string.");
  }
  return parsed as Record<string, string>;
}

export function LintForm() {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<Mode>("paste");
  const [pasted, setPasted] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > 1024 * 1024) {
      setError("That file is too large. Snapshot uploads are limited to 1 MB.");
      return;
    }
    try {
      const text = await file.text();
      JSON.parse(text);
      setPasted(text);
      track("snapshot_loaded", { source: "upload" });
    } catch {
      setError("That file is not valid JSON.");
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    let body: unknown;
    if (mode === "paste") {
      try {
        body = { mode: "paste", snapshot: JSON.parse(pasted) };
      } catch {
        setError(
          "That isn't valid JSON. Paste a tools/list response or the output of `mcplint --dump`."
        );
        return;
      }
    } else {
      try {
        body = { mode: "url", url, headers: parseHeaders(headers) };
      } catch (headerError) {
        setError(headerError instanceof Error ? headerError.message : "Headers are not valid JSON.");
        return;
      }
    }

    setBusy(true);
    track("lint_started", { mode, audit_mode: mode, entry_surface: "web" });
    try {
      const response = await fetch("/api/lint", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !data.id) {
        track("lint_failed", { mode, audit_mode: mode, entry_surface: "web", status: response.status });
        setError(data.error ?? "Something went wrong.");
        setBusy(false);
        return;
      }
      track("lint_succeeded", { mode, audit_mode: mode, entry_surface: "web" });
      router.push(`/r/${data.id}`);
    } catch {
      track("lint_failed", { mode, audit_mode: mode, entry_surface: "web", status: 0 });
      setError("Could not reach the server. Check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={submit}>
      <div className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className="tab"
          aria-selected={mode === "paste"}
          onClick={() => setMode("paste")}
        >
          Paste tools/list
        </button>
        <button
          type="button"
          role="tab"
          className="tab"
          aria-selected={mode === "url"}
          onClick={() => setMode("url")}
        >
          Remote MCP URL
        </button>
      </div>

      {mode === "paste" ? (
        <>
          <textarea
            rows={10}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder={'{\n  "tools": [\n    { "name": "search_hotels", "description": "…" }\n  ]\n}'}
            spellCheck={false}
            aria-label="tools/list JSON"
          />
          <div className="form-actions">
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              className="visually-hidden"
              onChange={(event) => void loadFile(event.target.files?.[0])}
            />
            <button className="ghost" type="button" onClick={() => fileInput.current?.click()}>
              Upload JSON
            </button>
            <button
              className="ghost"
              type="button"
              onClick={() => {
                setPasted(JSON.stringify(SAMPLE_SNAPSHOT, null, 2));
                setError(null);
                track("snapshot_loaded", { source: "sample" });
              }}
            >
              Load sample
            </button>
            <Link className="ghost button-link" href={EXAMPLE_REPORT_PATH}>
              See example report
            </Link>
            {pasted && (
              <button className="ghost" type="button" onClick={() => setPasted("")}>
                Clear
              </button>
            )}
          </div>
          <div className="row">
            <p className="hint">
              Paste, upload, or try the sample. Reports are unlisted by default and removable by
              their creator.
            </p>
            <button className="primary" type="submit" disabled={busy || !pasted.trim()}>
              {busy ? "Auditing…" : "Audit surface"}
            </button>
          </div>
        </>
      ) : (
        <>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/mcp"
            aria-label="MCP server URL"
          />
          <details className="headers-panel">
            <summary>Optional request headers</summary>
            <label htmlFor="request-headers">
              JSON object
              <textarea
                id="request-headers"
                rows={4}
                value={headers}
                onChange={(event) => setHeaders(event.target.value)}
                placeholder={'{\n  "Authorization": "Bearer …"\n}'}
                spellCheck={false}
              />
            </label>
            <p className="hint">
              Headers are used only for this capture. Prefer the local CLI for sensitive
              credentials.
            </p>
          </details>
          <div className="row">
            <p className="hint">
              https only. We connect from our server (not your Cursor session), read{" "}
              <code>tools/list</code>, and disconnect — no tool is ever called. Protected servers
              need a Bearer token or API key in optional headers below.
            </p>
            <button className="primary" type="submit" disabled={busy || !url.trim()}>
              {busy ? "Connecting…" : "Audit surface"}
            </button>
          </div>
        </>
      )}

      {error && <div className="error-box">{error}</div>}
    </form>
  );
}
