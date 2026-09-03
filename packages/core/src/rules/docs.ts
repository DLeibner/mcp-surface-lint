export class Docs {
  static readonly anthropicToolGuide =
    "https://www.anthropic.com/engineering/writing-tools-for-agents";
  static readonly mcpToolsSpec =
    "https://modelcontextprotocol.io/specification/2025-06-18/server/tools";

  /**
   * Where per-rule documentation lives. The web app serves the rule catalogue at
   * this path and anchors each section with `slug()`, so CLI reports and web
   * reports link to the same place. `MCPLINT_DOCS_BASE` is the pre-rename
   * spelling, still read so a deploy that predates the rename keeps working.
   */
  static docsBase(): string | undefined {
    return process.env.MCP_SURFACE_LINT_DOCS_BASE ?? process.env.MCPLINT_DOCS_BASE;
  }

  static get base(): string {
    return (
      Docs.docsBase() ??
      "https://github.com/DLeibner/mcp-surface-lint/blob/main/packages/core/docs/rules.md"
    );
  }

  /** `design/crud-mirror` -> `design-crud-mirror` */
  static slug(id: string): string {
    return id.replace(/\//g, "-");
  }

  static rule(id: string): string {
    // The hosted catalogue serves one page per rule at `/rules/{slug}`. The
    // repository fallback stays a bare file link because GitHub strips `/` from
    // its generated Markdown heading IDs, so a per-rule anchor would not resolve.
    return Docs.docsBase() ? `${Docs.base}/${Docs.slug(id)}` : Docs.base;
  }
}
