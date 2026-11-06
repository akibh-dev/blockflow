import { DEFAULT_TAB } from '../session';
import { SNAPSHOT_MAX_LINES } from '../page';
import { inPage, locatorField, PAGE_ACCENT, tabField } from './pageCommon';
import type { BlockDefinition } from '../types';

/** Page Snapshot settings. */
export interface PageSnapshotConfig {
  tab: string;
  /** Only this part of the page (first match). Empty = the whole page. */
  locator: string;
  /** Cap of the outline. */
  maxLines: number;
}

/**
 * Page Snapshot — what is on the page, as an outline of the accessibility tree with a ready-made
 * locator per element (the `snapshot` page op, src/dom/snapshot.ts). For writing workflows (paste it
 * into a chat with a model) and for recording what a page looked like during a run.
 */
export const pageSnapshotBlock: BlockDefinition<PageSnapshotConfig> = {
  type: 'page-snapshot',
  label: 'Page Snapshot',
  description: 'Outline of what is on the page (roles, names, a locator for each element), to write steps from or keep with the run.',
  icon: '📸',
  accent: PAGE_ACCENT,
  defaultConfig: { tab: DEFAULT_TAB, locator: '', maxLines: SNAPSHOT_MAX_LINES },
  timeoutSeconds: 30,
  fields: [
    { ...locatorField('locator', 'Part of the page (optional)', false), help: 'Only this element and what is inside it. Empty = the whole page.' },
    { key: 'maxLines', label: 'At most (lines)', kind: 'number', min: 10, max: 10_000, step: 10, help: 'Long pages are cut here, with a note.' },
    tabField,
  ],
  summary: (config) => (config.locator ? `part: ${config.locator}` : 'whole page'),
  outputs: [
    { key: 'snapshot', description: 'The outline: one element per line, e.g. - button "Sign in" [ref=e3] locator=role=button[name="Sign in"].' },
    { key: 'elements', description: 'The same elements as a list of {ref, role, name, tag, locator, value?, checked?, disabled?, level?, url?}.' },
  ],

  async run(ctx, input) {
    const locator = ctx.config.locator.trim();
    const { result } = await inPage(ctx, input, {
      op: 'snapshot',
      ...(locator ? { locator } : {}),
      maxLines: Math.max(10, Math.floor(Number(ctx.config.maxLines) || SNAPSHOT_MAX_LINES)),
    });
    if (result.truncated) ctx.log('warn', `Snapshot cut at ${String(result.lines)} lines`);
    return { ...input, snapshot: result.snapshot, elements: result.elements };
  },
};
