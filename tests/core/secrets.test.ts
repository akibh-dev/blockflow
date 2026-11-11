import { describe, expect, it } from 'vitest';
import { usesSecrets } from '../../src/core/secrets';
import type { Workflow } from '../../src/core/types';

function wf(nodes: { id: string; type: string; config?: Record<string, unknown> }[]): Workflow {
  return {
    schemaVersion: 2,
    id: 'wf',
    name: 'test',
    enabled: true,
    nodes: nodes.map((node, i) => ({ id: node.id, type: node.type, position: { x: i * 10, y: 0 }, config: node.config ?? {} })),
    edges: [],
  };
}

describe('usesSecrets', () => {
  it('is true when a config value references {{secret.name}}', () => {
    expect(usesSecrets(wf([{ id: 'a', type: 'fill', config: { text: '{{secret.loginPassword}}' } }]))).toBe(true);
  });

  it('is true with spaces inside the braces: {{ secret.x }}', () => {
    expect(usesSecrets(wf([{ id: 'a', type: 'fill', config: { text: '{{ secret.apiToken }}' } }]))).toBe(true);
  });

  it('is true when the reference is nested in an object/array', () => {
    expect(usesSecrets(wf([{ id: 'a', type: 'http-request', config: { headers: { Authorization: 'Bearer {{secret.token}}' } } }]))).toBe(true);
  });

  it('is false when no config references a secret', () => {
    expect(usesSecrets(wf([{ id: 'a', type: 'fill', config: { text: 'hello' } }]))).toBe(false);
    expect(usesSecrets(wf([]))).toBe(false);
  });

  it('is false for a literal "secret." outside braces', () => {
    expect(usesSecrets(wf([{ id: 'a', type: 'fill', config: { text: 'the secret. field is private' } }]))).toBe(false);
    expect(usesSecrets(wf([{ id: 'a', type: 'fill', config: { text: 'not a {{ other }} secret.' } }]))).toBe(false);
  });

  it('is false when the secret reference is in a node that is not part of the workflow (no nodes)', () => {
    expect(usesSecrets(wf([]))).toBe(false);
  });
});
