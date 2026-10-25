import type { BlockDefinition } from '../types';

export interface ManualStepConfig {
  message: string;
}

/**
 * Manual Step — pauses the run until you press Continue (in the notification or the editor), for
 * the things automation must not do: CAPTCHAs, 2FA codes, a quick look before going on.
 */
export const manualStepBlock: BlockDefinition<ManualStepConfig> = {
  type: 'manual-step',
  label: 'Manual Step',
  description: 'Pause until you press Continue: solve a CAPTCHA, type a 2FA code, take a look.',
  icon: '✋',
  accent: '#d97706',
  defaultConfig: { message: 'Solve the CAPTCHA in the open tab, then press Continue.' },
  timeoutSeconds: 600,
  fields: [{ key: 'message', label: 'What to do', kind: 'text', templated: true, multiline: true, required: true }],
  summary: (config) => config.message,
  outputs: [{ key: '(same data)', description: 'The input, passed on after you continue.' }],

  async run(ctx, input) {
    ctx.log('info', `Waiting for you: ${ctx.config.message}`);
    const ok = await ctx.host.prompt.ask({
      runId: ctx.runId,
      workflowName: ctx.workflowName,
      message: ctx.config.message,
      timeoutMs: Math.max(1_000, ctx.timeoutMs - 1_000),
    });
    if (!ok) throw new Error('Failed by the user at a manual step');
    ctx.log('info', 'Continued by the user');
    return input;
  },
};
