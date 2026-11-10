import type { RunRecord } from '../../core/runs';
import type { Payload } from '../../core/types';

/**
 * M5.5 "Run from here": which input the selected block would start with. It is that block's input in
 * the workflow's most recent run that reached it (newest run first; within a run, its last visit, as
 * the run inspector shows). Inputs that were stored shortened (`$preview`, over MAX_PAYLOAD_CHARS) or
 * with secret values masked cannot be replayed faithfully, so they disable the button with a hint.
 */
export type RunFromInput = { ok: true; input: Payload; runId: string; startedAt: string } | { ok: false; hint: string };

const MASK = '•••';

export function runFromInput(runs: RunRecord[], workflowId: string, nodeId: string): RunFromInput {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index] as RunRecord;
    if (run.workflowId !== workflowId || run.status === 'running') continue;
    const step = [...run.steps].reverse().find((candidate) => candidate.nodeId === nodeId && candidate.input !== undefined);
    if (!step?.input) continue;
    const input = step.input;
    if ('$preview' in input) {
      return { ok: false, hint: 'Its input in the last run was too big to keep in full, so it cannot be replayed. Run the whole workflow instead.' };
    }
    if (JSON.stringify(input).includes(MASK)) {
      return { ok: false, hint: 'Its input in the last run contains hidden secret values (•••), so it cannot be replayed. Run the whole workflow instead.' };
    }
    return { ok: true, input, runId: run.id, startedAt: run.startedAt };
  }
  return { ok: false, hint: 'Run the workflow once first: "Run from here" starts this block with its input from the last run that reached it.' };
}
