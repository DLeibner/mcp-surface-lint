/**
 * Model-written text that reaches a public page has read untrusted input on
 * the way: tool descriptions are written by whoever runs the server. React
 * escapes it, so it cannot become markup; this strips what could still be
 * abused in plain text (links) and keeps it to one tidy line.
 */
export function plainText(text: string, max: number): string {
  const cleaned = text
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
  if (cleaned.length <= max) return cleaned;
  const cut = cleaned.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max / 2)).trimEnd()}…`;
}
