import type { BlockDefinition } from '../types';

/** Notify settings (both templated). */
export interface NotifyConfig {
  title: string;
  message: string;
}

/** Notify — shows a desktop notification, then passes the incoming data on unchanged. */
export const notifyBlock: BlockDefinition<NotifyConfig> = {
  type: 'notify',
  label: 'Notify',
  description: 'Show a desktop notification.',
  icon: '🔔',
  accent: '#ec4899',
  defaultConfig: { title: 'BlockFlow', message: '' },
  fields: [
    { key: 'title', label: 'Title', kind: 'text', required: true, templated: true },
    {
      key: 'message',
      label: 'Message',
      kind: 'text',
      templated: true,
      placeholder: 'Price is now {{value}}',
    },
  ],
  summary: (config) => config.message || config.title,
  outputs: [{ key: 'notified', description: 'Always true once the notification was shown.' }],

  async run(ctx, input) {
    await ctx.host.notify({ title: ctx.config.title, message: ctx.config.message });
    ctx.log('info', `Notified: ${ctx.config.title}${ctx.config.message ? ` — ${ctx.config.message}` : ''}`);
    return { ...input, notified: true };
  },
};
