import { CodedError } from '../errors';
import { inPage, locatorField, PAGE_ACCENT, PAGE_TIMEOUT_SECONDS, tabField } from './pageCommon';
import type { BlockDefinition, ConfigProblem } from '../types';

/**
 * Upload File settings. `content` and `mime` are used for `source: 'text'`, `url` for `source: 'url'`,
 * `data` (base64 or a `data:` URL, usually a template such as `{{body64}}`) and `mime` for `source: 'data'`.
 * `target: 'dropzone'` drops the file on the element instead of setting a file input.
 */
export interface UploadFileConfig {
  tab: string;
  locator: string;
  source: 'text' | 'url' | 'data';
  content: string;
  url: string;
  data: string;
  filename: string;
  mime: string;
  target: 'input' | 'dropzone';
}

/** UTF-8 text → base64 (btoa alone only handles Latin-1). */
export function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Base64 or a `data:` URL → the base64 and, for a data URL, its MIME type. Whitespace is ignored and
 * URL-safe base64 (- and _) is accepted. Throws `config.invalid` for anything else.
 */
export function decodeFileData(text: string): { base64: string; mime?: string } {
  let value = text.trim();
  let mime: string | undefined;
  const dataUrl = /^data:([^;,]*)((?:;[^;,]*)*),/i.exec(value);
  if (dataUrl) {
    if (!/;base64/i.test(dataUrl[2] ?? '')) {
      // A plain (percent-encoded) data URL: text.
      return { base64: textToBase64(decodeURIComponent(value.slice(dataUrl[0].length))), mime: dataUrl[1] || 'text/plain' };
    }
    mime = dataUrl[1] || undefined;
    value = value.slice(dataUrl[0].length);
  }
  const base64 = value.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.replace(/=+$/, '').length % 4 === 1) {
    throw new CodedError('config.invalid', `The file data is not base64 or a data: URL (starts with "${text.trim().slice(0, 30)}")`);
  }
  const padded = base64.replace(/=+$/, '');
  return { base64: padded + '='.repeat((4 - (padded.length % 4)) % 4), ...(mime ? { mime } : {}) };
}

/**
 * Upload File — puts a file on an <input type="file"> without the file chooser, or drops it on a drop
 * zone: text you write (a CSV, a JSON), a file downloaded from a URL, or base64 data from an earlier block.
 */
export const uploadFileBlock: BlockDefinition<UploadFileConfig> = {
  type: 'upload-file',
  label: 'Upload File',
  description: 'Choose a file for a file input or drop it on a drop zone, without the file dialog: text you write, a file from a URL, or base64 data.',
  icon: '📎',
  accent: PAGE_ACCENT,
  defaultConfig: { tab: 'main', locator: 'input[type=file]', source: 'text', content: '', url: '', data: '', filename: 'upload.txt', mime: 'text/plain', target: 'input' },
  timeoutSeconds: PAGE_TIMEOUT_SECONDS,
  fields: [
    { ...locatorField('locator', 'File input or drop zone'), help: 'The <input type="file"> (hidden ones work too) or its label; with "drop zone", the area files are dropped on.' },
    {
      key: 'target',
      label: 'Put it',
      kind: 'select',
      options: [
        { value: 'input', label: 'on the file input' },
        { value: 'dropzone', label: 'by dropping it on the element (drop zone)' },
      ],
    },
    {
      key: 'source',
      label: 'File',
      kind: 'select',
      options: [
        { value: 'text', label: 'text I write here' },
        { value: 'url', label: 'download it from a URL' },
        { value: 'data', label: 'base64 data (e.g. from HTTP Request)' },
      ],
    },
    { key: 'content', label: 'Content', kind: 'text', templated: true, multiline: true, help: 'For "text".' },
    { key: 'url', label: 'URL', kind: 'text', templated: true, placeholder: 'https://example.com/photo.jpg', help: 'For "download".' },
    {
      key: 'data',
      label: 'Data',
      kind: 'text',
      templated: true,
      placeholder: '{{body64}}',
      help: 'For "base64 data": base64 or a data: URL, usually {{body64}} from HTTP Request with "Response as: base64".',
    },
    { key: 'filename', label: 'File name', kind: 'text', templated: true, help: 'Empty with a URL = the name in the URL.' },
    {
      key: 'mime',
      label: 'Type',
      kind: 'text',
      templated: true,
      placeholder: 'text/csv',
      help: 'For "text" and "base64 data" ({{mime}} after HTTP Request; a data: URL brings its own). With a URL the server says.',
    },
    tabField,
  ],
  summary: (config) =>
    `${config.source === 'url' ? config.url || 'from URL' : config.filename}${config.source === 'data' ? ' (data)' : ''} ${config.target === 'dropzone' ? '⤓' : '→'} ${config.locator}`,
  validate: (config) => {
    const problems: ConfigProblem[] = [];
    if (config.source === 'url') {
      if (!String(config.url ?? '').trim()) problems.push({ key: 'url', code: 'config.required', message: 'URL is required when the file comes from a URL' });
    } else if (config.source === 'data') {
      if (!String(config.data ?? '').trim()) problems.push({ key: 'data', code: 'config.required', message: 'Data is required when the file is base64 data (e.g. "{{body64}}")' });
    } else if (String(config.content ?? '') === '') {
      problems.push({ key: 'content', code: 'config.required', message: 'Content is required when the file is text you write (or set source to "url" or "data")' });
    }
    return problems;
  },
  outputs: [{ key: 'uploaded', description: 'The file name.' }],

  async run(ctx, input) {
    const { source } = ctx.config;
    let file: { name: string; type: string; base64: string };
    if (source === 'url') {
      if (!ctx.config.url.trim()) throw new Error('URL is required');
      const downloaded = await ctx.host.http.download(ctx.config.url.trim());
      file = { name: ctx.config.filename.trim() || downloaded.name, type: downloaded.mime, base64: downloaded.base64 };
    } else if (source === 'data') {
      const decoded = decodeFileData(ctx.config.data);
      file = { name: ctx.config.filename.trim() || 'upload.bin', type: decoded.mime ?? (ctx.config.mime.trim() || 'application/octet-stream'), base64: decoded.base64 };
    } else {
      file = { name: ctx.config.filename.trim() || 'upload.txt', type: ctx.config.mime.trim() || 'text/plain', base64: textToBase64(ctx.config.content) };
    }
    const dropzone = ctx.config.target === 'dropzone';
    await inPage(ctx, input, { op: 'upload', locator: ctx.config.locator, files: [file], ...(dropzone ? { dropzone: true } : {}) });
    ctx.log('info', `${dropzone ? 'Dropped' : 'Uploaded'} ${file.name}`);
    return { ...input, uploaded: file.name };
  },
};
