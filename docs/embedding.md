# Embedding

## Files to serve

Copy the package's `dist/` directory to your site (for example as `/ifc-viewer/`). The element module resolves its worker as `./worker/model-worker.js` relative to itself. If you serve the worker elsewhere, set `worker-url` (a module worker script URL).

```html
<script type="module" src="/ifc-viewer/ifc-viewer.js"></script>
<ifc-viewer src="/models/office.ifc" ui="full" theme="auto" style="display:block;width:100%;height:650px"></ifc-viewer>
```

Attributes:

| Attribute | Values | Default |
|---|---|---|
| `src` | model URL (http, https or blob) | none |
| `ui` | `full` (tool rail, tree, properties, status), `minimal` (tool rail and status), `none` (canvas only) | `full` |
| `theme` | `light`, `dark`, `auto` (follows `prefers-color-scheme`) | `auto` |
| `autofit` | `false` keeps the camera when a model finishes loading | fits on load |
| `credentials` | `same-origin`, `include`, `omit` (for `src` fetches) | `same-origin` |
| `worker-url` | URL of `model-worker.js` | next to the module |
| `render-backend` | `webgl2` | `webgl2` |

## Sources

```js
const viewer = document.querySelector("ifc-viewer");
await viewer.load("/models/a.ifc");                  // URL (relative to document.baseURI)
await viewer.load(new URL("https://cdn.example.com/b.ifc"), { credentials: "include" });
await viewer.load(fileInput.files[0]);                // File (read locally, never uploaded)
await viewer.load(blob);                              // Blob
await viewer.load(arrayBuffer);                       // ArrayBuffer: transferred to the worker (detached afterwards)
await viewer.load(uint8Array);                        // Uint8Array: copied
```

`.ifczip` archives are detected by signature. The first `.ifc` member is inflated in the worker with the platform `DecompressionStream`.

A new `load()` cancels the one in progress (its promise rejects with `AbortError`). Pass `{ signal }` to cancel from outside. Resource limits can be set per load, e.g. `{ maxFileBytes: 200e6, maxTriangles: 5e6 }`; see `WorkerLimits` in [api.md](api.md).

### Cross-origin files

The worker fetches `src` URLs. Cross-origin files need `Access-Control-Allow-Origin` (and `Access-Control-Allow-Credentials: true` when using `credentials="include"`). Without them, the `ifc-error` event explains that the failure is a network/CORS problem rather than a generic "failed to load".

## Events

