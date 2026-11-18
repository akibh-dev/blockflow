import type { CSSProperties, ReactNode } from 'react';
import type { BlockCategory } from '../../../core/types';

/**
 * The editor's icon set: 24×24 line icons drawn with `currentColor`, so they follow the text colour
 * of whatever they sit in. `<Icon name="play" />` draws one; `blockIcon(type)` picks the icon of a
 * block type (palette rows, canvas blocks, the settings panel). A block type missing from
 * `BLOCK_ICONS` falls back to its category's icon, so a new block never shows a blank.
 */
const PATHS = {
  play: <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.7 3.5 5.7 3.5 9s-1 6.3-3.5 9c-2.5-2.7-3.5-5.7-3.5-9S9.5 5.7 12 3z" />
    </>
  ),
  menu: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M8 9h8M8 13h6M8 17h4" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  tab: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M3 9h18M10 14.5h4.5V19M14.5 14.5 9 20" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5-5 2 2-5z" />
    </>
  ),
  popup: (
    <>
      <rect x="3" y="7" width="13" height="13" rx="2" />
      <path d="M10 3h11v11M21 3l-8 8" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6 6 18" />,
  cookie: (
    <>
      <path d="M12 3a9 9 0 1 0 9 9 3 3 0 0 1-3-3 3 3 0 0 1-3-3 3 3 0 0 1-3-3z" />
      <path d="M8.5 11.5h.01M11 16h.01M15.5 14.5h.01" />
    </>
  ),
  route: (
    <>
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <path d="M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5" />
    </>
  ),
  record: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.5" />
    </>
  ),
  phone: (
    <>
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <path d="M11 18h2" />
    </>
  ),
  eraser: (
    <>
      <path d="m7 21-4-4 11-11 7 7-8 8z" />
      <path d="M21 21H7M9.5 9.5l7 7" />
    </>
  ),
  pointer: (
    <>
      <path d="m5 3 14 7-6 1.5L10.5 18z" />
      <path d="m13 11.5 5 5" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
      <path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M7.5 14h9" />
    </>
  ),
  form: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2.5" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </>
  ),
  cursor: <path d="M9 4h6M9 20h6M12 4v16" />,
  select: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2.5" />
      <path d="m14 11 2 2 2-2" />
    </>
  ),
  checkbox: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  drag: <path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" />,
  sliders: <path d="M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4" />,
  upload: <path d="M12 16V4M7 9l5-5 5 5M4 20.5h16" />,
  scroll: (
    <>
      <rect x="7" y="3" width="10" height="18" rx="5" />
      <path d="M12 7v4" />
    </>
  ),
  message: <path d="M4 5h16v11H9l-5 4z" />,
  hourglass: <path d="M6.5 3h11M6.5 21h11M7.5 3c0 5 9 5 9 9s-9 4-9 9M16.5 3c0 5-9 5-9 9" />,
  code: <path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" />,
  text: <path d="M4 6V4.5h16V6M12 4.5v15M9 19.5h6" />,
  list: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
  table: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M3 9.5h18M9 9.5V20" />
    </>
  ),
  pages: (
    <>
      <rect x="7" y="3" width="13" height="15" rx="2" />
      <path d="M4 7v12a2 2 0 0 0 2 2h10" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  tree: (
    <>
      <rect x="9" y="3" width="6" height="5" rx="1" />
      <rect x="3" y="16" width="6" height="5" rx="1" />
      <rect x="15" y="16" width="6" height="5" rx="1" />
      <path d="M12 8v4M6 16v-4h12v4" />
    </>
  ),
  camera: (
    <>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <circle cx="12" cy="12" r="3.5" />
    </>
  ),
  hand: (
    <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4a1.5 1.5 0 0 1 3 0v6M14 10V5.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7c-2.5 0-4-1-5.5-3L3 15.5a1.6 1.6 0 0 1 2.5-2L8 15" />
  ),
  square: <rect x="5" y="5" width="14" height="14" rx="2.5" />,
  diamond: <path d="M12 3 21 12 12 21 3 12z" />,
  branch: <path d="M5 6v12M5 12h5l4-6h5M10 12l4 6h5" />,
  repeat: (
    <>
      <path d="M17 2.5 20.5 6 17 9.5" />
      <path d="M3.5 11.5V10a4 4 0 0 1 4-4h13M7 21.5 3.5 18 7 14.5" />
      <path d="M20.5 12.5V14a4 4 0 0 1-4 4h-13" />
    </>
  ),
  flow: (
    <>
      <rect x="2.5" y="4" width="7" height="6" rx="1.5" />
      <rect x="14.5" y="14" width="7" height="6" rx="1.5" />
      <path d="M9.5 7h3a2 2 0 0 1 2 2v8" />
    </>
  ),
  variable: <path d="M7 4C4.5 7 4.5 17 7 20M17 4c2.5 3 2.5 13 0 16M9.5 9l5 6M14.5 9l-5 6" />,
  braces: (
    <path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1" />
  ),
  filter: <path d="M3.5 5h17l-6.5 8v6l-4 2v-8z" />,
  database: (
    <>
      <ellipse cx="12" cy="5.5" rx="8" ry="3" />
      <path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  download: <path d="M12 3.5v12M7 11l5 5 5-5M4 20.5h16" />,
  bell: <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0" />,
  send: <path d="M21 3 10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5z" />,
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  undo: (
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </>
  ),
  redo: (
    <>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </>
  ),
  layout: (
    <>
      <rect x="3" y="4" width="6" height="6" rx="1.5" />
      <rect x="15" y="4" width="6" height="6" rx="1.5" />
      <rect x="15" y="14" width="6" height="6" rx="1.5" />
      <path d="M9 7h6M18 10v4" />
    </>
  ),
  export: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M12 11v6M9.5 14.5 12 17l2.5-2.5" />
    </>
  ),
  bug: (
    <>
      <rect x="7" y="7" width="10" height="13" rx="5" />
      <path d="M12 11v9M7 12H3.5M20.5 12H17M7 16.5l-3 1.5M17 16.5l3 1.5M7.5 8.5 5 6M16.5 8.5 19 6M9.5 7a2.5 2.5 0 0 1 5 0" />
    </>
  ),
  chevronRight: <path d="m9 6 6 6-6 6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  pen: <path d="M4 20h4L19 9l-4-4L4 16z" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  trash: <path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  alert: <path d="M12 9v4M12 17h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />,
  loader: <path d="M12 3a9 9 0 1 0 9 9" />,
  skip: <path d="M5 5v14l9-7zM18 5v14" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </>
  ),
  runFrom: <path d="M5 4v6a4 4 0 0 0 4 4h10M15 10l4 4-4 4" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className, style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  return (
    <svg
      className={className ? `bf-icon ${className}` : 'bf-icon'}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/** Icon of each block type (the `type` of its definition in src/core/blocks). */
const BLOCK_ICONS: Record<string, IconName> = {
  start: 'play',
  timer: 'clock',
  schedule: 'calendar',
  'page-visited': 'globe',
  'context-menu': 'menu',
  'watch-element': 'eye',
  'open-url': 'tab',
  navigate: 'compass',
  'wait-for-popup': 'popup',
  'wait-for-download': 'download',
  'cookies-storage': 'cookie',
  route: 'route',
  'har-record': 'record',
  emulate: 'phone',
  'clear-site-data': 'eraser',
  'close-tab': 'x',
  click: 'pointer',
  fill: 'cursor',
  'fill-form': 'form',
  'select-option': 'select',
  check: 'checkbox',
  'press-key': 'keyboard',
  drag: 'drag',
  'element-action': 'sliders',
  'upload-file': 'upload',
  scroll: 'scroll',
  dialogs: 'message',
  'wait-for': 'hourglass',
  'run-script': 'code',
  'read-element': 'text',
  'extract-list': 'list',
  'extract-table': 'table',
  paginate: 'pages',
  'page-info': 'info',
  'page-snapshot': 'tree',
  screenshot: 'camera',
  assert: 'checkbox',
  'manual-step': 'hand',
  stop: 'square',
  if: 'diamond',
  switch: 'branch',
  'for-each': 'repeat',
  repeat: 'repeat',
  'run-workflow': 'flow',
  'set-variable': 'variable',
  transform: 'braces',
  filter: 'filter',
  'data-table': 'table',
  'save-dataset': 'database',
  download: 'download',
  notify: 'bell',
  'http-request': 'send',
  log: 'file',
};

const CATEGORY_ICONS: Record<BlockCategory, IconName> = {
  start: 'play',
  browser: 'tab',
  page: 'pointer',
  read: 'text',
  test: 'checkbox',
  logic: 'diamond',
  data: 'braces',
  output: 'send',
};

export function blockIcon(type: string, category?: BlockCategory): IconName {
  return BLOCK_ICONS[type] ?? (category ? CATEGORY_ICONS[category] : 'square');
}

/**
 * CSS custom properties that colour a block by its category (`--cat`, `--cat-soft`, defined per
 * category in style.css as `--c-<category>`). Put on a palette row, a canvas block or the settings panel.
 */
export function categoryStyle(category: BlockCategory | undefined): CSSProperties {
  const key = category ?? 'output';
  return { '--cat': `var(--c-${key})`, '--cat-soft': `var(--c-${key}-soft)` } as CSSProperties;
}

/** Square tile with a block's icon on its category colour. */
export function BlockTile({ type, category, size = 'md' }: { type: string; category?: BlockCategory; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`bf-tile bf-tile-${size}`} style={categoryStyle(category)}>
      <Icon name={blockIcon(type, category)} size={size === 'lg' ? 18 : 15} />
    </span>
  );
}
