import { uid } from './id';
import type { EdgeDef, NodeDef } from './types';

/**
 * The recorder (src/dom/recorder.ts) sends what the user did; this turns it into blocks.
 * Pure, so the conversion rules are tested without a browser.
 */
export type RecordedStep =
  | { kind: 'click'; locator: string; text?: string }
  | { kind: 'fill'; locator: string; value: string; secret?: boolean }
  | { kind: 'select'; locator: string; value: string }
  | { kind: 'check'; locator: string; checked: boolean }
  | { kind: 'press'; locator: string; key: string }
  | { kind: 'navigated'; url: string }
  | { kind: 'assert-text'; locator: string; text: string }
  | { kind: 'assert-visible'; locator: string };

export interface Recording {
  startUrl: string;
  steps: RecordedStep[];
}

/** Fills right after each other (≥ this many) become one Fill Form block. */
const FORM_MIN_FIELDS = 2;

function urlPattern(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch {
    return url;
  }
}

/** Removes noise: repeated fills of one field keep the last value; a navigation repeated keeps the last. */
export function tidySteps(steps: RecordedStep[]): RecordedStep[] {
  const out: RecordedStep[] = [];
  for (const step of steps) {
    const last = out.at(-1);
    if (step.kind === 'fill' && last?.kind === 'fill' && last.locator === step.locator) {
      out[out.length - 1] = step;
      continue;
    }
    if (step.kind === 'navigated' && last?.kind === 'navigated') {
      out[out.length - 1] = step;
      continue;
    }
    out.push(step);
  }
  return out;
}

export interface RecordedBlocks {
  nodes: NodeDef[];
  edges: EdgeDef[];
  /** Secret names the recording expects (password fields are not recorded in clear). */
  secrets: string[];
}

/**
 * Blocks in one line: Open Tab, then one block per action. Consecutive fills followed by a click
 * become Fill Form with that click as its submit. A navigation becomes Wait For URL.
 */
export function recordingToBlocks(recording: Recording, origin: { x: number; y: number } = { x: 60, y: 120 }): RecordedBlocks {
  const steps = tidySteps(recording.steps);
  const nodes: NodeDef[] = [];
  const secrets = new Set<string>();
  const add = (type: string, config: Record<string, unknown>) => {
    nodes.push({ id: uid(), type, position: { x: origin.x + nodes.length * 240, y: origin.y }, config });
  };

  add('open-url', { url: recording.startUrl, where: 'new', tab: 'main', active: true, waitUntil: 'load' });
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i] as RecordedStep;
    if (step.kind === 'fill') {
      const run: Extract<RecordedStep, { kind: 'fill' | 'select' | 'check' }>[] = [];
      let j = i;
      for (; j < steps.length; j += 1) {
        const next = steps[j] as RecordedStep;
        if (next.kind !== 'fill' && next.kind !== 'select' && next.kind !== 'check') break;
        run.push(next);
      }
      if (run.filter((item) => item.kind === 'fill').length >= FORM_MIN_FIELDS) {
        const after = steps[j];
        const submit = after?.kind === 'click' ? after.locator : '';
        for (const item of run) if (item.kind === 'fill' && item.secret) secrets.add('password');
        add('fill-form', {
          tab: 'main',
          fields: run.map((item) => ({
            locator: item.locator,
            value: item.kind === 'check' ? String(item.checked) : item.kind === 'fill' && item.secret ? '{{secret.password}}' : item.value,
          })),
          submit,
        });
        i = submit ? j : j - 1;
        continue;
      }
    }
    switch (step.kind) {
      case 'click':
        add('click', { tab: 'main', locator: step.locator, action: 'click', force: false });
        break;
      case 'fill':
        if (step.secret) secrets.add('password');
        add('fill', { tab: 'main', locator: step.locator, value: step.secret ? '{{secret.password}}' : step.value, mode: 'fill' });
        break;
      case 'select':
        add('select-option', { tab: 'main', locator: step.locator, value: step.value });
        break;
      case 'check':
        add('check', { tab: 'main', locator: step.locator, state: step.checked ? 'check' : 'uncheck' });
        break;
      case 'press':
        add('press-key', { tab: 'main', key: step.key, locator: step.locator });
        break;
      case 'navigated':
        add('wait-for', { tab: 'main', mode: 'url', url: urlPattern(step.url), locator: '', text: '' });
        break;
      case 'assert-text':
        add('assert', { subject: 'text', locator: step.locator, operator: 'equals', expected: step.text, tab: 'main' });
        break;
      case 'assert-visible':
        add('assert', { subject: 'visible', locator: step.locator, tab: 'main' });
        break;
    }
  }
  const edges: EdgeDef[] = nodes.slice(1).map((node, index) => ({ id: uid(), source: (nodes[index] as NodeDef).id, target: node.id }));
  return { nodes, edges, secrets: [...secrets] };
}
