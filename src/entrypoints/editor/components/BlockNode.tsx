import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import { createContext, useContext, useEffect } from 'react';
import type { CSSProperties } from 'react';
import { DEFAULT_PORT, nodePorts } from '../../../core/ports';
import type { StepStatus } from '../../../core/runs';
import type { BlockNodeData } from '../flow/convert';
import { CATEGORY_LABELS } from '../../../core/types';
import { registry } from '../registry';
import { BlockTile, Icon, categoryStyle } from './Icon';
import type { IconName } from './Icon';

/** A React Flow node as the editor stores it in state: `type: 'block'` with `BlockNodeData`. */
export type BlockFlowNode = Node<BlockNodeData, 'block'>;

/** nodeId → problems found by validation, so each block can show a warning badge. */
export const IssuesContext = createContext<Map<string, string[]>>(new Map());

/** nodeId → how the block did in the run being inspected (latest run by default). */
export const RunStatusContext = createContext<Map<string, StepStatus>>(new Map());

const STATUS_ICON: Record<StepStatus, IconName> = {
  running: 'loader',
  passed: 'check',
  failed: 'x',
  handled: 'runFrom',
  skipped: 'skip',
};

/**
 * How one block is drawn on the canvas (registered as node type `block`). Shows icon, label, the
 * block's `summary()` of its settings, a note, a run-status badge (from `RunStatusContext`) and a
 * problem badge (from `IssuesContext`). One input handle on the left; one output handle per port
 * on the right (`nodePorts` with the node's config, so an `error` port appears when On error is
 * "port" and a Switch shows one per case). Handle ids are the port names, which become the edges'
 * `sourceHandle`.
 */
export function BlockNode({ id, data, selected }: NodeProps<BlockFlowNode>) {
  const def = registry.get(data.blockType);
  const problems = useContext(IssuesContext).get(id) ?? [];
  const status = useContext(RunStatusContext).get(id);
  const summary = def?.summary ? def.summary(withDefaults(def.defaultConfig, data.config)) : '';
  const ports = nodePorts(def, { config: data.config, ...(data.step ? { step: data.step } : {}) });
  const single = ports.length === 1 && ports[0] === DEFAULT_PORT;
  // Outputs can come and go with the settings (Switch cases, the error output): React Flow must
  // re-measure the handles, or new ones cannot be connected and edges attach to stale positions.
  const updateNodeInternals = useUpdateNodeInternals();
  const portKey = ports.join('\u0000');
  useEffect(() => updateNodeInternals(id), [id, portKey, updateNodeInternals]);

  const classes = ['bf-node'];
  if (selected) classes.push('selected');
  if (problems.length > 0) classes.push('has-problem');
  if (data.step?.disabled) classes.push('disabled');
  if (status) classes.push(`run-${status}`);
  if (!single) classes.push('multi-port');

  return (
    <div
      className={classes.join(' ')}
      style={{ ...categoryStyle(def?.category), minHeight: single ? undefined : 22 + ports.length * 20 } as CSSProperties}
      title={problems.join('\n')}
    >
      <Handle type="target" position={Position.Left} />
      <div className="bf-node-head">
        <BlockTile type={data.blockType} category={def?.category} />
        <span className="bf-node-title">
          <strong>{def?.label ?? data.blockType}</strong>
          {/* Drawn by CSS from the attribute, so it is not part of the block's text (tests find blocks by their label). */}
          {def?.category && <span className="bf-node-category" data-label={CATEGORY_LABELS[def.category]} />}
        </span>
        {status && (
          <span className={`bf-run-badge ${status}`} title={`Last run: ${status}`}>
            <Icon name={STATUS_ICON[status]} size={12} />
          </span>
        )}
        {problems.length > 0 && <span className="bf-badge">!</span>}
      </div>
      {summary && <div className="bf-node-summary">{summary}</div>}
      {data.step?.note && <div className="bf-node-note">{data.step.note}</div>}
      {data.step?.disabled && <div className="bf-node-note">Disabled: passes data through</div>}
      {single ? (
        <Handle type="source" position={Position.Right} id={DEFAULT_PORT} />
      ) : (
        ports.map((port, index) => {
          const top = `${((index + 1) / (ports.length + 1)) * 100}%`;
          return (
            <div key={port}>
              <span className={`bf-port-label port-${port}`} style={{ top }}>
                {port}
              </span>
              <Handle type="source" position={Position.Right} id={port} style={{ top }} className={`port-${port}`} />
            </div>
          );
        })
      )}
    </div>
  );
}

/** Config with defaults filled in, cast for `def.summary` (whose config type is block-specific). */
function withDefaults(defaults: object, config: Record<string, unknown>) {
  return { ...defaults, ...config } as never;
}
