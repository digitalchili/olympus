import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installClipboardFallback } from './lib/clipboard';
import './styles/globals.css';

installClipboardFallback();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
