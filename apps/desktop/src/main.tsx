import React from 'react';
import ReactDOM from 'react-dom/client';
import { Bar } from './components/Bar/Bar';
import { Panel } from './components/Panel/Panel';
import { Caption } from './components/Caption/Caption';
import './index.css';

/**
 * Hash-router: the Tauri `bar` window loads `index.html#/bar`, the `panel`
 * window loads `index.html#/panel`. Each renders an independent React tree but
 * both connect to the same sidecar WebSocket.
 */
function Root(): React.ReactElement {
  const route = window.location.hash.replace('#', '');
  if (route.startsWith('/panel')) {
    return (
      <div className="panel-root h-full">
        <Panel />
      </div>
    );
  }
  if (route.startsWith('/caption')) {
    return <Caption />;
  }
  return <Bar />;
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
