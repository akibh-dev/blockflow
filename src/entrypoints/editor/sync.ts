import type { Workflow } from '../../core/types';

/**
 * Keeping several editor tabs (and the first-install sample seeding) from overwriting each other.
 *
 * The editor saves its whole workflow list. When storage changes under it (another editor tab
 * saved), it merges per workflow: a workflow this tab has not touched since the last sync takes
 * the stored version; one it edited keeps its own version (it will be saved again shortly). Pure,
 * so it is tested without a browser.
 */

/** JSON of each workflow as last seen in storage, by id. */
export type SyncBase = Map<string, string>;

/** The base for a list just loaded from or saved to storage. */
export function syncBase(list: Workflow[]): SyncBase {
  return new Map(list.map((workflow) => [workflow.id, JSON.stringify(workflow)]));
}

/** True when this tab changed `workflow` (or created it) since the last sync. */
function editedHere(workflow: Workflow, base: SyncBase): boolean {
  return base.get(workflow.id) !== JSON.stringify(workflow);
}

/**
 * Merges the list another tab stored (`theirs`) into this tab's list (`ours`).
 * - In both: theirs, unless this tab edited it since the last sync.
 * - Only in theirs: added there, taken.
 * - Only in ours: created here and not saved yet (kept), or deleted there (dropped unless edited here).
 * Order follows theirs, with this tab's new workflows at the end.
 */
export function mergeStoredWorkflows(ours: Workflow[], base: SyncBase, theirs: Workflow[]): Workflow[] {
  const mine = new Map(ours.map((workflow) => [workflow.id, workflow]));
  const merged = theirs.map((stored) => {
    const local = mine.get(stored.id);
    return local && editedHere(local, base) ? local : stored;
  });
  const storedIds = new Set(theirs.map((workflow) => workflow.id));
  for (const local of ours) {
    if (storedIds.has(local.id)) continue;
    if (!base.has(local.id) || editedHere(local, base)) merged.push(local);
  }
  return merged;
}
