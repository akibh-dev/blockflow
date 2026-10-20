import { ReactFlowProvider } from '@xyflow/react';
import { Editor } from './Editor';

export function App() {
  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  );
}
