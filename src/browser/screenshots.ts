import { browser } from 'wxt/browser';
import { uid } from '../core/id';
import { CodedError } from '../core/errors';
import { saveScreenshot } from './blobStore';
import { captureWithDebugger, hasDebugger, withDebugger } from './cdp';
import { act } from './pageDriver';
import { sleep } from './tabs';
import type { ScreenshotOptions, ScreenshotResult } from '../core/types';

/**
 * Screenshots: the step setting (`capture`, after a step) and the Screenshot block (`take`).
 *
 * - Chromium: `tabs.captureVisibleTab` sees only the tab showing in its window. Background tabs, the
 *   full page and elements go through the debugger (`Page.captureScreenshot` with
 *   `captureBeyondViewport` and a `clip`), optional permission. Without it an element of the showing
 *   tab is cut out of a visible-area capture.
 * - Firefox: `tabs.captureTab(tabId, { rect })` captures any tab and any part of the page (rect in CSS
 *   pixels of the document), so all three areas work there without extra permissions.
 */

type Rect = { x: number; y: number; width: number; height: number };
type CaptureTab = (tabId: number, options: { format?: string; quality?: number; rect?: Rect; scale?: number }) => Promise<string>;

/** Firefox's `tabs.captureTab`, or undefined in Chromium. */
function captureTabApi(): CaptureTab | undefined {
  const fn = (browser.tabs as unknown as { captureTab?: CaptureTab }).captureTab;
  return typeof fn === 'function' ? fn.bind(browser.tabs) : undefined;
}

/** Firefox's limit for one drawSnapshot side, and a sane cap for Chromium's full page. */
const MAX_SIDE = 16_000;
/** How long a debugger capture may take. */
const CDP_CAPTURE_MS = 15_000;

/** `Host.screenshots.capture`: JPEG of the tab saved in IndexedDB; returns its id, or null when it cannot be taken. */
export async function capture(tabId: number, runId: string): Promise<string | null> {
  const tab = await browser.tabs.get(tabId);
  const captureTab = captureTabApi();
  // captureVisibleTab only sees the tab that is showing in its window. A background tab needs the
  // debugger permission (granted for real input) in Chromium, or Firefox's captureTab.
  const dataUrl = captureTab
    ? await captureTab(tabId, { format: 'jpeg', quality: 60 })
    : tab.active && tab.windowId !== undefined
      ? await browser.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 })
      : await captureWithDebugger(tabId, runId).catch(() => null);
  if (!dataUrl) return null;
  const id = uid();
  await saveScreenshot({ id, runId, ts: Date.now(), dataUrl });
  return id;
}

/** The decoded image of a data: URL. */
async function bitmapOf(dataUrl: string): Promise<ImageBitmap> {
  return createImageBitmap(await (await fetch(dataUrl)).blob());
}

