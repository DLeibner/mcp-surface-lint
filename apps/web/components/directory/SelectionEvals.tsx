import {
  MODELS,
  MODEL_LABELS,
  PROMPT_VERSIONS,
  SCENARIO_MODEL,
  isModelId,
  type ModelId
} from "@/lib/llm/config";
import type { DirectoryEntry } from "@/lib/directory/catalog";
import type { SelectionRun } from "@/lib/llm/results";

function percent(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

function label(model: string): string {
  return isModelId(model) ? MODEL_LABELS[model] : model;
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The newest run per model on this exact surface and prompt version, in model order. */
function currentRuns(runs: readonly SelectionRun[], toolsHash: string): SelectionRun[] {
  const latest = new Map<ModelId, SelectionRun>();
  for (const run of runs) {
    if (!isModelId(run.model) || run.tools_hash !== toolsHash) continue;
    if (run.prompt_version !== PROMPT_VERSIONS.selection || latest.has(run.model)) continue;
    latest.set(run.model, run);
  }
  return MODELS.flatMap((model) => (latest.has(model) ? [latest.get(model)!] : []));
}

/**
 * What Claude actually does with the surface: for a set of realistic requests,
 * which tool each model reaches for. Measured, never executed — the server is
 * not contacted — and kept apart from the score, which no model touches.
 */
export function SelectionEvals({ entry }: { entry: DirectoryEntry }) {
  const toolsHash = entry.scanned?.snapshot_hash;
  if (!toolsHash || entry.selection.length === 0) return null;

  const current = currentRuns(entry.selection, toolsHash);
  const earlier = entry.selection.filter((run) => !current.includes(run));
  const lead = current[0];
  const pairs = new Map<string, { expected: string; actual: string; models: string[]; count: number }>();
  for (const run of current) {
    for (const pair of run.confused_pairs) {
      const key = `${pair.expected}\u0000${pair.actual}`;
      const merged = pairs.get(key) ?? { expected: pair.expected, actual: pair.actual, models: [], count: 0 };
      merged.models.push(label(run.model));
      merged.count += pair.count;
      pairs.set(key, merged);
    }
  }
  const confused = [...pairs.values()].sort((a, b) => b.count - a.count || a.expected.localeCompare(b.expected));

  return (
    <section aria-labelledby="tool-selection">
      <h2 id="tool-selection">How Claude uses this surface</h2>
      {lead ? (
        <>
          <p>
            We handed {list(current.map((run) => label(run.model)))} this server&apos;s tools exactly
            as an MCP client would, with {lead.metrics.scenarios} realistic requests written for
            this surface — {lead.metrics.distractors} of which no tool here can serve — and recorded
            which tool each model reached for. Nothing was executed: each tool call is graded and
            discarded, so the server itself is never contacted. None of this affects the score.
          </p>
          {lead.sampled ? (
            <p>
              The surface is larger than a model should be handed whole, so the models saw a fixed
              sample of {lead.sampled.tools} of its {lead.sampled.of} tools. An oversized surface is
              a finding in its own right.
            </p>
          ) : null}
          <div className="table-scroll">
            <table className="server-table">
              <caption className="visually-hidden">Tool selection results by Claude model.</caption>
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Right tool</th>
                  <th scope="col">Tool when none fit</th>
                  <th scope="col">No tool when one fit</th>
                  <th scope="col">Valid arguments</th>
                  <th scope="col">Run</th>
                </tr>
              </thead>
              <tbody>
                {current.map((run) => (
                  <tr key={run.key}>
                    <th scope="row">{label(run.model)}</th>
                    <td>{percent(run.metrics.selection_accuracy)}</td>
                    <td>{percent(run.metrics.distractor_false_positive_rate)}</td>
                    <td>{percent(run.metrics.no_call_rate)}</td>
                    <td>{percent(run.metrics.argument_validity)}</td>
                    <td>
                      <time dateTime={run.completed_at.slice(0, 10)}>{run.completed_at.slice(0, 10)}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>Tools the models confused</h3>
          {confused.length === 0 ? (
            <p>No model picked one tool where another was meant.</p>
          ) : (
            <ul className="related">
              {confused.map((pair) => (
                <li key={`${pair.expected}-${pair.actual}`}>
                  Asked for <code>{pair.expected}</code>, called <code>{pair.actual}</code> —{" "}
                  {pair.count === 1 ? "once" : `${pair.count} times`} ({list(pair.models)})
                </li>
              ))}
            </ul>
          )}
          <p className="hint">
            &ldquo;Tool when none fit&rdquo; counts the {lead.metrics.distractors} requests no tool
            serves; &ldquo;valid arguments&rdquo; checks each call against the tool&apos;s own input
            schema. Scenario set v{lead.scenario_set}, written by {MODEL_LABELS[SCENARIO_MODEL]} from
            this surface; selection prompt v{lead.prompt_version}. Percentages exclude requests a
            model could not finish answering.
          </p>
        </>
      ) : (
        <p>
          This surface changed since its last selection run; a fresh one is queued. Earlier results
          are listed below for reference.
        </p>
      )}

      {earlier.length > 0 ? (
        <details>
          <summary>Earlier runs</summary>
          <div className="table-scroll">
            <table className="server-table">
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Model</th>
                  <th scope="col">Right tool</th>
                  <th scope="col">Surface</th>
                  <th scope="col">Versions</th>
                </tr>
              </thead>
              <tbody>
                {earlier.map((run) => (
                  <tr key={run.key}>
                    <th scope="row">{run.completed_at.slice(0, 10)}</th>
                    <td>{label(run.model)}</td>
                    <td>{percent(run.metrics.selection_accuracy)}</td>
                    <td>{run.tools_hash === toolsHash ? "this one" : "an earlier one"}</td>
                    <td>
                      scenarios v{run.scenario_set}, prompt v{run.prompt_version}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </section>
  );
}
