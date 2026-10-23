import { requireSessionTab } from '../session';
import { PAGE_ACCENT, tabField } from './pageCommon';
import type { BlockDefinition } from '../types';

export interface RunScriptConfig {
  tab: string;
  code: string;
  into: string;
}

/**
 * Run Script — your own JavaScript in the page, for what no block does. The code sees `data` (this
 * block's input) and what it returns is saved. Uses Chrome's userScripts API: Chrome 135+, the
 * "userScripts" permission, and "Allow User Scripts" switched on for BlockFlow.
 */
export const runScriptBlock: BlockDefinition<RunScriptConfig> = {
  type: 'run-script',
  label: 'Run Script',
  description: 'Run your own JavaScript in the page; its return value is saved. Chrome 135+.',
  icon: '🧑‍💻',
  accent: PAGE_ACCENT,
  permissions: ['userScripts'],
  defaultConfig: { tab: 'main', code: "return document.querySelectorAll('a').length;", into: 'result' },
  timeoutSeconds: 30,
  fields: [
    { key: 'code', label: 'JavaScript', kind: 'text', multiline: true, required: true, help: 'An async function body: use await, read `data`, and `return` a JSON value.' },
    { key: 'into', label: 'Save the result as', kind: 'text', placeholder: 'result' },
    tabField,
  ],
  summary: (config) => config.code.split('\n')[0] ?? '',
  outputs: [{ key: 'result', description: 'What the code returned (or the name you chose).' }],

  async run(ctx, input) {
    const tabId = requireSessionTab(input, ctx.config.tab);
    const result = await ctx.host.page.runScript(tabId, ctx.config.code, input);
    return { ...input, [ctx.config.into.trim() || 'result']: result ?? null };
  },
};
