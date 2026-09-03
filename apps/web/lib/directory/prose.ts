import { RuleRegistry, Scorer, type Category } from "mcp-surface-lint";
import { RULE_CATEGORY_FRAGMENTS } from "../rule-categories";
import { rankInCategory, relatedServers, type Catalog, type DirectoryEntry } from "./catalog";
import { CATEGORY_LABELS, type ScanFinding, type ScannedResult } from "./types";

/** A representative modern context window, used only to make the token bill legible. */
const REFERENCE_CONTEXT = 200_000;

/** §6.3: below this, a page is too thin to index and gets `noindex` automatically. */
export const MIN_PROSE_WORDS = 300;

export interface ServerProse {
  /** Section 4 of the page: the plain-language summary. */
  summary: string[];
  /** Section 5: what the token number means. */
  footprint: string[];
  /** Intro above the grouped findings in section 6. */
  findings: string[];
  /** "What this surface does well" — always present, never an empty page. */
  strengths: string[];
  /** Section 7: what the tool table shows once you read it. */
  inventory: string[];
  /** Section 8: how it compares to its category. */
  comparison: string[];
  wordCount: number;
}

/** FNV-1a. Stable across processes and Node versions, which `hashCode` tricks are not. */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Deterministic sentence variation. Two servers with the same shape must not
 * produce the same paragraph, or the whole directory reads as one template —
 * which is precisely what gets programmatic pages filtered out of an index.
 */
function pick<T>(variants: readonly T[], slug: string, salt: string): T {
  return variants[hash(`${slug}:${salt}`) % variants.length]!;
}

function n(value: number): string {
  return value.toLocaleString("en-US");
}

function pct(part: number, whole: number): number {
  return Math.round((part / whole) * 100);
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

interface RuleGroup {
  ruleId: string;
  category: Category;
  count: number;
  tools: string[];
  rationale: string;
  example?: ScanFinding;
}

function groupFindings(findings: ScanFinding[]): RuleGroup[] {
  const groups = new Map<string, RuleGroup>();
  for (const finding of findings) {
    if (finding.severity === "info") continue;
    const rule = RuleRegistry.byId(finding.rule_id);
    const existing = groups.get(finding.rule_id);
    if (existing) {
      existing.count += 1;
      if (finding.tool_name && !existing.tools.includes(finding.tool_name)) {
        existing.tools.push(finding.tool_name);
      }
      continue;
    }
    groups.set(finding.rule_id, {
      ruleId: finding.rule_id,
      category: (rule?.category ?? finding.category) as Category,
      count: 1,
      tools: finding.tool_name ? [finding.tool_name] : [],
      rationale: rule?.rationale ?? finding.message,
      example: finding
    });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId));
}

function categoryRanking(scanned: ScannedResult): { best: Category; worst: Category } {
  const scored = Scorer.categories.map((c) => ({ c, v: scanned.score.categories[c] ?? 100 }));
  const sorted = [...scored].sort((a, b) => a.v - b.v || a.c.localeCompare(b.c));
  return { worst: sorted[0]!.c, best: sorted.at(-1)!.c };
}

