/** Injected once per document; every class is `strata-obs-` prefixed to stay out of the host app. */

export const STYLE_ID = "strata-obs-style";

export const CSS = `
.strata-obs { position: fixed; z-index: 99999; min-width: 320px; min-height: 42px; width: 420px; height: 480px;
  display: flex; flex-direction: column; overflow: hidden; resize: both;
  background: rgba(13,17,23,.96); border: 1px solid #30363d; border-radius: 10px;
  color: #e6edf3; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  box-shadow: 0 8px 28px rgba(0,0,0,.45); }
.strata-obs.collapsed { height: auto !important; min-height: 0; resize: none; }
.strata-obs.dragging { opacity: .92; cursor: grabbing; }
.strata-obs * { box-sizing: border-box; }
.strata-obs-head { display: flex; align-items: center; gap: 7px; padding: 7px 10px; cursor: grab;
  background: rgba(22,27,34,.96); border-bottom: 1px solid #21262d; user-select: none; flex: none; }
.strata-obs.collapsed .strata-obs-head { border-bottom: none; }
.strata-obs-grip { color: #484f58; }
.strata-obs-live { width: 7px; height: 7px; border-radius: 50%; background: #3fb950; }
.strata-obs-name { font-weight: 700; color: #a371f7; }
.strata-obs-summary { color: #8b949e; margin-left: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.strata-obs-btn { background: none; border: none; color: #8b949e; cursor: pointer; font: inherit; padding: 2px 6px; }
.strata-obs-btn:hover { color: #e6edf3; }
.strata-obs-tabs { display: flex; gap: 2px; padding: 6px 8px 0; flex: none; }
.strata-obs-tab { background: none; border: 1px solid transparent; border-radius: 6px 6px 0 0; color: #8b949e;
  cursor: pointer; font: inherit; padding: 4px 10px; }
.strata-obs-tab.active { color: #e6edf3; background: #161b22; border-color: #30363d; border-bottom-color: #161b22; }
.strata-obs-body { flex: 1; min-height: 0; display: flex; flex-direction: column; background: #161b22;
  border-top: 1px solid #30363d; margin-top: -1px; }
.strata-obs-pane { flex: 1; min-height: 0; display: none; flex-direction: column; }
.strata-obs-pane.active { display: flex; }

/* systems (loop readout) */
.strata-obs-loop { overflow: auto; padding: 6px 0; }
.strata-obs-phase { padding: 6px 10px 2px; color: #8b949e; font-weight: 700; }
.strata-obs-sys { display: flex; align-items: center; gap: 7px; padding: 2px 10px 2px 16px; white-space: nowrap; }
.strata-obs-dot { width: 6px; height: 6px; border-radius: 50%; background: #30363d; flex: none; }
.strata-obs-dot.on { background: #3fb950; }
.strata-obs-sysname { min-width: 110px; overflow: hidden; text-overflow: ellipsis; }
.strata-obs-bar { flex: 1; height: 5px; border-radius: 3px; background: #21262d; overflow: hidden; }
.strata-obs-bar > i { display: block; height: 100%; background: #58a6ff; border-radius: 3px; }
.strata-obs-sys.flush .strata-obs-bar > i { background: #a371f7; }
.strata-obs-stat { color: #8b949e; min-width: 118px; text-align: right; }

/* entities */
.strata-obs-filterrow { display: flex; gap: 6px; padding: 6px 8px; flex: none; }
.strata-obs-filter { flex: 1; background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px;
  font: inherit; padding: 3px 8px; outline: none; }
.strata-obs-list { flex: 1.4; overflow-y: auto; position: relative; min-height: 0; }
.strata-obs-spacer { position: absolute; inset: 0 0 auto 0; }
.strata-obs-rows { position: absolute; left: 0; right: 0; }
.strata-obs-row { display: flex; align-items: center; gap: 7px; height: 20px; padding: 0 10px;
  white-space: nowrap; cursor: pointer; overflow: hidden; }
.strata-obs-row:hover { background: rgba(88,166,255,.08); }
.strata-obs-row.sel { background: rgba(88,166,255,.16); }
.strata-obs-id { color: #6e7681; min-width: 64px; }
.strata-obs-label { overflow: hidden; text-overflow: ellipsis; }
.strata-obs-chip { background: rgba(163,113,247,.18); color: #d2a8ff; border-radius: 8px; padding: 0 6px; font-size: 10px; }
.strata-obs-detail { flex: 1; min-height: 90px; overflow: auto; border-top: 1px solid #30363d; padding: 7px 10px; }
.strata-obs-comp { display: flex; gap: 8px; padding: 1px 0; }
.strata-obs-cname { color: #79c0ff; min-width: 92px; }
.strata-obs-cval { color: #e6edf3; white-space: pre-wrap; word-break: break-word; }
.strata-obs-empty { color: #6e7681; padding: 12px; }

/* timeline */
.strata-obs-tlbar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; flex: none; }
.strata-obs-seg { display: flex; border: 1px solid #30363d; border-radius: 6px; overflow: hidden; }
.strata-obs-seg button { background: none; border: none; color: #8b949e; font: inherit; padding: 2px 9px; cursor: pointer; }
.strata-obs-seg button.on { background: #21262d; color: #e6edf3; }
.strata-obs-tllive { display: flex; align-items: center; gap: 5px; background: none; border: 1px solid #30363d;
  border-radius: 6px; color: #8b949e; font: inherit; padding: 2px 9px; cursor: pointer; }
.strata-obs-tllive .dot { width: 6px; height: 6px; border-radius: 50%; background: #30363d; }
.strata-obs-tllive.on { color: #e6edf3; } .strata-obs-tllive.on .dot { background: #f85149; }
.strata-obs-tlwrap { flex: 1; min-height: 0; position: relative; }
.strata-obs-tlcanvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.strata-obs-tltip { position: absolute; display: none; pointer-events: none; background: rgba(13,17,23,.96);
  border: 1px solid #30363d; border-radius: 6px; padding: 6px 8px; font-size: 11px; z-index: 2; }
.strata-obs-tltip .k { color: #8b949e; }

/* durable + ephemeral (collab stores) */
.strata-obs-storehead { flex: none; padding: 6px 10px; color: #8b949e; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; border-bottom: 1px solid #21262d; }
.strata-obs-durlabels { flex: none; display: grid; grid-template-columns: 1fr 1fr; gap: 2px 8px;
  padding: 3px 10px; color: #8b949e; border-bottom: 1px solid #21262d; }
.strata-obs-durbody, .strata-obs-ephbody { flex: 1; min-height: 0; overflow: auto; }
.strata-obs-durrow { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 8px; padding: 5px 10px;
  border-bottom: 1px solid #21262d; }
.strata-obs-durkey { grid-column: 1 / -1; color: #79c0ff; overflow: hidden; text-overflow: ellipsis; }
.strata-obs-durcol { color: #e6edf3; white-space: pre-wrap; word-break: break-word; }
.strata-obs-durrow.diff { background: rgba(248,81,73,.10); }
.strata-obs-durrow.diff .strata-obs-durkey { color: #f0883e; }
.strata-obs-ephgroup { padding: 6px 10px 2px; color: #d2a8ff; font-weight: 700; }
.strata-obs-ephentry { padding: 1px 10px 4px 16px; }
.strata-obs-ephkey { color: #79c0ff; }
`;

export function injectStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID) !== null) return;
  const el = doc.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  doc.head.appendChild(el);
}
