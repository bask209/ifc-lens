// SPDX-License-Identifier: Apache-2.0
/** Shadow-DOM stylesheet of <ifc-viewer>. Hosts theme it through CSS custom properties and ::part(). */

export const VIEWER_CSS = `
:host {
  display: block;
  position: relative;
  min-width: 0;
  min-height: 240px;
  contain: content;
  --ifc-viewer-background: #d5dbde;
  --ifc-viewer-surface: #e9ece8;
  --ifc-viewer-ink: #1d2731;
  --ifc-viewer-muted: #5c6773;
  --ifc-viewer-rule: #c3cac9;
  --ifc-viewer-accent: #f2c12e;
  --ifc-viewer-accent-ink: #1d2731;
  --ifc-viewer-danger: #b3261e;
  --ifc-viewer-panel-width: 320px;
  --ifc-viewer-font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-family: var(--ifc-viewer-font-family);
  font-size: 13px;
  line-height: 1.4;
  color: var(--ifc-viewer-ink);
}
:host([hidden]) { display: none; }
:host([theme="dark"]) {
  --ifc-viewer-background: #1a2027;
  --ifc-viewer-surface: #232b34;
  --ifc-viewer-ink: #e6eaee;
  --ifc-viewer-muted: #9aa5b1;
  --ifc-viewer-rule: #36414d;
}
@media (prefers-color-scheme: dark) {
  :host([theme="auto"]) {
    --ifc-viewer-background: #1a2027;
    --ifc-viewer-surface: #232b34;
    --ifc-viewer-ink: #e6eaee;
    --ifc-viewer-muted: #9aa5b1;
    --ifc-viewer-rule: #36414d;
  }
}
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
button, input, select { font: inherit; color: inherit; }

.root {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--ifc-viewer-panel-width);
  grid-template-rows: minmax(0, 1fr) auto;
  grid-template-areas: "viewport sidebar" "status status";
  background: var(--ifc-viewer-surface);
  overflow: hidden;
}
.root[data-ui="minimal"], .root[data-ui="none"], .root[data-sidebar="closed"] {
  grid-template-columns: minmax(0, 1fr) 0;
}
.root[data-ui="minimal"] .sidebar, .root[data-ui="none"] .sidebar, .root[data-sidebar="closed"] .sidebar { display: none; }
.root[data-ui="none"] .toolbar, .root[data-ui="none"] .status { display: none; }
.root[data-ui="none"] { grid-template-rows: minmax(0, 1fr) 0; }

.viewport {
  grid-area: viewport;
  position: relative;
  min-width: 0;
  min-height: 0;
  background: var(--ifc-viewer-background);
}
canvas {
  width: 100%;
  height: 100%;
  display: block;
  outline: none;
  cursor: grab;
}
canvas:active { cursor: grabbing; }
canvas:focus-visible { box-shadow: inset 0 0 0 2px var(--ifc-viewer-accent); }

/* ---- tool rail ---- */
.toolbar {
  position: absolute;
  left: 10px;
  top: 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  background: var(--ifc-viewer-surface);
  border: 1px solid var(--ifc-viewer-rule);
  border-radius: 6px;
  z-index: 2;
}
.toolbar hr {
  width: 100%;
  height: 1px;
  border: 0;
  margin: 3px 0;
  background: var(--ifc-viewer-rule);
}
.tool {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  color: var(--ifc-viewer-ink);
}
.tool svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.tool:hover { background: color-mix(in srgb, var(--ifc-viewer-ink) 9%, transparent); }
.tool:focus-visible { outline: 2px solid var(--ifc-viewer-accent); outline-offset: 1px; }
.tool[aria-pressed="true"] { background: var(--ifc-viewer-accent); color: var(--ifc-viewer-accent-ink); }
.tool:disabled { opacity: 0.35; cursor: default; }

/* ---- section (clip) tool ---- */
.clip-panel {
  position: absolute;
  left: 56px;
  top: 10px;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  min-width: 260px;
  background: var(--ifc-viewer-surface);
  border: 1px solid var(--ifc-viewer-rule);
  border-left: 3px solid var(--ifc-viewer-accent);
  border-radius: 6px;
  z-index: 2;
}
.clip-panel fieldset { border: 0; margin: 0; padding: 0; display: flex; gap: 2px; }
.clip-panel legend { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.axis {
  min-width: 26px;
  height: 26px;
  border: 1px solid var(--ifc-viewer-rule);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  font-weight: 600;
}
.axis[aria-pressed="true"] { background: var(--ifc-viewer-accent); color: var(--ifc-viewer-accent-ink); border-color: var(--ifc-viewer-accent); }
.axis:focus-visible, .clip-panel input:focus-visible { outline: 2px solid var(--ifc-viewer-accent); outline-offset: 1px; }
.clip-panel input[type="range"] { width: 100%; accent-color: var(--ifc-viewer-accent); }

/* ---- orientation cube ---- */
.cube-scene {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 110px;
  height: 110px;
  perspective: 760px;
  z-index: 2;
}
.cube {
  position: absolute;
  inset: 0;
  transform-style: preserve-3d;
  will-change: transform;
}
.cube-face {
  position: absolute;
  left: 16px;
  top: 16px;
  width: 78px;
  height: 78px;
  display: grid;
  grid-template: repeat(3, 1fr) / repeat(3, 1fr);
  backface-visibility: hidden;
  border: 1px solid var(--ifc-viewer-rule);
  /* fixed shading in model space: the top face catches the light */
  background: color-mix(in srgb, var(--ifc-viewer-surface) 94%, transparent);
}
.cube-face[data-face="top"] { background: color-mix(in srgb, var(--ifc-viewer-surface) 97%, #fff); }
.cube-face[data-face="bottom"] { background: color-mix(in srgb, var(--ifc-viewer-surface) 80%, var(--ifc-viewer-rule)); }
.cube-face[data-face="left"], .cube-face[data-face="back"] { background: color-mix(in srgb, var(--ifc-viewer-surface) 88%, var(--ifc-viewer-rule)); }
.cube-cell {
  border: 0;
  padding: 0;
  margin: 0;
  background: transparent;
  color: var(--ifc-viewer-muted);
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
}
.cube-cell-face {
  color: var(--ifc-viewer-ink);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.01em;
}
.cube-cell:hover { background: color-mix(in srgb, var(--ifc-viewer-accent) 70%, transparent); color: var(--ifc-viewer-accent-ink); }
.cube-cell:focus-visible { outline: 2px solid var(--ifc-viewer-accent); outline-offset: -2px; }
.root[data-ui="none"] .cube-scene { display: none; }

/* ---- orbit anchor ---- */
.pivot {
  position: absolute;
  width: 20px;
  height: 20px;
  margin: -10px 0 0 -10px;
  border-radius: 50%;
  border: 1.5px solid var(--ifc-viewer-accent);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45), inset 0 0 0 1px rgba(0, 0, 0, 0.45);
  pointer-events: none;
  opacity: 0;
  transition: opacity 160ms ease-out;
  z-index: 3;
}
.pivot::after {
  content: "";
  position: absolute;
  inset: 7px;
  border-radius: 50%;
  background: var(--ifc-viewer-accent);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45);
}
.pivot[data-active="true"] { opacity: 1; }

/* ---- help ---- */
.help-button {
  position: absolute;
  right: 12px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 11px 0 8px;
  border: 1px solid var(--ifc-viewer-rule);
  border-radius: 15px;
  background: var(--ifc-viewer-surface);
  color: var(--ifc-viewer-ink);
  cursor: pointer;
  z-index: 3;
}
.help-button svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.help-button:hover { border-color: var(--ifc-viewer-accent); }
.help-button[aria-expanded="true"] { background: var(--ifc-viewer-accent); color: var(--ifc-viewer-accent-ink); border-color: var(--ifc-viewer-accent); }
.help-panel {
  position: absolute;
  right: 12px;
  bottom: 50px;
  width: 356px;
  max-width: calc(100% - 24px);
  /* stays clear of the orientation cube in the opposite corner */
  max-height: calc(100% - 180px);
  display: flex;
  flex-direction: column;
  background: var(--ifc-viewer-surface);
  border: 1px solid var(--ifc-viewer-rule);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  z-index: 3;
}
.help-panel header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 6px 6px 12px;
  border-bottom: 1px solid var(--ifc-viewer-rule);
}
.help-panel h2 { margin: 0; font-size: 13px; }
.help-panel h3 {
  margin: 11px 0 5px;
  font-size: 11px;
  font-weight: 600;
  color: var(--ifc-viewer-muted);
}
.help-panel h3:first-child { margin-top: 0; }
.help-scroll { overflow: auto; padding: 12px; overscroll-behavior: contain; }
.help-panel dl {
  margin: 0;
  display: grid;
  grid-template-columns: 132px 1fr;
  gap: 3px 12px;
  align-items: baseline;
}
.help-panel dt { color: var(--ifc-viewer-muted); }
.help-panel dd { margin: 0; }
.help-panel .keys {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px 12px;
}
.help-panel kbd {
  display: inline-block;
  min-width: 18px;
  padding: 1px 4px;
  margin-right: 2px;
  font: inherit;
  font-size: 11px;
  text-align: center;
  color: var(--ifc-viewer-ink);
  background: var(--ifc-viewer-background);
  border: 1px solid var(--ifc-viewer-rule);
  border-radius: 3px;
}
.help-panel p { margin: 0; }
.help-panel .touch-only { display: none; }
@media (pointer: coarse) {
  .help-panel dt.touch-only, .help-panel dd.touch-only { display: revert; }
}
.help-panel code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.root[data-ui="none"] .help-button, .root[data-ui="none"] .help-panel { display: none; }

/* ---- overlays ---- */
.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
  padding: 24px;
  text-align: center;
}
.empty p { margin: 0; color: var(--ifc-viewer-muted); font-size: 15px; max-width: 34ch; }
.empty strong { color: var(--ifc-viewer-ink); font-weight: 600; }
.viewport[data-drop="true"] { box-shadow: inset 0 0 0 3px var(--ifc-viewer-accent); }
.error-card {
  pointer-events: auto;
  max-width: 460px;
  text-align: left;
  background: var(--ifc-viewer-surface);
  border: 1px solid var(--ifc-viewer-rule);
  border-left: 3px solid var(--ifc-viewer-danger);
  border-radius: 6px;
  padding: 12px 14px;
}
.error-card h2 { margin: 0 0 4px; font-size: 15px; }
.error-card p { margin: 0 0 10px; overflow-wrap: anywhere; }
.error-card button { border: 1px solid var(--ifc-viewer-rule); background: transparent; border-radius: 4px; padding: 4px 10px; cursor: pointer; }

/* ---- sidebar ---- */
.sidebar {
  grid-area: sidebar;
  min-width: 0;
  overflow: hidden;
  display: grid;
  grid-template-rows: minmax(120px, 1fr) minmax(120px, 1fr);
  min-height: 0;
  border-left: 1px solid var(--ifc-viewer-rule);
  background: var(--ifc-viewer-surface);
}
.panel { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.panel header .meta { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 55%; }
.panel + .panel { border-top: 1px solid var(--ifc-viewer-rule); }
.panel header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px 6px;
}
.panel h2 { margin: 0; font-size: 13px; font-weight: 650; flex: 1; }
.panel .meta { color: var(--ifc-viewer-muted); font-variant-numeric: tabular-nums; font-size: 12px; }
.search {
  margin: 0 10px 6px;
  padding: 5px 8px;
  border: 1px solid var(--ifc-viewer-rule);
  border-radius: 4px;
  background: color-mix(in srgb, var(--ifc-viewer-surface) 60%, var(--ifc-viewer-background));
}
.search:focus-visible { outline: 2px solid var(--ifc-viewer-accent); outline-offset: 0; }
.scroll { overflow: auto; min-height: 0; flex: 1; padding-bottom: 8px; }

/* ---- tree ---- */
.tree, .tree ul { list-style: none; margin: 0; padding: 0; }
.row {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 26px;
  padding-right: 6px;
  cursor: default;
  white-space: nowrap;
}
.row:hover { background: color-mix(in srgb, var(--ifc-viewer-ink) 6%, transparent); }
[role="treeitem"]:focus-visible > .row { outline: 2px solid var(--ifc-viewer-accent); outline-offset: -2px; }
[role="treeitem"] { outline: none; }
[role="treeitem"][aria-selected="true"] > .row { background: color-mix(in srgb, var(--ifc-viewer-accent) 55%, transparent); }
.twisty {
  width: 20px;
  height: 20px;
  flex: none;
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--ifc-viewer-muted);
  cursor: pointer;
  padding: 0;
}
.twisty svg { width: 10px; height: 10px; fill: currentColor; transition: transform 120ms ease; }
[aria-expanded="true"] > .row .twisty svg { transform: rotate(90deg); }
.twisty[data-leaf] { visibility: hidden; }
.label { overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.type { color: var(--ifc-viewer-muted); font-size: 12px; margin-left: 6px; }
.eye {
  width: 22px;
  height: 22px;
  flex: none;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--ifc-viewer-muted);
  cursor: pointer;
  display: grid;
  place-items: center;
  opacity: 0;
}
.row:hover .eye, .eye:focus-visible, .eye[aria-pressed="false"] { opacity: 1; }
.eye:focus-visible { outline: 2px solid var(--ifc-viewer-accent); }
.eye svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }
.row[data-hidden="true"] .label { color: var(--ifc-viewer-muted); text-decoration: line-through; }
.more {
  margin: 2px 0 4px;
  border: 0;
  background: transparent;
  color: var(--ifc-viewer-muted);
  text-decoration: underline;
  cursor: pointer;
}

/* ---- properties ---- */
.props { padding: 0 10px; }
.props .hint { color: var(--ifc-viewer-muted); margin: 4px 0; }
details { border-top: 1px solid var(--ifc-viewer-rule); }
details:first-child { border-top: 0; }
summary {
  cursor: pointer;
  padding: 6px 0;
  font-weight: 600;
  list-style-position: inside;
}
summary:focus-visible { outline: 2px solid var(--ifc-viewer-accent); }
table { width: 100%; border-collapse: collapse; margin-bottom: 6px; table-layout: fixed; }
th, td { text-align: left; vertical-align: top; padding: 2px 0; }
th { font-weight: 400; color: var(--ifc-viewer-muted); width: 44%; padding-right: 8px; overflow-wrap: anywhere; }
td { overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
td .unit { color: var(--ifc-viewer-muted); margin-left: 3px; }

/* ---- status strip with tape-measure progress ---- */
.status {
  grid-area: status;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 28px;
  padding: 0 10px;
  border-top: 1px solid var(--ifc-viewer-rule);
  background: var(--ifc-viewer-surface);
  font-variant-numeric: tabular-nums;
}
.status .text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status .text[data-kind="error"] { color: var(--ifc-viewer-danger); }
.tape {
  position: relative;
  width: min(280px, 40%);
  height: 14px;
  border-radius: 2px;
  background:
    repeating-linear-gradient(90deg, var(--ifc-viewer-ink) 0 1px, transparent 1px 10px) bottom left / 100% 5px no-repeat,
    repeating-linear-gradient(90deg, var(--ifc-viewer-ink) 0 1px, transparent 1px 50px) bottom left / 100% 9px no-repeat,
    color-mix(in srgb, var(--ifc-viewer-ink) 8%, transparent);
  overflow: hidden;
}
.tape .fill {
  position: absolute;
  inset: 0 auto 0 0;
  width: 0;
  background: var(--ifc-viewer-accent);
  mix-blend-mode: multiply;
  transition: width 160ms linear;
}
:host([theme="dark"]) .tape .fill { mix-blend-mode: normal; opacity: 0.85; }
.status .counts { color: var(--ifc-viewer-muted); white-space: nowrap; }

.overlay .muted { color: var(--ifc-viewer-muted); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

@media (max-width: 720px) {
  .root { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(0, 42%) auto; grid-template-areas: "viewport" "sidebar" "status"; }
  .root[data-sidebar="closed"], .root[data-ui="minimal"] { grid-template-rows: minmax(0, 1fr) 0 auto; }
  .sidebar { border-left: 0; border-top: 1px solid var(--ifc-viewer-rule); }
  .clip-panel { left: 56px; right: 10px; min-width: 0; }
  .tape { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .pivot { transition: none; }
  .twisty svg, .tape .fill { transition: none; }
}
`;