function summaryProse(entry: DirectoryEntry, scanned: ScannedResult): string[] {
  const { slug, name, category } = entry.seed;
  const tools = scanned.tool_count;
  const tokens = scanned.token_footprint.tokens;
  const score = scanned.score.composite;
  const grade = Scorer.grade(score);
  const counted = scanned.findings.filter((f) => f.severity !== "info");
  const categoriesTouched = new Set(counted.map((f) => f.category)).size;

  const opening = pick(
    [
      `${name}'s MCP server publishes ${n(tools)} tools. Loaded into a conversation, those definitions occupy roughly ${n(tokens)} tokens of context before anyone types a word.`,
      `Every conversation with the ${name} MCP server begins with ${n(tools)} tool definitions already in context — about ${n(tokens)} tokens of it.`,
      `The ${name} MCP server exposes ${n(tools)} tools whose definitions cost approximately ${n(tokens)} tokens in every single conversation, whether or not any of them is ever called.`
    ],
    slug,
    "opening"
  );

  const scoring =
    counted.length === 0
      ? pick(
          [
            `MCP Surface Lint scores that surface ${score} out of 100 (grade ${grade}) with no scored findings against it.`,
            `Against the 19 static rules in the catalogue the surface scores ${score} out of 100 — grade ${grade} — and triggers no scored findings.`
          ],
          slug,
          "scoring-clean"
        )
      : pick(
          [
            `MCP Surface Lint scores that surface ${score} out of 100 (grade ${grade}), with ${n(counted.length)} scored findings spread across ${categoriesTouched} of the six rule categories.`,
            `Against the 19 static rules in the catalogue it scores ${score} out of 100 — grade ${grade} — raising ${n(counted.length)} scored findings in ${categoriesTouched} of the six categories.`,
            `The composite score is ${score} out of 100 (grade ${grade}), built from ${n(counted.length)} scored findings touching ${categoriesTouched} of the six rule categories.`
          ],
          slug,
          "scoring"
        );

  const { best, worst } = categoryRanking(scanned);
  const bestScore = scanned.score.categories[best] ?? 100;
  const worstScore = scanned.score.categories[worst] ?? 100;
  const spread =
    best === worst
      ? `All six categories land on ${bestScore}/100, so nothing stands out in either direction.`
      : pick(
          [
            `Its strongest category is ${best} at ${bestScore}/100; the weakest is ${worst} at ${worstScore}/100.`,
            `${best[0]!.toUpperCase()}${best.slice(1)} is the strongest category at ${bestScore}/100, and ${worst} the weakest at ${worstScore}/100.`,
            `The spread runs from ${bestScore}/100 for ${best} down to ${worstScore}/100 for ${worst}.`
          ],
          slug,
          "spread"
        );

  const placement = `It is catalogued here under ${CATEGORY_LABELS[category]}, alongside other servers agents reach for in the same kind of work.`;

  return [`${opening} ${scoring}`, `${spread} ${placement}`];
}

function footprintProse(
  entry: DirectoryEntry,
  scanned: ScannedResult,
  catalog: Catalog
): string[] {
  const { slug, name, category } = entry.seed;
  const tokens = scanned.token_footprint.tokens;
  const share = pct(tokens, REFERENCE_CONTEXT);
  const perTool = Math.round(tokens / Math.max(scanned.tool_count, 1));

  const scale = pick(
    [
      `At ${n(tokens)} tokens the surface takes about ${share}% of a ${n(REFERENCE_CONTEXT)}-token context window, and it takes it on every turn — this is rent, not a one-off cost.`,
      `${n(tokens)} tokens is roughly ${share}% of a ${n(REFERENCE_CONTEXT)}-token window, paid again on every request rather than once per session.`,
      `Measured against a ${n(REFERENCE_CONTEXT)}-token window, the surface consumes about ${share}% of it before the conversation starts, and keeps consuming it on every turn.`
    ],
    slug,
    "scale"
  );

  const density = `That averages ${n(perTool)} tokens per tool definition, counted with the ${scanned.token_footprint.tokenizer} encoding.`;

  const stats = catalog.stats.get(category);
  const medianTokens = stats?.medianTokens;
  let comparison: string;
  if (medianTokens === undefined || medianTokens === 0) {
    comparison = `There is no category median to compare against yet — ${CATEGORY_LABELS[category]} needs more scanned members first.`;
  } else if (tokens === medianTokens) {
    comparison = `That lands exactly on the ${CATEGORY_LABELS[category]} median of ${n(medianTokens)} tokens.`;
  } else {
    const delta = Math.abs(pct(tokens - medianTokens, medianTokens));
    const direction = tokens > medianTokens ? "above" : "below";
    comparison = pick(
      [
        `The median ${CATEGORY_LABELS[category]} server in this directory carries ${n(medianTokens)} tokens, so ${name} sits about ${delta}% ${direction} its peers.`,
        `Compared with the ${CATEGORY_LABELS[category]} median of ${n(medianTokens)} tokens, ${name} is roughly ${delta}% ${direction}.`,
        `Against a category median of ${n(medianTokens)} tokens, this surface runs about ${delta}% ${direction} the middle of the pack.`
      ],
      slug,
      "median"
    );
  }

  return [`${scale} ${density}`, comparison];
}

