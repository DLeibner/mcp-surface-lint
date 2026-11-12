import { MODEL_LABELS, isModelId } from "@/lib/llm/config";
import type { Summary } from "@/lib/llm/results";

/** The audit in a few sentences, written by a model from the facts on this page and labelled as such. */
export function ScorecardSummary({ summary }: { summary: Summary }) {
  const model = isModelId(summary.model) ? MODEL_LABELS[summary.model] : summary.model;
  return (
    <section className="panel scorecard-summary" aria-label="Summary">
      <p>{summary.text}</p>
      <p className="hint">
        Written by {model} from this page&apos;s audit data, not from the server&apos;s own text.
      </p>
    </section>
  );
}
