// SPDX-License-Identifier: Apache-2.0
const viewer = document.getElementById("viewer");
const log = document.getElementById("log");
const form = document.getElementById("source");
const select = document.getElementById("model");
const url = document.getElementById("url");
const file = document.getElementById("file");

function entry(name, text) {
  const li = document.createElement("li");
  const b = document.createElement("b");
  b.textContent = name;
  li.append(b, document.createTextNode(text ? ` ${text}` : ""));
  log.prepend(li);
  while (log.children.length > 60) log.lastChild.remove();
}

let lastPhase = "";
viewer.addEventListener("ifc-load-start", (e) => { log.replaceChildren(); entry("load-start", e.detail.source); });
viewer.addEventListener("ifc-progress", (e) => {
  if (e.detail.phase !== lastPhase) entry("progress", e.detail.phase);
  lastPhase = e.detail.phase;
});
viewer.addEventListener("ifc-model-ready", (e) => entry("model-ready", `${e.detail.schema}, ${e.detail.productCount} elements`));
viewer.addEventListener("ifc-load", (e) => {
  const s = e.detail.stats;
  entry("load", `${s.productsWithGeometry} shown, ${s.triangles.toLocaleString()} triangles, ${Math.round(s.parseMs + s.indexMs + s.geometryMs)} ms`);
});
viewer.addEventListener("ifc-selection-change", (e) => entry("selection", e.detail.selectedIds.length ? `#${e.detail.selectedIds.join(", #")}` : "cleared"));
viewer.addEventListener("ifc-visibility-change", (e) => entry("visibility", `${e.detail.visibleProducts} visible`));
viewer.addEventListener("ifc-diagnostic", (e) => { if (e.detail.severity !== "info") entry(e.detail.code, e.detail.message); });
viewer.addEventListener("ifc-error", (e) => entry("error", e.detail.error.message));

form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (url.value) viewer.src = url.value;
});
select.addEventListener("change", () => { viewer.src = select.value; });
file.addEventListener("change", () => {
  const f = file.files?.[0];
  if (f) viewer.load(f).catch(() => {});
  file.value = "";
});
