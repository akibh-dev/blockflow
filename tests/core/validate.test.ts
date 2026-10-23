import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../src/core/blocks';
import { validateWorkflow } from '../../src/core/validate';
import { flow } from '../helpers/fakeHost';

const registry = createDefaultRegistry();
const messages = (workflow: ReturnType<typeof flow>) =>
  validateWorkflow(workflow, registry).map((issue) => `${issue.level}: ${issue.message}`);

describe('validateWorkflow', () => {
  it('accepts a valid timer → open-url flow', () => {
    const wf = flow(
      [
        { id: 'a', type: 'timer', config: { seconds: 30 } },
        { id: 'b', type: 'open-url', config: { url: 'https://example.com' } },
      ],
      [['a', 'b']],
    );
    expect(messages(wf)).toEqual([]);
  });

  it('warns about an empty workflow', () => {
    expect(messages(flow([], []))).toEqual(['warning: This workflow is empty. Add a block to start.']);
  });

  it('reports invalid block settings', () => {
    const wf = flow([{ id: 'a', type: 'open-url', config: { url: '' } }], []);
    expect(messages(wf)).toEqual(['error: URL is required']);
  });

  it('reports unknown block types', () => {
    const wf = flow([{ id: 'a', type: 'nope' }], []);
    expect(messages(wf)).toEqual(['error: Unknown block type "nope"']);
  });

  it('reports connections to missing blocks and self connections', () => {
    const wf = flow([{ id: 'a', type: 'timer' }], [['a', 'ghost']]);
    expect(messages(wf)).toContain('error: A connection points to a missing block');
    const self = flow([{ id: 'a', type: 'timer' }], [['a', 'a']]);
    expect(messages(self)).toContain('error: A block cannot connect to itself');
  });

  it('errors when nothing can start the workflow', () => {
    const wf = flow(
      [
        { id: 'a', type: 'timer' },
        { id: 'b', type: 'timer' },
      ],
      [
        ['a', 'b'],
        ['b', 'a'],
      ],
    );
    expect(messages(wf)).toContain(
      'error: Nothing can start this workflow: every block has an input. Remove a connection.',
    );
  });

  it('warns about blocks that no start block leads to, and about loops', () => {
    const wf = flow(
      [
        { id: 'start', type: 'timer' },
        { id: 'x', type: 'timer' },
        { id: 'y', type: 'timer' },
      ],
      [
        ['x', 'y'],
        ['y', 'x'],
      ],
    );
    const result = messages(wf);
    expect(result).toContain('warning: This block can never run: no start block leads to it');
    expect(result).toContain('warning: This workflow contains a loop. A run stops after 1000 blocks.');
  });

  it('warns about duplicate connections', () => {
    const wf = flow(
      [
        { id: 'a', type: 'timer' },
        { id: 'b', type: 'open-url', config: { url: 'https://example.com' } },
      ],
      [
        ['a', 'b'],
        ['a', 'b'],
      ],
    );
    expect(messages(wf)).toContain('warning: Duplicate connection');
  });
});