function findingsProse(entry: DirectoryEntry, scanned: ScannedResult): string[] {
  const { slug, name } = entry.seed;
  const groups = groupFindings(scanned.findings);
  if (groups.length === 0) return [];

  const intro = pick(
    [
      `The findings below are grouped by severity, and each links to the rule that produced it.`,
      `Every finding below names the rule behind it and the tool it fired on.`,
      `Findings are listed by severity; the rule pages explain the reasoning in full.`
    ],
    slug,
    "findings-intro"
  );

  const paragraphs = groups.slice(0, 3).map((group, i) => {
    const where =
      group.tools.length === 0
        ? "It applies to the surface as a whole rather than to one tool."
        : group.tools.length === 1
          ? `On this surface it fires on \`${group.tools[0]}\`.`
          : `On this surface it fires on ${list(group.tools.slice(0, 3).map((t) => `\`${t}\``))}${group.tools.length > 3 ? `, among ${n(group.tools.length - 3)} others` : ""}.`;

    const tally = group.count === 1 ? "one finding" : `${n(group.count)} findings`;
    // "The largest group" only reads as true when groups actually differ in size.
    const ranked = i === 0 && groups[0]!.count > (groups[1]?.count ?? 0);
    const lead = pick(
      [
        `${group.count === 1 ? "One finding comes" : `${n(group.count)} findings come`} from \`${group.ruleId}\`.`,
        `\`${group.ruleId}\` accounts for ${tally}.`,
        ranked
          ? `The largest group is \`${group.ruleId}\`, with ${tally}.`
          : `\`${group.ruleId}\` contributes ${tally}.`
      ],
      slug,
      `finding-${group.ruleId}`
    );

    return `${lead} ${group.rationale} ${where}`;
  });

  const remainder = groups.length - paragraphs.length;
  const tail =
    remainder > 0
      ? [
          `${name}'s surface raises ${remainder === 1 ? "one further rule" : `${n(remainder)} further rules`} — ${list(groups.slice(3).map((g) => `\`${g.ruleId}\``))} — listed in full below.`
        ]
      : [];

  return [intro, ...paragraphs, ...tail];
}

function strengthsProse(entry: DirectoryEntry, scanned: ScannedResult): string[] {
  const { slug, name } = entry.seed;
  const clean = Scorer.categories.filter((c) => (scanned.score.categories[c] ?? 100) === 100);
  const counted = scanned.findings.filter((f) => f.severity !== "info");

  if (counted.length === 0) {
    return [
      pick(
        [
          `Nothing in the catalogue fires on this surface. ${name} passes all 19 rules: ${list(Scorer.categories.map((c) => RULE_CATEGORY_FRAGMENTS[c]))}.`,
          `${name} clears every rule in the catalogue. That means ${list(Scorer.categories.map((c) => RULE_CATEGORY_FRAGMENTS[c]))}.`
        ],
        slug,
        "clean"
      ),
      `A clean result is not a claim that the server is well designed for your particular workflow — only that its published tool surface holds up against every static check we run.`
    ];
  }

  if (clean.length === 0) {
    return [
      `Every rule category found something to flag on this surface, so there is no clean category to highlight. The findings above are ordered by severity, which is the order worth working through them in.`
    ];
  }

  const fragments = clean.map((c) => RULE_CATEGORY_FRAGMENTS[c]);
  return [
    pick(
      [
        `${clean.length === 1 ? "One category comes through clean" : `${n(clean.length)} of the six categories come through clean`}: ${list(clean.map((c) => String(c)))}. In practice that means ${list(fragments)}.`,
        `${name} scores a full 100 in ${list(clean.map((c) => String(c)))}, which is to say ${list(fragments)}.`
      ],
      slug,
      "strengths"
    )
  ];
}

function inventoryProse(entry: DirectoryEntry, scanned: ScannedResult): string[] {
  const { slug, name } = entry.seed;
  const tools = scanned.tools;
  if (tools.length === 0) return [];

  const byCost = [...tools].sort((a, b) => b.tokens - a.tokens);
  const heaviest = byCost[0]!;
  const lightest = byCost.at(-1)!;
  const total = tools.reduce((sum, t) => sum + t.tokens, 0) || 1;
  const heaviestShare = pct(heaviest.tokens, total);

  const cost =
    tools.length === 1
      ? `The surface is a single tool, \`${heaviest.name}\`, at ${n(heaviest.tokens)} tokens.`
      : pick(
          [
            `\`${heaviest.name}\` is the most expensive definition at ${n(heaviest.tokens)} tokens — about ${heaviestShare}% of the whole surface — against ${n(lightest.tokens)} for \`${lightest.name}\`.`,
            `The heaviest definition is \`${heaviest.name}\` at ${n(heaviest.tokens)} tokens, roughly ${heaviestShare}% of the total; the lightest, \`${lightest.name}\`, costs ${n(lightest.tokens)}.`,
            `Cost is concentrated in \`${heaviest.name}\`: ${n(heaviest.tokens)} tokens, some ${heaviestShare}% of everything ${name} ships, while \`${lightest.name}\` costs ${n(lightest.tokens)}.`
          ],
          slug,
          "heaviest"
        );

  const described = tools.filter((t) => t.description_length > 0);
  const shortest = Math.min(...described.map((t) => t.description_length));
  const longest = Math.max(...described.map((t) => t.description_length));
  const descriptions =
    described.length === 0
      ? `No tool on this surface carries a description at all, which leaves the model choosing on names alone.`
      : described.length < tools.length
        ? `${n(tools.length - described.length)} of ${n(tools.length)} tools ship without a description; the ones that have them run from ${n(shortest)} to ${n(longest)} characters.`
        : `Every tool carries a description, ranging from ${n(shortest)} to ${n(longest)} characters.`;

  const annotated = tools.filter((t) => t.has_annotations).length;
  const annotations =
    annotated === tools.length
      ? `All ${n(tools.length)} declare annotations, so a client can tell a read from a write before running one.`
      : annotated === 0
        ? `None declare annotations, so a client cannot tell a read from a write without reading the prose.`
        : `${n(annotated)} of ${n(tools.length)} declare annotations, leaving the rest opaque to a client deciding whether to prompt before running them.`;

  const maxDepth = Math.max(...tools.map((t) => t.max_depth));
  const avgProps = Math.round(
    tools.reduce((sum, t) => sum + t.property_count, 0) / Math.max(tools.length, 1)
  );
  const noInput = tools.filter((t) => t.property_count === 0).length;
  const schemas = pick(
    [
      `Input schemas average ${n(avgProps)} top-level parameters and nest ${maxDepth} level${maxDepth === 1 ? "" : "s"} deep at their worst${noInput > 0 ? `, with ${n(noInput)} tool${noInput === 1 ? "" : "s"} taking no input at all` : ""}.`,
      `Across the surface, schemas carry ${n(avgProps)} top-level parameters on average and reach a maximum depth of ${maxDepth}${noInput > 0 ? `; ${n(noInput)} tool${noInput === 1 ? " takes" : "s take"} no input` : ""}.`
    ],
    slug,
    "schemas"
  );

  return [`${cost} ${descriptions}`, `${annotations} ${schemas}`];
}

