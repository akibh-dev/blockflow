import { inPage, locatorField, PAGE_ACCENT, PAGE_TIMEOUT_SECONDS, tabField } from './pageCommon';
import type { BlockDefinition } from '../types';

export interface UploadFileConfig {
  tab: string;
  locator: string;
  source: 'text' | 'url';
  content: string;
  url: string;
  filename: string;
  mime: string;
}

/** UTF-8 text → base64 (btoa alone only handles Latin-1). */
export function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Upload File — puts a file on an <input type="file"> without the file chooser: text you write
 * (a CSV, a JSON) or a file downloaded from a URL.
 */
export const uploadFileBlock: BlockDefinition<UploadFileConfig> = {
  type: 'upload-file',
  label: 'Upload File',
  description: 'Choose a file for a file input, without the file dialog: text you write, or a file from a URL.',
  icon: '📎',
  accent: PAGE_ACCENT,
  defaultConfig: { tab: 'main', locator: 'input[type=file]', source: 'text', content: '', url: '', filename: 'upload.txt', mime: 'text/plain' },
  timeoutSeconds: PAGE_TIMEOUT_SECONDS,
  fields: [
    { ...locatorField('locator', 'File input'), help: 'The <input type="file"> (hidden ones work too), or its label.' },
    {
      key: 'source',
      label: 'File',
      kind: 'select',
      options: [
        { value: 'text', label: 'text I write here' },
        { value: 'url', label: 'download it from a URL' },
      ],
    },
    { key: 'content', label: 'Content', kind: 'text', templated: true, multiline: true, help: 'For "text".' },
    { key: 'url', label: 'URL', kind: 'text', templated: true, placeholder: 'https://example.com/photo.jpg', help: 'For "download".' },
    { key: 'filename', label: 'File name', kind: 'text', templated: true, help: 'Empty with a URL = the name in the URL.' },
    { key: 'mime', label: 'Type', kind: 'text', placeholder: 'text/csv', help: 'For "text". With a URL the server says.' },
    tabField,
  ],
  summary: (config) => `${config.source === 'url' ? config.url || 'from URL' : config.filename} → ${config.locator}`,
  outputs: [{ key: 'uploaded', description: 'The file name.' }],

  async run(ctx, input) {
    const { source } = ctx.config;
    let file: { name: string; type: string; base64: string };
    if (source === 'url') {
      if (!ctx.config.url.trim()) throw new Error('URL is required');
      const downloaded = await ctx.host.http.download(ctx.config.url.trim());
      file = { name: ctx.config.filename.trim() || downloaded.name, type: downloaded.mime, base64: downloaded.base64 };
    } else {
      file = { name: ctx.config.filename.trim() || 'upload.txt', type: ctx.config.mime.trim() || 'text/plain', base64: textToBase64(ctx.config.content) };
    }
    await inPage(ctx, input, { op: 'upload', locator: ctx.config.locator, files: [file] });
    ctx.log('info', `Uploaded ${file.name}`);
    return { ...input, uploaded: file.name };
  },
};
