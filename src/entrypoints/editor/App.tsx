import { ReactFlowProvider } from '@xyflow/react';
import { Editor } from './Editor';

/**
 * Root component of the editor page. `ReactFlowProvider` sits above `Editor` so that `Editor` itself
 * can call `useReactFlow()` (for `screenToFlowPosition` when a block is dropped on the canvas).
 */
export function App() {
  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  );
}
