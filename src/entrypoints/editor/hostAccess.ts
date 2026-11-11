import { browser } from 'wxt/browser';
import { workflowOrigins } from '../../core/origins';
import type { Workflow } from '../../core/types';
import { registry } from './registry';

/** What a workflow needs that the browser has not granted yet. */
export interface HostNeed {
  /** Match patterns like "https://shop.example.com/*". */
  origins: string[];
  /** The workflow can reach any site (templated URL, wildcard trigger, tab it did not open). */
  anySite: boolean;
}

export const NO_NEED: HostNeed = { origins: [], anySite: false };

/** Origins this workflow needs and the browser has not granted (asks `permissions.contains`). */
export async function missingAccess(workflow: Workflow): Promise<HostNeed> {
  const { origins, anySite } = workflowOrigins(workflow, registry);
  if (anySite) {
    const granted = await browser.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
    return granted ? NO_NEED : { origins: [], anySite: true };
  }
  const missing: string[] = [];
  for (const origin of origins) {
    if (!(await browser.permissions.contains({ origins: [origin] }).catch(() => false))) missing.push(origin);
  }
  return { origins: missing, anySite: false };
}

export function needsAccess(need: HostNeed): boolean {
  return need.anySite || need.origins.length > 0;
}

/**
 * Asks the browser for the access. Must be called directly inside a click handler (no awaiting before it):
 * browsers only show the prompt for a user gesture.
 */
export function requestAccess(need: HostNeed): Promise<boolean> {
  if (!needsAccess(need)) return Promise.resolve(true);
  return browser.permissions.request({ origins: need.anySite ? ['<all_urls>'] : need.origins }).catch(() => false);
}

/** "shop.example.com, api.example.com" or "all sites", for messages. */
export function describeNeed(need: HostNeed): string {
  if (need.anySite) return 'all sites';
  return need.origins.map((origin) => origin.replace(/^https?:\/\//, '').replace(/\/\*$/, '')).join(', ');
}
