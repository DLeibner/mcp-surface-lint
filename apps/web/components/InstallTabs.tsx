"use client";

import { useMemo, useState } from "react";
import { track } from "@/lib/analytics";
import { cursorInstallUrl, vscodeInstallUrl } from "@/lib/install-links";

type ClientId = "cursor" | "vscode" | "claude" | "windsurf" | "generic";

interface ClientConfig {
  id: ClientId;
  label: string;
  location: string;
  code: string;
  note: string;
  installHref?: string;
  installLabel?: string;
}

export function InstallTabs({ endpoint }: { endpoint: string }) {
  const configs = useMemo<ClientConfig[]>(() => {
    return [
      {
        id: "cursor",
        label: "Cursor",
        location: ".cursor/mcp.json or ~/.cursor/mcp.json",
        code: JSON.stringify(
          { mcpServers: { mcplint: { url: endpoint } } },
          null,
          2
        ),
        note: "Review Cursor's native confirmation before installing. The button contains only the public endpoint, never credentials.",
        installHref: cursorInstallUrl(endpoint),
        installLabel: "Install in Cursor"
      },
      {
        id: "vscode",
        label: "VS Code",
        location: ".vscode/mcp.json or your user-profile mcp.json",
        code: JSON.stringify(
          { servers: { mcplint: { type: "http", url: endpoint } } },
          null,
          2
        ),
        note: "Review VS Code's trust prompt before starting the server.",
        installHref: vscodeInstallUrl(endpoint),
        installLabel: "Install in VS Code"
      },
      {
        id: "claude",
        label: "Claude",
        location: "Claude Code command",
        code: `claude mcp add --transport http --scope user mcplint ${endpoint}`,
        note: "For Claude, Cowork, or Claude Desktop, open Customize → Connectors → Add custom connector and enter the same endpoint URL."
      },
      {
        id: "windsurf",
        label: "Windsurf",
        location: "~/.codeium/windsurf/mcp_config.json",
        code: JSON.stringify(
          { mcpServers: { mcplint: { serverUrl: endpoint } } },
          null,
          2
        ),
        note: "Open Cascade’s MCP settings or edit the raw configuration, then refresh the server list."
      },
      {
        id: "generic",
        label: "Generic",
        location: "Streamable HTTP",
        code: JSON.stringify(
          {
            mcpServers: {
              mcplint: {
                type: "streamable-http",
                url: endpoint
              }
            }
          },
          null,
          2
        ),
        note: "Use this shape for clients that accept standard remote MCP metadata; some hosts omit type or use a different top-level key."
      }
    ];
  }, [endpoint]);
  const [selected, setSelected] = useState<ClientId>("cursor");
  const [copied, setCopied] = useState(false);
  const active = configs.find((config) => config.id === selected) ?? configs[0]!;

  async function copy() {
    await navigator.clipboard.writeText(active.code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <section className="install-widget" aria-label="MCP client configuration">
      <div className="tabs install-tabs" role="tablist" aria-label="Choose an MCP client">
        {configs.map((config) => (
          <button
            key={config.id}
            type="button"
            role="tab"
            className="tab"
            aria-selected={selected === config.id}
            onClick={() => {
              setSelected(config.id);
              setCopied(false);
            }}
          >
            {config.label}
          </button>
        ))}
      </div>
      <div className="config-head">
        <span className="hint">{active.location}</span>
        <button className="ghost" type="button" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="code-block">
        <code>{active.code}</code>
      </pre>
      <p className="hint">{active.note}</p>
      {active.installHref && (
        <a
          className="button-link install-button"
          href={active.installHref}
          onClick={() =>
            track("mcp_install_clicked", {
              install_target: active.id === "cursor" ? "cursor" : "",
              entry_surface: "cursor_install"
            })
          }
        >
          {active.installLabel}
        </a>
      )}
    </section>
  );
}
