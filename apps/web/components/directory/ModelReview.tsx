import Link from "next/link";
import { Docs } from "mcp-surface-lint";
import { MODEL_LABELS, isModelId } from "@/lib/llm/config";
import type { DirectoryEntry } from "@/lib/directory/catalog";
import type { Review } from "@/lib/llm/results";

const KIND_LABELS: Record<Review["findings"][number]["kind"], string> = {
  "overlapping-tools": "Overlapping tools",
  "vague-description": "Vague description",
  "undocumented-parameter": "Undocumented parameter",
  "name-description-mismatch": "Name contradicts description"
};

function label(model: string): string {
  return isModelId(model) ? MODEL_LABELS[model] : model;
}

/**
 * What a model noticed reading the definitions. Kept apart from the rule
 * findings above it: these are a model's reading, worded by the model, and
 * they never touch the score.
 */
export function ModelReview({ entry }: { entry: DirectoryEntry }) {
  const review = entry.review;
  if (!review) return null;

  return (
    <section aria-labelledby="model-review">
      <h2 id="model-review">What Claude noticed in the definitions</h2>
      <p>
        {label(review.model)} read this surface&apos;s tool definitions the way a model choosing
        between them would, and reported only problems it could pin to specific tools: overlaps,
        vague descriptions, undocumented parameters and names that contradict their descriptions.
        {review.sampled
          ? ` The surface is oversized, so it read a fixed sample of ${review.sampled.tools} of its ${review.sampled.of} tools.`
          : ""}{" "}
        These are a model&apos;s observations, not rule findings, and they do not affect the score.
      </p>
      {review.findings.length === 0 ? (
        <p>It found nothing to report.</p>
      ) : (
        review.findings.map((finding, i) => (
          <article className="finding info" key={`${finding.kind}-${i}`}>
            <div className="meta">
              {finding.rule_id ? (
                <Link className="rule-id" href={`/rules/${Docs.slug(finding.rule_id)}`}>
                  {KIND_LABELS[finding.kind]}
                </Link>
              ) : (
                <span className="rule-id">{KIND_LABELS[finding.kind]}</span>
              )}
              {finding.tools.map((tool) => (
                <span className="tool-name" key={tool}>
                  {tool}
                </span>
              ))}
              {finding.parameter ? <span className="tool-name">{finding.parameter}</span> : null}
            </div>
            <div className="msg">{finding.explanation}</div>
          </article>
        ))
      )}
      <p className="hint">
        Reviewed on {review.reviewed_at.slice(0, 10)} with review prompt v{review.prompt_version}.
      </p>
    </section>
  );
}
