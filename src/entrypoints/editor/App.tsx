import { ReactFlowProvider } from '@xyflow/react';
import { DialogHost } from './components/Dialogs';
import { Editor } from './Editor';

/**
 * Root component of the editor page. `ReactFlowProvider` sits above `Editor` so that `Editor` itself
 * can call `useReactFlow()` (for `screenToFlowPosition` when a block is dropped on the canvas).
 * `DialogHost` shows the toasts and dialogs of `components/Dialogs.tsx`.
 */
export function App() {
  return (
    <ReactFlowProvider>
      <Editor />
      <DialogHost />
    </ReactFlowProvider>
  );
}
