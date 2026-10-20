import { Handle, Position } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import { createContext, useContext } from 'react';
import type { CSSProperties } from 'react';
import type { BlockNodeData } from '../flow/convert';
import { registry } from '../registry';

export type BlockFlowNode = Node<BlockNodeData, 'block'>;

/** nodeId → problems found by validation, so each block can show a warning badge. */
export const IssuesContext = createContext<Map<string, string[]>>(new Map());

export function BlockNode({ id, data, selected }: NodeProps<BlockFlowNode>) {
  const def = registry.get(data.blockType);
  const problems = useContext(IssuesContext).get(id) ?? [];
  const summary = def?.summary ? def.summary(withDefaults(def.defaultConfig, data.config)) : '';

  return (
    <div
      className={`bf-node${selected ? ' selected' : ''}${problems.length > 0 ? ' has-problem' : ''}`}
      style={{ '--accent': def?.accent ?? '#888' } as CSSProperties}
      title={problems.join('\n')}
    >
      <Handle type="target" position={Position.Left} />
      <div className="bf-node-head">
        <span className="bf-node-icon">{def?.icon ?? '?'}</span>
        <strong>{def?.label ?? data.blockType}</strong>
        {problems.length > 0 && <span className="bf-badge">!</span>}
      </div>
      {summary && <div className="bf-node-summary">{summary}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function withDefaults(defaults: object, config: Record<string, unknown>) {
  return { ...defaults, ...config } as never;
}
