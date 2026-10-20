const BLOCKED_SCHEMES =
  /^(javascript|data|file|chrome|chrome-extension|moz-extension|about|mailto|blob|view-source):/i;

/**
 * Turns user input into a safe http(s) URL, or returns null.
 * "example.com/a" becomes "https://example.com/a". Anything that is not http or https
 * (javascript:, data:, file:, extension pages...) is rejected.
 */
export function normalizeHttpUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  let candidate: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    candidate = text;
  } else if (BLOCKED_SCHEMES.test(text)) {
    return null;
  } else {
    candidate = `https://${text}`;
  }

  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}
