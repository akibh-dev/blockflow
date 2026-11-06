import { PAGE_ACCENT, PAGE_TIMEOUT_SECONDS, inPage, locatorField, modifierProblems, modifiersOf, positionOf, positionProblems, tabField } from './pageCommon';
import type { BlockDefinition } from '../types';

/** Drag settings. Positions are "x,y" from each element's top-left corner; empty = its center. */
export interface DragConfig {
  tab: string;
  from: string;
  to: string;
  fromPosition: string;
  toPosition: string;
  modifiers: string;
}

/**
 * Drag: drags one element onto another (`drag` agent request), like Playwright's `dragTo`. Works for
 * HTML5 drag and drop (draggable="true", file-less) and for pointer-event drags (sliders, sortables).
 * With real input, the browser's own mouse does it (native drags through CDP drag interception).
 */
export const dragBlock: BlockDefinition<DragConfig> = {
  type: 'drag',
  label: 'Drag',
  description: 'Drag an element onto another one: sortable lists, kanban cards, sliders, drop targets.',
  icon: '✋',
  accent: PAGE_ACCENT,
  defaultConfig: { tab: 'main', from: '', to: '', fromPosition: '', toPosition: '', modifiers: '' },
  realInput: true,
  timeoutSeconds: PAGE_TIMEOUT_SECONDS,
  fields: [
    { ...locatorField('from', 'Drag this'), help: 'The element to pick up (a card, a list item, a slider handle).' },
    { ...locatorField('to', 'Drop on'), help: 'The element to drop it on (another item, a column, a spot on the slider track).' },
    { key: 'fromPosition', label: 'Grab at', kind: 'text', placeholder: '5,5', help: 'x,y in pixels from the top-left corner of "Drag this". Empty = its center.' },
    { key: 'toPosition', label: 'Drop at', kind: 'text', placeholder: '0,10', help: 'x,y in pixels from the top-left corner of "Drop on". Empty = its center.' },
    { key: 'modifiers', label: 'Keys held', kind: 'text', placeholder: 'Alt', help: 'Modifier keys held during the drag: Alt, Control, Meta, Shift.' },
    tabField,
  ],
  summary: (config) => `${config.from || '…'} → ${config.to || '…'}`,
  validate: (config) => [...positionProblems('fromPosition', config.fromPosition), ...positionProblems('toPosition', config.toPosition), ...modifierProblems('modifiers', config.modifiers)],
  outputs: [
    { key: '(same data)', description: 'The input, passed on.' },
    { key: 'dragMode', description: '"html5" (drag events) or "pointer" (pointer/mouse moves): how the page took the drag.' },
  ],

  async run(ctx, input) {
    const fromPosition = positionOf(ctx.config.fromPosition, 'Grab at');
    const toPosition = positionOf(ctx.config.toPosition, 'Drop at');
    const modifiers = modifiersOf(ctx.config.modifiers);
    const { result } = await inPage(ctx, input, {
      op: 'drag',
      locator: ctx.config.from,
      to: ctx.config.to,
      ...(fromPosition ? { fromPosition } : {}),
      ...(toPosition ? { toPosition } : {}),
      ...(modifiers ? { modifiers } : {}),
    });
    if (result.mode === 'html5' && result.dropped === false) ctx.log('warn', `${ctx.config.to} did not accept the drop (its dragover was not cancelled)`);
    ctx.log('info', `Dragged ${ctx.config.from} onto ${ctx.config.to}${result.mode ? ` (${String(result.mode)})` : ''}`);
    return { ...input, dragMode: typeof result.mode === 'string' ? result.mode : 'pointer' };
  },
};
