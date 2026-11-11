/** The origins a workflow needs host access to, so the extension only asks for the sites it uses. */

import type { BlockRegistry } from './registry';
import type { AnyBlockDefinition, Workflow } from './types';

/** Match patterns like "https://shop.example.com/*" (scheme + host, any path). Sorted, unique. */
export interface WorkflowOrigins {
  origins: string[];
  /** True when some URL is templated ("{{…}}") or a block can reach any site: the user must allow all sites. */
  anySite: boolean;
}

/** "https://a.com/x?y" → "https://a.com/*"; non-http(s) → null. */
export function originPattern(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return `${parsed.protocol}//${parsed.host}/*`;
}

const URL_FIELD_KEYS = new Set(['url']);

/** True when a field declaration reads a URL from node config. */
function isUrlField(field: { kind?: string; key: string }): boolean {
  return field.kind === 'url' || URL_FIELD_KEYS.has(field.key);
}

/** The origins a workflow needs host access to. Pure: no browser APIs. */
export function workflowOrigins(workflow: Workflow, registry: BlockRegistry): WorkflowOrigins {
  const origins = new Set<string>();
  let anySite = false;
  let hasUrlBlock = false;
  let hasPageBlock = false;

  for (const node of workflow.nodes) {
    const def = registry.get(node.type);
    if (!def) continue;
    if (def.category === 'page') hasPageBlock = true;

    let nodeHasOrigin = false;
    for (const field of def.fields) {
      if (!isUrlField(field)) continue;
      const value = node.config[field.key];
      if (typeof value !== 'string' || value === '') continue;
      if (value.includes('{{')) {
        anySite = true;
        continue;
      }
      const pattern = originPattern(value);
      if (pattern) {
        origins.add(pattern);
        nodeHasOrigin = true;
      }
      // not http(s) (about:blank, file://, …) → skip
    }
    if (nodeHasOrigin) hasUrlBlock = true;

    // page-visited: its url is a pattern. A wildcard host (or empty) means any site.
    if (def.type === 'page-visited') {
      const value = node.config.url;
      if (typeof value === 'string' && value === '') {
        anySite = true;
        continue;
      }
      if (typeof value === 'string' && value.includes('*')) {
        anySite = true;
        continue;
      }
      if (typeof value === 'string') {
        const pattern = originPattern(value);
        if (pattern) {
          origins.add(pattern);
          nodeHasOrigin = true;
          hasUrlBlock = true;
        }
      }
    }
  }

  // Blocks that act on "the tab you are on" without a URL: a page block with no URL-bearing block
  // at all means the workflow can reach any site.
  if (!hasUrlBlock && hasPageBlock) anySite = true;

  return { origins: [...origins].sort(), anySite };
}
