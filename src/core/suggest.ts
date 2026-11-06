/**
 * "Did you mean …?" for names someone (or an LLM) typed: block types, config keys, step keys,
 * output ports, node ids. Pure, no browser APIs.
 */

/**
 * Edit distance where swapping two neighbouring letters counts as one edit (optimal string
 * alignment, the usual "Damerau-Levenshtein"). Case-sensitive; callers lowercase when they want.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const cols = b.length + 1;
  // One flat table: d[i * cols + j] = distance between a[0..i) and b[0..j).
  const d = new Array<number>((a.length + 1) * cols).fill(0);
  const at = (i: number, j: number): number => d[i * cols + j] ?? 0;
  for (let i = 0; i <= a.length; i += 1) d[i * cols] = i;
  for (let j = 0; j <= b.length; j += 1) d[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, at(i - 2, j - 2) + 1);
      d[i * cols + j] = best;
    }
  }
  return at(a.length, b.length);
}

/**
 * The closest candidate within `maxDistance` edits (case-insensitive), or undefined. Very short
 * names only get one edit, so "id" does not suggest "to". Ties go to the earlier candidate.
 */
export function closest(word: string, candidates: Iterable<string>, maxDistance = 2): string | undefined {
  const lower = word.toLowerCase();
  const limit = word.length <= 3 ? Math.min(1, maxDistance) : maxDistance;
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(lower, candidate.toLowerCase());
    if (distance <= limit && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** `Did you mean "x"?` for the closest candidate, or undefined. */
export function didYouMean(word: string, candidates: Iterable<string>): string | undefined {
  const match = closest(word, candidates);
  return match === undefined ? undefined : `Did you mean "${match}"?`;
}
