/** Collapses runs of whitespace so layout-only changes do not count as changes. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function truncate(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
