import type { Category } from "mcp-surface-lint";

/**
 * One line per rule category, written to be readable on its own. Shared by the
 * rule catalogue, the per-rule pages, and the generated directory prose so a
 * category never gets two different explanations.
 */
export const RULE_CATEGORY_BLURBS: Record<Category, string> = {
  surface: "How much of the context window the tool surface consumes before anyone says anything.",
  naming: "Whether tool names are internally consistent enough for a model to generalise from.",
  descriptions: "Whether each tool explains itself well enough to be chosen correctly.",
  schemas: "Whether the input schemas are tight enough to constrain what the model sends.",
  annotations: "Whether clients can tell a read from a write before they run it.",
  design:
    "The interesting half. Whether the surface is shaped around your users' intents or around your REST endpoints."
};

/** Sentence fragment used inside generated prose, e.g. "…because {fragment}". */
export const RULE_CATEGORY_FRAGMENTS: Record<Category, string> = {
  surface: "the surface stays inside a sensible tool and token budget",
  naming: "the tool names follow one convention end to end",
  descriptions: "every tool carries a description long enough to disambiguate it",
  schemas: "the input schemas are typed tightly enough to constrain what a model sends",
  annotations: "read and write operations are machine-distinguishable before a client runs them",
  design: "the surface is shaped around user intents rather than mirrored REST endpoints"
};