/** A blob as a data: URL (no FileReader in a service worker). */
async function dataUrlOf(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type};base64,${btoa(binary)}`;
}

/** Cuts `rect` (CSS pixels of the viewport) out of a visible-area capture taken at `scale` image pixels per CSS pixel. */
async function crop(dataUrl: string, rect: Rect, scale: number, mime: string, quality: number): Promise<string> {
  const bitmap = await bitmapOf(dataUrl);
  const sx = Math.max(0, Math.round(rect.x * scale));
  const sy = Math.max(0, Math.round(rect.y * scale));
  const width = Math.max(1, Math.min(bitmap.width - sx, Math.round(rect.width * scale)));
  const height = Math.max(1, Math.min(bitmap.height - sy, Math.round(rect.height * scale)));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No 2D canvas to crop the screenshot');
  context.drawImage(bitmap, sx, sy, width, height, 0, 0, width, height);
  bitmap.close();
  return dataUrlOf(await canvas.convertToBlob({ type: mime, quality: quality / 100 }));
}

/** The page's scroll position, size and pixel ratio (page agent `measure`). */
async function pageMetrics(tabId: number, timeoutMs: number) {
  const page = await act(tabId, { op: 'measure' }, timeoutMs);
  return {
    scrollX: Number(page.scrollX) || 0,
    scrollY: Number(page.scrollY) || 0,
    viewportWidth: Number(page.viewportWidth) || 0,
    viewportHeight: Number(page.viewportHeight) || 0,
    pageWidth: Number(page.pageWidth) || 0,
    pageHeight: Number(page.pageHeight) || 0,
    devicePixelRatio: Number(page.devicePixelRatio) || 1,
  };
}

/** The element's box in the viewport, after the agent waited for it and scrolled it into view. */
async function elementBox(tabId: number, locator: string, timeoutMs: number): Promise<Rect> {
  const box = await act(tabId, { op: 'measure', locator }, timeoutMs);
  const rect = { x: Number(box.x), y: Number(box.y), width: Number(box.width), height: Number(box.height) };
  if (!(rect.width > 0 && rect.height > 0)) throw new CodedError('element.not-visible', `${locator} has no size to take a picture of`, { locator });
  return rect;
}

const needsDebugger = (what: string) =>
  new CodedError(
    'permission.missing',
    `${what} needs the "debugger" permission in Chrome, Edge and Brave (press Grant on the Screenshot block). Without it, use "visible area" on a tab that is showing (Open Tab with "bring to front").`,
  );

/** Chromium, with the debugger: `Page.captureScreenshot`, optionally beyond the viewport. */
async function viaDebugger(tabId: number, format: 'png' | 'jpeg', quality: number, clip?: Rect, runId?: string): Promise<string> {
  return withDebugger(tabId, async (send) => {
    // A tab that does not paint can leave the call hanging: give up after a while (and detach).
    const shot = (await Promise.race([
      send('Page.captureScreenshot', {
        format,
        ...(format === 'jpeg' ? { quality } : {}),
        ...(clip ? { clip: { ...clip, scale: 1 }, captureBeyondViewport: true } : {}),
        fromSurface: true,
      }),
      sleep(CDP_CAPTURE_MS).then(() => ({})),
    ])) as { data?: string };
    if (!shot.data) throw new CodedError('timeout', 'The browser returned no image (the tab may not be painting)');
    return `data:image/${format};base64,${shot.data}`;
  }, runId);
}

/** Chromium: the whole page through `Page.getLayoutMetrics` + a clip of the content size. */
async function fullPageViaDebugger(tabId: number, format: 'png' | 'jpeg', quality: number, runId?: string): Promise<string> {
  const metrics = await withDebugger(tabId, (send) => send('Page.getLayoutMetrics') as Promise<{ cssContentSize?: { width: number; height: number }; contentSize?: { width: number; height: number } }>, runId);
  const size = metrics.cssContentSize ?? metrics.contentSize ?? { width: 0, height: 0 };
  return viaDebugger(tabId, format, quality, { x: 0, y: 0, width: Math.min(MAX_SIDE, Math.ceil(size.width)), height: Math.min(MAX_SIDE, Math.ceil(size.height)) }, runId);
}

/**
 * `Host.screenshots.take` (Screenshot block): captures, stores in IndexedDB like step screenshots, and
 * answers the id and the image size. Throws (coded) when this browser or tab cannot do it.
 */
export async function take(tabId: number, options: ScreenshotOptions): Promise<ScreenshotResult> {
  const { area, format } = options;
  const quality = Math.min(100, Math.max(0, Math.round(options.quality ?? 80)));
  const mime = `image/${format}`;
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab) throw new CodedError('tab.closed', 'The tab was closed');
  const captureTab = captureTabApi();
  const showing = tab.active === true && tab.windowId !== undefined;
  const imageOptions = { format, ...(format === 'jpeg' ? { quality } : {}) };
  let dataUrl: string;

  if (area === 'element') {
    const locator = String(options.locator ?? '').trim();
    if (!locator) throw new CodedError('config.invalid', 'Element is required for an element screenshot');
    const box = await elementBox(tabId, locator, options.timeoutMs);
    if (captureTab) {
      const page = await pageMetrics(tabId, options.timeoutMs);
      dataUrl = await captureTab(tabId, { ...imageOptions, rect: { x: box.x + page.scrollX, y: box.y + page.scrollY, width: box.width, height: box.height } });
    } else if (await hasDebugger()) {
      const page = await pageMetrics(tabId, options.timeoutMs);
      dataUrl = await viaDebugger(tabId, format, quality, { x: box.x + page.scrollX, y: box.y + page.scrollY, width: box.width, height: box.height }, options.runId);
    } else if (showing) {
      // Cut the element out of what the tab shows (it was scrolled into view).
      const page = await pageMetrics(tabId, options.timeoutMs);
      const visible = await browser.tabs.captureVisibleTab(tab.windowId as number, { format: 'png' });
      const scale = (await bitmapOf(visible)).width / Math.max(1, page.viewportWidth);
      dataUrl = await crop(visible, box, scale, mime, quality);
    } else throw needsDebugger('A screenshot of an element in a tab that is not showing');
  } else if (area === 'full') {
    if (captureTab) {
      const page = await pageMetrics(tabId, options.timeoutMs);
      dataUrl = await captureTab(tabId, { ...imageOptions, rect: { x: 0, y: 0, width: Math.min(MAX_SIDE, page.pageWidth), height: Math.min(MAX_SIDE, page.pageHeight) } });
    } else if (await hasDebugger()) dataUrl = await fullPageViaDebugger(tabId, format, quality, options.runId);
    else throw needsDebugger('A full-page screenshot');
  } else if (captureTab) dataUrl = await captureTab(tabId, imageOptions);
  else if (showing) dataUrl = await browser.tabs.captureVisibleTab(tab.windowId as number, imageOptions);
  else if (await hasDebugger()) dataUrl = await viaDebugger(tabId, format, quality, undefined, options.runId);
  else throw needsDebugger('A screenshot of a tab that is not showing');

  const bitmap = await bitmapOf(dataUrl);
  const result = { id: uid(), width: bitmap.width, height: bitmap.height };
  bitmap.close();
  await saveScreenshot({ id: result.id, runId: options.runId, ts: Date.now(), dataUrl });
  return result;
}