All events bubble and are composed. They are listed in [api.md](api.md#events).

```js
viewer.addEventListener("ifc-progress", (e) => bar.value = e.detail.completed / (e.detail.total ?? 1));
viewer.addEventListener("ifc-model-ready", (e) => console.log(e.detail.schema));   // tree and property queries available
viewer.addEventListener("ifc-load", (e) => console.log(e.detail.stats));           // geometry uploaded
viewer.addEventListener("ifc-selection-change", (e) => show(e.detail.selectedIds));
viewer.addEventListener("ifc-error", (e) => e.detail.fatal && alert(e.detail.error.message));
```

## Styling

The element uses Shadow DOM, so page CSS does not leak in or out. Theme it with custom properties and parts:

```css
ifc-viewer {
  --ifc-viewer-background: #dfe5e8;
  --ifc-viewer-accent: #f2c12e;       /* selection and active tools */
  --ifc-viewer-panel-width: 360px;
  --ifc-viewer-font-family: "Inter", system-ui, sans-serif;
}
ifc-viewer::part(toolbar) { border-radius: 10px; }
ifc-viewer::part(sidebar) { border-left-width: 2px; }
```

Parts: `root`, `viewport`, `canvas`, `toolbar`, `view-cube`, `pivot`, `help-button`, `help-panel`, `clip-panel`, `sidebar`, `tree`, `properties`, `status`, `empty`, `error`.

Hide a single overlay with `ifc-viewer::part(view-cube) { display: none; }` (the same works for `help-button` and `help-panel`), or use `ui="none"` for a bare canvas.

## Using the viewer without the element

```js
import { IfcViewer } from "/ifc-viewer/ifc-viewer.js";
const viewer = new IfcViewer({ canvas: document.querySelector("canvas") });
await viewer.load("/models/a.ifc");
viewer.addEventListener("ifc-selection-change", (e) => …);
```

`IfcViewer` has the same methods as the element (select, hide, show, isolate, showAll, fit, setClipPlane(s), getProperties, getEntity, dispose), plus `viewFrom`, `viewPreset`, `getCamera`/`setCamera`, `pickAt` and `snapshot`.

## Navigation

| Input | Action |
|---|---|
| Left drag | Orbit around the point under the cursor (picked when the drag starts, and marked by a ring for the duration of the drag) |
| Middle (wheel click) drag, right drag, Shift+left drag | Pan |
| Wheel / pinch | Zoom towards the cursor |
| Click | Select (Ctrl/Cmd toggles, Shift adds); clicking empty space clears |
| Double click | Fit the element under the cursor |
| One finger / two fingers | Orbit / pinch-zoom and pan |
| Orientation cube face, edge or corner | Swing to that view, keeping pivot and zoom |
| `F` `H` `I` `A` `C` `?` `Esc`, arrows, `+`/`-` | Fit, hide, isolate, show all, section tool, help, clear, orbit, zoom (canvas focused) |

The **Help** button in the bottom-right corner opens a panel with the same table, so an embedded viewer explains itself. Follow the anchor from code with `viewer.onOrbitPivot` and `viewer.project(point)`, which map a model-space point to canvas pixels.

Drive the same thing from code with `viewer.viewFrom([1, -1, 1])` (a direction in model space, Z up) or `viewer.viewPreset("top" | "front" | "side" | "iso")`.

## Iframe embedding

For strict isolation, serve the viewer from its own origin and embed `dist/iframe/index.html`. The page ships with a restrictive CSP. It accepts commands only from the parent origin named in its URL and only with the session nonce passed in the URL fragment.

```js
import { IfcViewerFrameClient } from "https://viewer.example.com/ifc-viewer/iframe/client.js";

const frame = document.querySelector("iframe");            // sandbox="allow-scripts allow-same-origin"
const client = new IfcViewerFrameClient(frame, { viewerOrigin: "https://viewer.example.com" });
frame.src = IfcViewerFrameClient.frameUrl(
  "https://viewer.example.com/ifc-viewer/iframe/index.html",
  location.origin,
  client.sessionNonce,
  "https://viewer.example.com/models/office.ifc",
);
client.on("ifc-selection-change", (d) => console.log(d.selectedIds));
await client.call("select", { ids: [18439], fit: true });
const properties = await client.call("getProperties", { id: 18439 });
```

Commands: `load`, `unload`, `select`, `clearSelection`, `hide`, `show`, `isolate`, `showAll`, `fit`, `setClipPlane`, `getProperties`. Each call resolves with the frame's reply or rejects on validation failure or timeout. The protocol and its checks are described in [security.md](security.md#iframe-bridge).

## Browser support

| Browser | Minimum | What sets it |
|---|---|---|
| Chrome, Edge | 111 | `color-mix()` in the element's stylesheet |
| Firefox | 114 | module workers |
| Safari | 16.4 | `DecompressionStream` for `.ifczip` (16.2 without it) |

All three need WebGL2, which the element reports through a fatal `ifc-error` and an in-view message when it is missing or blocked. Constructable stylesheets and `ResizeObserver` are used when present and degrade silently when not.

## Content Security Policy

The viewer needs `script-src` for its own module files, `worker-src` for the worker script (or `blob:` when you pass a blob URL), and `connect-src` for model URLs. Styles are applied through constructable stylesheets (no inline `<style>` element) when the browser supports them. No `unsafe-eval` is needed.
