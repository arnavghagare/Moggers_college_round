import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { EngineProvider } from './engine';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EngineProvider>
      <App />
    </EngineProvider>
  </StrictMode>,
);
