/**
 * Entry of the editor page (`editor.html`, loaded by `index.html`). Imports React Flow's base CSS
 * before our own `style.css` so ours wins, then mounts `<App />` in StrictMode (effects run twice in
 * development, so every effect here must clean up after itself).
 */
import '@xyflow/react/dist/style.css';
import './style.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
