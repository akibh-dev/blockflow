import { csvToObjects } from '../csv';
import { CodedError } from '../errors';
import { sessionTab } from '../session';
import { PAGE_ACCENT, pageWaitMs, tabField } from './pageCommon';
import type { BlockContext, BlockDefinition, ConfigProblem, Payload } from '../types';

/** Wait for Download settings. `read` other than none fetches the file's content again (see Host.downloads.readText). */
export interface WaitForDownloadConfig {
  tab: string;
  url: string;
  read: 'none' | 'text' | 'csv' | 'json';
  dataset: string;
}

/** How far back a download still counts (it usually starts during the Click just before this block). */
const LOOK_BACK_MS = 15_000;

/**
 * Wait for Download — catches a file the page downloads (an "Export CSV" button, a report link) and
 * says what it is. Optionally reads it: as text, CSV rows or JSON, and saves rows to a dataset.
 */
export const waitForDownloadBlock: BlockDefinition<WaitForDownloadConfig> = {
  type: 'wait-for-download',
  label: 'Wait for Download',
  description: 'Wait until the page downloads a file (an export, a report) and get its name, size and type. Can read CSV / JSON / text files.',
  icon: '📥',
  accent: PAGE_ACCENT,
  defaultConfig: { tab: 'main', url: '', read: 'none', dataset: '' },
  timeoutSeconds: 60,
  fields: [
    {
      key: 'url',
      label: 'URL or file name (optional)',
      kind: 'text',
      templated: true,
      placeholder: 'export.csv  ·  /reports/*  ·  /\\.pdf$/',
      help: 'Empty = the first download. Plain text: the address or file name contains it; * and /regex/ as in Wait For.',
    },
    {
      key: 'read',
      label: 'Read the file',
      kind: 'select',
      options: [
        { value: 'none', label: 'no, just its name, size and type' },
        { value: 'text', label: 'as text → content' },
        { value: 'csv', label: 'as CSV rows → rows' },
        { value: 'json', label: 'as JSON → data' },
      ],
      help: 'Extensions cannot open files on disk, so the file is fetched again from its address (with the site\'s cookies). Fine for exports; a link that makes a new file each time gives that new file.',
    },
    { key: 'dataset', label: 'Save rows to dataset (optional)', kind: 'text', templated: true, placeholder: 'exports', help: 'CSV rows, or a JSON list, replace this dataset.' },
    { ...tabField, help: 'The tab that starts the download. Needed only to read files the page made itself (blob: addresses).' },
  ],
  summary: (config) => `download ${config.url || '(any)'}${config.read !== 'none' ? ` → ${config.read}` : ''}`,
  validate: (config) => {
    const problems: ConfigProblem[] = [];
    if (String(config.dataset ?? '').trim() && (config.read === 'none' || config.read === 'text')) {
      problems.push({ key: 'dataset', code: 'config.value', message: 'Saving to a dataset needs "Read the file" as CSV or JSON' });
    }
    return problems;
  },
  outputs: [
    { key: 'download', description: '{filename, url, path, size, mime, downloadId} of the finished download.' },
    { key: 'content', description: 'With "as text": the file content.' },
    { key: 'rows', description: 'With "as CSV": one object per row, by header.' },
    { key: 'data', description: 'With "as JSON": the parsed value.' },
    { key: 'datasetSize', description: 'With a dataset: its rows afterwards.' },
  ],

  async run(ctx, input) {
    const { read } = ctx.config;
    const pattern = ctx.config.url.trim();
    const download = await ctx.host.downloads.waitFor(pattern, LOOK_BACK_MS, pageWaitMs(ctx as BlockContext<object>));
    ctx.log('info', `Downloaded ${download.filename} (${download.size >= 0 ? `${download.size} bytes` : 'size unknown'}${download.mime ? `, ${download.mime}` : ''})`);
    let output: Payload = { ...input, download: { ...download } };
    if (read === 'none') return output;
    const text = await ctx.host.downloads.readText(download, sessionTab(input, ctx.config.tab || 'main'));
    let rows: unknown[] | undefined;
    if (read === 'text') output = { ...output, content: text };
    else if (read === 'csv') {
      rows = csvToObjects(text);
      output = { ...output, rows };
    } else {
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch (error) {
        throw new CodedError('download.failed', `${download.filename} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      output = { ...output, data };
      if (Array.isArray(data)) rows = data;
    }
    const dataset = ctx.config.dataset.trim();
    if (dataset && rows) {
      const size = await ctx.host.datasets.write(dataset, rows, 'replace');
      ctx.log('info', `Saved ${rows.length} rows to "${dataset}"`);
      output = { ...output, datasetSize: size };
    }
    return output;
  },
};
