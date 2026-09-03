import type { Metadata } from "next";
import Link from "next/link";
import { Analytics } from "@/components/Analytics";
import { ExternalLinkIcon } from "@/components/ExternalLinkIcon";
import { SITE_NAME } from "@/lib/seo";
import { siteUrl } from "@/lib/site";
import "./globals.css";

export const metadata: Metadata = {
  // `metadataBase` resolves every relative canonical and OG URL against the
  // apex host, so nothing ever emits a vercel.app or legacy-subdomain URL.
  metadataBase: new URL(siteUrl()),
  title: `${SITE_NAME} — audit your MCP server's tool surface`,
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
              MCP Surface <span>Lint</span>
            </Link>
            <nav className="nav">
              <Link href="/servers">Directory</Link>
              <Link href="/rules">Rules</Link>
              <Link href="/install">Install</Link>
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
            <nav className="footer-nav" aria-label="Footer">
              <Link href="/servers">Directory</Link>
              <Link href="/rules">Rules</Link>
              <Link href="/methodology">Methodology</Link>
              <Link href="/audit">Fix plan</Link>
              <Link href="/install">Install</Link>
              <Link href="/example">Example report</Link>
              <a href="mailto:hello@mcp-surface-lint.com">Contact</a>
            </nav>
            <p>
              Static analysis only — {SITE_NAME} never invokes your tools and makes no LLM calls.
            </p>
          </footer>
        </div>
      </body>
    </html>
  );
}
