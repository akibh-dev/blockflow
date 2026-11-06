import { browser } from 'wxt/browser';
import { CodedError } from '../core/errors';
import { urlMatches } from '../core/urlPattern';
import { sleep } from './tabs';
import type { DownloadInfo } from '../core/types';

/**
 * Wait for Download. The browser keeps its own list of downloads with their start times, so the
 * look-back ("a download that started during the Click before this block") is a `downloads.search`
 * with `startedAfter`: nothing has to be recorded while the worker sleeps. Downloads already handed to
 * a Wait for Download are remembered in storage.session under `bf:downloads-claimed`, so each one is
 * returned once.
 */
const CLAIMED_KEY = 'bf:downloads-claimed';

/** A download item, with the fields both Chrome and Firefox report. */
type Item = {
  id: number;
  url: string;
  finalUrl?: string;
  filename: string;
  mime?: string;
  fileSize?: number;
  totalBytes?: number;
  state?: string;
  error?: string;
  byExtensionId?: string;
};

/** The content of a download is read up to this many characters. */
const MAX_TEXT_CHARS = 2_000_000;

async function claimed(): Promise<number[]> {
  return ((await browser.storage.session.get(CLAIMED_KEY))[CLAIMED_KEY] as number[] | undefined) ?? [];
}

/** The file name without folders (Chrome and Firefox report the full path). */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Downloads BlockFlow's own Download block made (Chrome: `byExtensionId`; Firefox: our blob: URLs). */
function isOwn(item: Item): boolean {
  if (item.byExtensionId && item.byExtensionId === browser.runtime.id) return true;
  const origin = browser.runtime.getURL('/').replace(/\/$/, '');
  return item.url.startsWith(`blob:${origin}`);
}

function info(item: Item): DownloadInfo {
  const size = item.fileSize !== undefined && item.fileSize >= 0 ? item.fileSize : (item.totalBytes ?? -1);
  return { downloadId: item.id, url: item.finalUrl || item.url, filename: baseName(item.filename), path: item.filename, size, mime: item.mime ?? '' };
}

/** `pattern` against the URL (before and after redirects) or the file name; '' matches everything. */
function matches(item: Item, pattern: string): boolean {
  if (!pattern.trim()) return true;
  const name = baseName(item.filename);
  return urlMatches(item.url, pattern) || Boolean(item.finalUrl && urlMatches(item.finalUrl, pattern)) || Boolean(name && urlMatches(name, pattern));
}

async function search(query: Record<string, unknown>): Promise<Item[]> {
  return (await browser.downloads.search(query as never)) as unknown as Item[];
}

/**
 * `Host.downloads.waitFor`: the first unclaimed download (not BlockFlow's own) started since `lookBackMs`
 * ago whose URL or name matches `pattern`, polled every 250 ms; then waits for it to complete. Throws
 * `download.failed` when the browser interrupts it, `timeout` when none comes or it does not finish.
 */
export async function waitForDownload(pattern: string, lookBackMs: number, timeoutMs: number): Promise<DownloadInfo> {
  const since = new Date(Date.now() - lookBackMs).toISOString();
  const deadline = Date.now() + timeoutMs;
  const seconds = Math.round(timeoutMs / 1000);
  let found: Item | undefined;
  while (!found) {
    const taken = new Set(await claimed());
    const items = await search({ startedAfter: since, orderBy: ['startTime'] });
    found = items.find((item) => !taken.has(item.id) && !isOwn(item) && matches(item, pattern));
    if (found) {
      await browser.storage.session.set({ [CLAIMED_KEY]: [...taken, found.id].slice(-200) });
      break;
    }
    if (Date.now() >= deadline) {
      const seen = items.filter((item) => !isOwn(item)).map((item) => baseName(item.filename) || item.url);
      throw new CodedError('timeout', `Timed out after ${seconds}s: no download${pattern.trim() ? ` matching ${pattern}` : ''} started${seen.length ? ` (saw ${seen.slice(0, 5).join(', ')})` : ''}`);
    }
    await sleep(250);
  }
  // Then until it has finished: the file name and size are only final then.
  for (;;) {
    const [item] = await search({ id: found.id });
    if (!item) throw new CodedError('download.failed', 'The download was removed from the browser before it finished');
    if (item.state === 'complete') return info(item);
    if (item.state === 'interrupted') throw new CodedError('download.failed', `The download of ${item.finalUrl || item.url} failed: ${item.error ?? 'interrupted'}`, { url: item.url });
    if (Date.now() >= deadline) throw new CodedError('timeout', `Timed out after ${seconds}s waiting for ${baseName(item.filename) || item.url} to finish downloading`);
    await sleep(250);
  }
}

/** A data: URL's content as text. */
function decodeDataUrl(url: string): string {
  const comma = url.indexOf(',');
  const meta = url.slice(5, comma);
  const data = url.slice(comma + 1);
  if (!/;base64$/i.test(meta)) return decodeURIComponent(data);
  const binary = atob(data);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * `Host.downloads.readText`. Extensions cannot open files on disk, so the content is fetched again:
 * data: URLs are decoded, http(s) URLs fetched from the background (with the site's cookies; a URL that
 * makes a new file every time gives that new file), blob: URLs fetched inside the tab that made them
 * (only while the page has not released them).
 */
export async function readDownloadText(download: DownloadInfo, tabId?: number): Promise<string> {
  const { url } = download;
  let text: string;
  if (url.startsWith('data:')) text = decodeDataUrl(url);
  else if (url.startsWith('blob:')) {
    if (tabId === undefined) throw new CodedError('download.failed', 'The download was made by the page (a blob: URL): reading it needs the tab that made it');
    const [injection] = await browser.scripting.executeScript({
      target: { tabId },
      func: async (blobUrl: string) => {
        try {
          const response = await fetch(blobUrl);
          return { ok: true, text: await response.text() };
        } catch (error) {
          return { ok: false, text: String(error) };
        }
      },
      args: [url],
    });
    const result = injection?.result as { ok: boolean; text: string } | undefined;
    if (!result?.ok) throw new CodedError('download.failed', `The page has already released the file it downloaded (${url}), so its content cannot be read: ${result?.text ?? 'no answer'}`);
    text = result.text;
  } else if (/^https?:/i.test(url)) {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new CodedError('download.failed', `Reading the download again from ${url} failed: HTTP ${response.status}`, { url });
    text = await response.text();
  } else {
    throw new CodedError('download.failed', `The content of a download from ${url.slice(0, 60)} cannot be read`);
  }
  return text.slice(0, MAX_TEXT_CHARS);
}
