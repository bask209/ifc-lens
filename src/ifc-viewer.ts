// SPDX-License-Identifier: Apache-2.0
/**
 * Browser entry point: registers <ifc-viewer>. Load it with
 * <script type="module" src="…/ifc-viewer.js"></script>.
 */

import { defineIfcViewer, IfcViewerElement } from "./element/ifc-viewer-element.ts";

defineIfcViewer();

export { IfcViewerElement, defineIfcViewer };
export {
  IfcViewer,
  type IfcSource,
  type LoadOptions,
  type ModelHandle,
  type SelectOptions,
  type FitOptions,
  type ClipPlane,
  type ViewerOptions,
  type IfcViewerEventMap,
} from "./core/viewer.ts";
