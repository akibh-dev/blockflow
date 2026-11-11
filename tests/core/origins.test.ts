import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../src/core/blocks';
import { originPattern, workflowOrigins } from '../../src/core/origins';
import type { Workflow } from '../../src/core/types';

const registry = createDefaultRegistry();

function wf(nodes: { id: string; type: string; config?: Record<string, unknown> }[]): Workflow {
  return {
    schemaVersion: 2,
    id: 'wf',
    name: 'test',
    enabled: true,
    nodes: nodes.map((node, i) => ({
      id: node.id,
      type: node.type,
      position: { x: i * 100, y: 0 },
      config: node.config ?? {},
    })),
    edges: [],
  };
}

describe('originPattern', () => {
  it('turns a URL into a scheme+host match pattern', () => {
    expect(originPattern('https://shop.example.com/x?y=1')).toBe('https://shop.example.com/*');
    expect(originPattern('http://a.com:8080/p')).toBe('http://a.com:8080/*');
  });

  it('returns null for non-http(s) URLs', () => {
    expect(originPattern('about:blank')).toBeNull();
    expect(originPattern('file:///etc/passwd')).toBeNull();
    expect(originPattern('mailto:a@b.c')).toBeNull();
    expect(originPattern('not a url')).toBeNull();
  });
});

describe('workflowOrigins', () => {
  it('collects two hosts from open-url and http-request, sorted and unique', () => {
    const { origins, anySite } = workflowOrigins(
      wf([
        { id: 'a', type: 'open-url', config: { url: 'https://shop.example.com/item' } },
        { id: 'b', type: 'http-request', config: { url: 'https://api.other.com/data' } },
        { id: 'c', type: 'open-url', config: { url: 'https://shop.example.com/other' } }, // duplicate host
      ]),
      registry,
    );
    expect(origins).toEqual(['https://api.other.com/*', 'https://shop.example.com/*']);
    expect(anySite).toBe(false);
  });

  it('anySite for a templated URL', () => {
    const { anySite } = workflowOrigins(
      wf([{ id: 'a', type: 'open-url', config: { url: 'https://example.com/{{path}}' } }]),
      registry,
    );
    expect(anySite).toBe(true);
  });

  it('page-visited with a wildcard host → anySite', () => {
    const { anySite } = workflowOrigins(
      wf([{ id: 'a', type: 'page-visited', config: { url: '*://*.example.com/*' } }]),
      registry,
    );
    expect(anySite).toBe(true);
  });

  it('page-visited with an empty pattern → anySite', () => {
    const { anySite } = workflowOrigins(
      wf([{ id: 'a', type: 'page-visited', config: { url: '' } }]),
      registry,
    );
    expect(anySite).toBe(true);
  });

  it('navigate to a concrete host → that origin pattern', () => {
    const { origins } = workflowOrigins(
      wf([{ id: 'a', type: 'navigate', config: { url: 'https://x.com/a' } }]),
      registry,
    );
    expect(origins).toEqual(['https://x.com/*']);
  });

  it('about:blank / file:// are ignored', () => {
    const { origins, anySite } = workflowOrigins(
      wf([
        { id: 'a', type: 'open-url', config: { url: 'about:blank' } },
        { id: 'b', type: 'open-url', config: { url: 'file:///x' } },
      ]),
      registry,
    );
    expect(origins).toEqual([]);
    expect(anySite).toBe(false);
  });

  it('a page block with no URL-bearing block at all → anySite', () => {
    // click is a page block; it has no url field.
    const { anySite } = workflowOrigins(
      wf([{ id: 'a', type: 'click', config: { locator: 'button' } }]),
      registry,
    );
    expect(anySite).toBe(true);
  });

  it('a page block plus a URL-bearing block → not anySite from the page rule', () => {
    const { anySite, origins } = workflowOrigins(
      wf([
        { id: 'a', type: 'open-url', config: { url: 'https://example.com' } },
        { id: 'b', type: 'click', config: { locator: 'button' } },
      ]),
      registry,
    );
    expect(anySite).toBe(false);
    expect(origins).toEqual(['https://example.com/*']);
  });

  it('unknown block types are skipped', () => {
    const { anySite, origins } = workflowOrigins(
      wf([{ id: 'a', type: 'no-such-block', config: { url: 'https://example.com' } }]),
      registry,
    );
    expect(anySite).toBe(false);
    expect(origins).toEqual([]);
  });
});
