/**
 * URL patterns for Wait For "URL matches":
 *   /order\/\d+/i         regular expression (between slashes)
 *   https://shop.test/*   glob: * = anything except "/", ** = anything
 *   /welcome              anything else: the URL contains this text
 */
export function urlMatches(url: string, pattern: string): boolean {
  const text = pattern.trim();
  if (!text) return false;
  const regex = /^\/(.+)\/([dgimsuyv]*)$/s.exec(text);
  if (regex) {
    try {
      return new RegExp(regex[1] ?? '', regex[2]).test(url);
    } catch {
      throw new Error(`Invalid URL pattern: ${text}`);
    }
  }
  if (text.includes('*')) {
    const source = text
      .split('**')
      .map((part) => part.split('*').map(escapeRegex).join('[^/]*'))
      .join('.*');
    return new RegExp(`^${source}$`).test(url);
  }
  return url.includes(text);
}

function escapeRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
