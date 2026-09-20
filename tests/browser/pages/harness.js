// SPDX-License-Identifier: Apache-2.0
// Test harness: ?count=N viewers, ?src=…, ?ui=…, ?theme=…; records all ifc-* events per viewer.
import "/dist/ifc-viewer.js";

const params = new URLSearchParams(location.search);
const count = Number(params.get("count") ?? 1);
const grid = document.createElement("div");
grid.className = "grid";
grid.style.setProperty("--cols", String(count));
document.body.append(grid);
window.events = [];
const types = ["ifc-load-start", "ifc-progress", "ifc-model-ready", "ifc-geometry-progress", "ifc-load", "ifc-selection-change", "ifc-visibility-change", "ifc-diagnostic", "ifc-resource-limit", "ifc-error", "ifc-unload"];
for (let i = 0; i < count; i++) {
  const v = document.createElement("ifc-viewer");
  v.id = `viewer${i}`;
  for (const attr of ["ui", "theme", "autofit", "credentials", "worker-url"]) if (params.get(attr)) v.setAttribute(attr, params.get(attr));
  v.setAttribute("theme", params.get("theme") ?? "light");
  const log = [];
  window.events.push(log);
  for (const t of types) v.addEventListener(t, (e) => {
    const d = e.detail;
    log.push({ type: t, detail: d && d.error ? { fatal: d.fatal, message: d.error.message, name: d.error.name } : JSON.parse(JSON.stringify(d ?? null)) });
  });
  if (params.get("src") && i === 0) v.setAttribute("src", params.get("src"));
  grid.append(v);
}
window.harnessReady = true;
