import type { Metadata } from "next";
import Link from "next/link";
import { Analytics } from "@/components/Analytics";
import { ExternalLinkIcon } from "@/components/ExternalLinkIcon";
import "./globals.css";

export const metadata: Metadata = {
  title: "mcplint — audit your MCP server's tool surface",
  description:
    "Static, deterministic analysis of an MCP tool surface: token footprint, design smells, and a 0–100 score. No LLM calls."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Analytics />
        <div className="wrap">
          <header className="site-header">
            <Link href="/" className="brand">
              mcp<span>lint</span>
            </Link>
            <nav className="nav">
              <Link href="/install">Install</Link>
              <Link href="/rules">Rules</Link>
              <a
                className="nav-external"
                href="https://modelcontextprotocol.io"
                target="_blank"
                rel="noreferrer"
              >
                MCP
                <ExternalLinkIcon />
                <span className="visually-hidden"> (opens in new tab)</span>
              </a>
            </nav>
          </header>
          {children}
          <footer>
            Static analysis only — mcplint never invokes your tools and makes no LLM calls.
          </footer>
        </div>
      </body>
    </html>
  );
}
