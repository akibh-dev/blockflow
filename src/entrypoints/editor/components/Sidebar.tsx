import { useState } from 'react';
import type { DragEvent } from 'react';
import { CATEGORY_LABELS } from '../../../core/types';
import type { BlockCategory, Workflow } from '../../../core/types';
import { registry } from '../registry';
import { ImportButton } from './ImportButton';
import { NewMenu } from './NewMenu';
import type { WorkflowActions } from './WorkflowActions';

/** `dataTransfer` type used to drag a block type from the palette onto the canvas (read in `Editor`'s `onDrop`). */
export const DRAG_MIME = 'application/x-blockflow-block';

interface SidebarProps extends WorkflowActions {
  workflows: Workflow[];
  activeId: string | null;
  onAddBlock(type: string): void;
}

/**
 * Left column: the workflow list (toggle, open, rename by double click, duplicate, export,
 * Playwright export, delete; a search box once there are more than 4) and the block palette
 * grouped by `CATEGORY_LABELS`, filterable, where a block is added by click or by drag.
 */
export function Sidebar({ workflows, activeId, onAddBlock, ...actions }: SidebarProps) {
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [blockQuery, setBlockQuery] = useState('');
  const needle = blockQuery.trim().toLowerCase();
  const groups = (Object.keys(CATEGORY_LABELS) as BlockCategory[])
    .map((category) => ({
      category,
      blocks: registry
        .list()
        .filter((def) => def.category === category)
        .filter((def) => !needle || `${def.label} ${def.description} ${def.type}`.toLowerCase().includes(needle)),
    }))
    .filter((group) => group.blocks.length > 0);

  const onDragStart = (event: DragEvent<HTMLButtonElement>, type: string) => {
    event.dataTransfer.setData(DRAG_MIME, type);
    event.dataTransfer.effectAllowed = 'move';
  };

  const shown = workflows.filter((workflow) => workflow.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <aside className="bf-sidebar">
      <section>
        <div className="bf-section-title">
          <span>Workflows</span>
          <span>
            <NewMenu onBlank={actions.onCreate} onTemplate={actions.onCreateFromTemplate} />
            <ImportButton className="bf-link" onFiles={actions.onImport} />
          </span>
        </div>
        {workflows.length > 4 && (
          <input
            type="text"
            className="bf-search"
            placeholder="Search…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search workflows"
          />
        )}
        <ul className="bf-workflow-list">
          {shown.map((workflow) => (
            <li key={workflow.id} className={workflow.id === activeId ? 'active' : ''}>
              <button
                type="button"
                className="bf-dot-button"
                title={workflow.enabled ? 'Running. Click to turn off' : 'Off. Click to turn on'}
                onClick={() => actions.onToggle(workflow.id, !workflow.enabled)}
              >
                <span className={`bf-dot${workflow.enabled ? ' on' : ''}`} />
              </button>
              {renaming === workflow.id ? (
                <input
                  type="text"
                  autoFocus
                  defaultValue={workflow.name}
                  aria-label="Rename workflow"
                  onFocus={(event) => event.target.select()}
                  onBlur={(event) => {
                    const name = event.target.value.trim();
                    if (name) actions.onRename(workflow.id, name);
                    setRenaming(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                    if (event.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="bf-workflow-name"
                  onClick={() => actions.onOpen(workflow.id)}
                  onDoubleClick={() => setRenaming(workflow.id)}
                  title={workflow.name}
                >
                  {workflow.name}
                </button>
              )}
              <span className="bf-row-actions">
                <button type="button" title="Rename" onClick={() => setRenaming(workflow.id)}>
                  ✎
                </button>
                <button type="button" title="Duplicate" onClick={() => actions.onDuplicate(workflow.id)}>
                  ⧉
                </button>
                <button type="button" title="Export to file" onClick={() => actions.onExport([workflow.id])}>
                  ⬇
                </button>
                <button type="button" title="Download as a Playwright test" onClick={() => actions.onExportPlaywright(workflow.id)}>
                  🎭
                </button>
                <button type="button" className="bf-danger" title="Delete" onClick={() => actions.onDelete(workflow.id)}>
                  🗑
                </button>
              </span>
            </li>
          ))}
          {shown.length === 0 && <li className="bf-muted">No match.</li>}
        </ul>
      </section>

      <section>
        <div className="bf-section-title">
          <span>Blocks</span>
        </div>
        <input
          type="text"
          className="bf-search"
          placeholder="Find a block…"
          value={blockQuery}
          onChange={(event) => setBlockQuery(event.target.value)}
          aria-label="Find a block"
        />
        {groups.map(({ category, blocks }) => (
          <details key={category} className="bf-palette-group" open={blockQuery.trim() !== '' || category === 'start' || category === 'browser' || category === 'page'}>
            <summary>
              {CATEGORY_LABELS[category]} <span className="bf-muted">{blocks.length}</span>
            </summary>
            <ul className="bf-palette">
              {blocks.map((def) => (
                <li key={def.type}>
                  <button
                    type="button"
                    draggable
                    onDragStart={(event) => onDragStart(event, def.type)}
                    onClick={() => onAddBlock(def.type)}
                    style={{ borderLeftColor: def.accent }}
                    title={`${def.description} Drag onto the canvas, or click to add.`}
                  >
                    <strong>
                      {def.icon} {def.label}
                    </strong>
                    <span>{def.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </section>
    </aside>
  );
}
