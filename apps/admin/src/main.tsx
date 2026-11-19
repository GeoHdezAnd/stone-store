import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@canteras/ui/fonts.css';
import '@canteras/ui/styles.css';
import '@canteras/ui/admin.css';
import './app.css';
import { App } from './app/App';
import { ConfigGate } from './app/ConfigGate';

const root = document.getElementById('root');
if (!root) throw new Error('Falta el elemento #root.');

createRoot(root).render(
  <StrictMode>
    <ConfigGate>{(config) => <App config={config} />}</ConfigGate>
  </StrictMode>,
);
