import { browser } from 'wxt/browser';
import { resolveLimits } from '../core/limits';
import type { Limits } from '../core/limits';
import { BRIDGE_STORAGE_KEYS } from '../core/bridgeProtocol';

/** How long a read of `bf:settings` is reused. Appending a log line must not cost a storage read every time. */
const CACHE_MS = 2000;
let cached: { at: number; limits: Limits } | undefined;

/** The limits from Settings → Limits (defaults when unset). A change applies within about two seconds. */
export async function getLimits(now: number = Date.now()): Promise<Limits> {
  if (cached && now - cached.at < CACHE_MS) return cached.limits;
  let limits: Limits;
  try {
    const stored = await browser.storage.local.get(BRIDGE_STORAGE_KEYS.settings);
    limits = resolveLimits(stored[BRIDGE_STORAGE_KEYS.settings] as Record<string, unknown> | undefined);
  } catch {
    limits = resolveLimits();
  }
  cached = { at: now, limits };
  return limits;
}

/** Forget the cached limits (the background calls it when `bf:settings` changes; tests call it between cases). */
export function resetLimitsCache(): void {
  cached = undefined;
}
