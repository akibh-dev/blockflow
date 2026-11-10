import { CodedError } from '../errors';
import { maskPayload } from '../runs';
import { requireSessionTab } from '../session';
import { PAGE_ACCENT, tabField } from './pageCommon';
import type { BlockDefinition } from '../types';

export interface HarRecordConfig { action: 'start' | 'stop'; tab: string; dataset: string; filename: string }

export const harRecordBlock: BlockDefinition<HarRecordConfig> = {
  type: 'har-record', label: 'HAR Record',
  description: 'Start or stop recording network metadata as HAR 1.2. Chromium only; bodies, cookies and headers are excluded.',
  icon: '📡', accent: PAGE_ACCENT, permissions: ['debugger'],
  defaultConfig: { action: 'start', tab: 'main', dataset: '', filename: '' },
  fields: [
    { key: 'action', label: 'Do', kind: 'select', options: [{ value: 'start', label: 'start recording' }, { value: 'stop', label: 'stop and return HAR' }] },
    { key: 'dataset', label: 'Save entries to dataset (stop, optional)', kind: 'text', templated: true, help: 'Replaces this dataset with the HAR entries.' },
    { key: 'filename', label: 'Download HAR file (stop, optional)', kind: 'text', templated: true, placeholder: 'network.har', help: 'Leave blank to return the HAR without downloading it.' },
    tabField,
  ],
  validate: (config) => config.action === 'start' && (String(config.dataset ?? '').trim() || String(config.filename ?? '').trim())
    ? [{ key: 'action', code: 'config.invalid', message: 'Dataset and download destinations are only used when stopping HAR recording.' }] : [],
  summary: (config) => `${config.action} network recording`,
  outputs: [
    { key: 'recording', description: 'Whether recording is active.' },
    { key: 'har', description: 'On stop: HAR 1.2 log, metadata only (at most 500 entries).' },
    { key: 'truncated', description: 'True when more requests occurred than the recording limit.' },
    { key: 'datasetSize', description: 'Entries written when a dataset was supplied.' },
  ],
  async run(ctx, input) {
    const { action, dataset, filename } = ctx.config;
    if (action !== 'start' && action !== 'stop') throw new CodedError('config.invalid', 'HAR Record action must be start or stop.');
    if (action === 'start' && (dataset.trim() || filename.trim())) throw new CodedError('config.invalid', 'Dataset and download destinations are only used when stopping HAR recording.');
    const tabId = requireSessionTab(input, ctx.config.tab);
    const captured = await ctx.host.network.har(tabId, action);
    // A HAR is an exportable artifact: mask configured secrets before dataset/file writes too.
    const secrets = await ctx.host.secrets.all();
    const result = maskPayload(captured, Object.values(secrets).filter((value) => value.length >= 3));
    let datasetSize: number | undefined;
    if (result.har && dataset.trim()) datasetSize = await ctx.host.datasets.write(dataset.trim(), result.har.log.entries, 'replace');
    if (result.har && filename.trim()) await ctx.host.downloads.save(filename.trim(), JSON.stringify(result.har, null, 2), 'application/json');
    ctx.log('info', action === 'start' ? 'HAR recording started (metadata only)' : `HAR recording stopped: ${result.har?.log.entries.length ?? 0} entries${result.truncated ? ' (limit reached)' : ''}`);
    return { ...input, ...result, ...(datasetSize !== undefined ? { datasetSize } : {}) };
  },
};
