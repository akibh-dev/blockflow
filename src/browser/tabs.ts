import { browser } from 'wxt/browser';

const LOAD_TIMEOUT_MS = 30_000;

export function requireTabId(tab: { id?: number }): number {
  if (tab.id === undefined) throw new Error('The browser did not return a tab id');
  return tab.id;
}

/** Starts listening for the next "page finished loading" event of a tab. Call BEFORE triggering the load. */
function nextLoadComplete(tabId: number, timeoutMs = LOAD_TIMEOUT_MS) {
  let cleanup = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for the page to load'));
    }, timeoutMs);
    const listener = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === 'complete') {
        cleanup();
        resolve();
      }
    };
    cleanup = () => {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(listener);
    };
    browser.tabs.onUpdated.addListener(listener);
  });
  // The caller decides whether to await it; avoid an unhandled rejection if it never does.
  promise.catch(() => {});
  return { promise, cancel: () => cleanup() };
}

/** Resolves when the tab has finished loading (immediately if it already has). */
export async function waitForTabComplete(tabId: number, timeoutMs = LOAD_TIMEOUT_MS): Promise<void> {
  const waiter = nextLoadComplete(tabId, timeoutMs);
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.status === 'complete') {
      waiter.cancel();
      return;
    }
  } catch (error) {
    waiter.cancel();
    throw error;
  }
  await waiter.promise;
}

export async function reloadAndWait(tabId: number, timeoutMs = LOAD_TIMEOUT_MS): Promise<void> {
  const waiter = nextLoadComplete(tabId, timeoutMs);
  try {
    await browser.tabs.reload(tabId);
  } catch (error) {
    waiter.cancel();
    throw error;
  }
  await waiter.promise;
}

export async function tabExists(tabId: number): Promise<boolean> {
  try {
    await browser.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
