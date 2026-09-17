import type { ScanTool } from "@/lib/directory/types";

/**
 * The raw surface, sorted by what it costs. Complete in HTML with no client
 * JavaScript; the wrapper scrolls rather than letting the page scroll sideways.
 */
export function ToolInventory({ tools }: { tools: ScanTool[] }) {
  const sorted = [...tools].sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));

  return (
    <div className="table-scroll">
      <table className="tool-table">
        <caption className="visually-hidden">
          Every tool on this surface with its token cost and schema shape.
        </caption>
        <thead>
          <tr>
            <th scope="col">Tool</th>
            <th scope="col">Tokens</th>
            <th scope="col">Description</th>
            <th scope="col">Params</th>
            <th scope="col">Required</th>
            <th scope="col">Depth</th>
            <th scope="col">Annotations</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((tool) => (
            <tr key={tool.name}>
              <th scope="row">
                <code>{tool.name}</code>
              </th>
              <td>{tool.tokens.toLocaleString("en-US")}</td>
              <td>{tool.description_length === 0 ? "—" : `${tool.description_length} chars`}</td>
              <td>{tool.property_count}</td>
              <td>{tool.required_count}</td>
              <td>{tool.max_depth}</td>
              <td>{tool.has_annotations ? "yes" : "no"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
