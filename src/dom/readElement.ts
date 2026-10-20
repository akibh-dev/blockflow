/**
 * Runs INSIDE the watched page (injected with scripting.executeScript).
 *
 * It is serialised and sent to the page, so it must be fully self-contained: no imports,
 * no references to anything outside this function.
 */
export function readSelectorInPage(selector: string): { found: boolean; text: string; error?: string } {
  try {
    const element = document.querySelector(selector);
    if (!element) return { found: false, text: '' };
    return { found: true, text: element.textContent ?? '' };
  } catch {
    return { found: false, text: '', error: `Invalid selector: ${selector}` };
  }
}
