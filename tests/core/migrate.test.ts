import { describe, expect, it } from 'vitest';
import { parseImport } from '../../src/core/library';
import { CURRENT_SCHEMA_VERSION, migrateNode, migrateWorkflow, migrateWorkflows, type Rename } from '../../src/core/migrate';
import type { Workflow } from '../../src/core/types';

const v1 = (nodes: Workflow['nodes']): Workflow =>
  ({ schemaVersion: 1, id: 'w', name: 'Old', enabled: true, nodes, edges: [] }) as unknown as Workflow;
const node = (type: string, config: Record<string, unknown>) => ({ id: type, type, position: { x: 0, y: 0 }, config });

describe('workflow migration (v1 → v2)', () => {
  it('renames selector → locator (Read/Watch Element) and next → locator (Paginate)', () => {
    const renames: Rename[] = [];
    const migrated = migrateWorkflow(
      v1([
        node('read-element', { selector: '.price', url: '' }),
        node('watch-element', { selector: 'h1', url: 'https://a.test' }),
        node('paginate', { next: 'a.next', maxPages: 3 }),
        node('click', { locator: 'text=Go' }),
      ]),
      renames,
    );
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.nodes.map((n) => n.config)).toEqual([
      { locator: '.price', url: '' },
      { locator: 'h1', url: 'https://a.test' },
      { locator: 'a.next', maxPages: 3 },
      { locator: 'text=Go' },
    ]);
    expect(renames.map((r) => `${r.type}:${r.from}->${r.to}`)).toEqual([
      'read-element:selector->locator',
      'watch-element:selector->locator',
      'paginate:next->locator',
    ]);
  });

  it('keeps the new key when a node has both, and leaves untouched nodes as the same object', () => {
    const click = node('click', { locator: 'a' });
    const both = migrateNode(node('read-element', { selector: 'old', locator: 'new' }));
    expect(both.config).toEqual({ locator: 'new' });
    expect(migrateNode(click)).toBe(click);
  });

  it('is a no-op on current workflows, and reports whether the list changed', () => {
    const current = migrateWorkflow(v1([node('read-element', { selector: 'h1' })]));
    expect(migrateWorkflow(current)).toBe(current);
    expect(migrateWorkflows([current]).changed).toBe(false);
    const result = migrateWorkflows([current, v1([])]);
    expect(result.changed).toBe(true);
    expect(result.workflows[0]).toBe(current);
  });

  it('import accepts the old key names in any file', () => {
    const file = { ...v1([node('paginate', { next: 'a.next' })]), schemaVersion: 2 };
    const result = parseImport(JSON.stringify(file), []);
    expect(result.ok && result.workflows[0]?.nodes[0]?.config).toEqual({ locator: 'a.next' });
    expect(result.ok && result.workflows[0]?.schemaVersion).toBe(2);
  });
});