function comparisonProse(
  entry: DirectoryEntry,
  scanned: ScannedResult,
  catalog: Catalog
): string[] {
  const { slug, name, category } = entry.seed;
  const stats = catalog.stats.get(category);
  const rank = rankInCategory(catalog, entry);
  const related = relatedServers(catalog, entry);

  const parts: string[] = [];

  if (rank !== undefined && stats?.medianScore !== undefined) {
    const scannedCount = catalog.byCategory.get(category)?.filter((e) => e.scanned).length ?? 0;
    const delta = scanned.score.composite - stats.medianScore;
    const standing =
      delta === 0
        ? `exactly on the category median of ${stats.medianScore}`
        : `${n(Math.abs(delta))} point${Math.abs(delta) === 1 ? "" : "s"} ${delta > 0 ? "above" : "below"} the category median of ${stats.medianScore}`;
    parts.push(
      pick(
        [
          `${name} ranks ${rank} of ${n(scannedCount)} scanned ${CATEGORY_LABELS[category]} servers, ${standing}.`,
          `Within ${CATEGORY_LABELS[category]} this is rank ${rank} of ${n(scannedCount)} scanned servers — ${standing}.`
        ],
        slug,
        "rank"
      )
    );
  }

  if (related.length > 0) {
    parts.push(
      `The closest comparisons in this directory are ${list(related.map((r) => r.seed.name))}, which sit nearest on score and face the same kind of surface-design pressure.`
    );
  }

  return parts;
}

/**
 * The page's generated prose. Everything here is a pure function of the scan
 * result and the catalogue — no LLM at build time, so a rebuild of unchanged
 * data produces byte-identical output and the `lastmod` in the sitemap stays
 * honest.
 */
export function buildProse(entry: DirectoryEntry, catalog: Catalog): ServerProse {
  const scanned = entry.scanned;
  if (!scanned) {
    return {
      summary: [],
      footprint: [],
      findings: [],
      strengths: [],
      inventory: [],
      comparison: [],
      wordCount: 0
    };
  }

  const summary = summaryProse(entry, scanned);
  const footprint = footprintProse(entry, scanned, catalog);
  const findings = findingsProse(entry, scanned);
  const strengths = strengthsProse(entry, scanned);
  const inventory = inventoryProse(entry, scanned);
  const comparison = comparisonProse(entry, scanned, catalog);

  const wordCount = [
    ...summary,
    ...footprint,
    ...findings,
    ...strengths,
    ...inventory,
    ...comparison
  ].reduce((sum, paragraph) => sum + countWords(paragraph), 0);

  return { summary, footprint, findings, strengths, inventory, comparison, wordCount };
}
