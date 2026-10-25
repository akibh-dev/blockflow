/**
 * Runs INSIDE the watched page (injected with scripting.executeScript).
 *
 * It is serialised and sent to the page, so it must be fully self-contained: no imports,
 * no references to anything outside this function.
 *
 * `kind`: text (default), attribute, has-class, exists, count.
 * `exists` and `count` are always "found": a missing element is a valid answer (false / 0).
 */
export function readSelectorInPage(
  selector: string,
  kind: 'text' | 'value' | 'attribute' | 'has-class' | 'exists' | 'count' = 'text',
  name = '',
): { found: boolean; text: string; count: number; error?: string } {
  try {
    const all = document.querySelectorAll(selector);
    const element = all[0];
    const count = all.length;
    if (kind === 'count') return { found: true, text: String(count), count };
    if (kind === 'exists') return { found: true, text: String(count > 0), count };
    if (!element) return { found: false, text: '', count };
    if (kind === 'attribute') return { found: true, text: element.getAttribute(name) ?? '', count };
    if (kind === 'value') return { found: true, text: 'value' in element ? String((element as HTMLInputElement).value) : '', count };
    if (kind === 'has-class') return { found: true, text: String(element.classList.contains(name)), count };
    return { found: true, text: element.textContent ?? '', count };
  } catch {
    return { found: false, text: '', count: 0, error: `Invalid selector: ${selector}` };
  }
}
