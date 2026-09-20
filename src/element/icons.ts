// SPDX-License-Identifier: Apache-2.0
/** Project-drawn inline SVG icons (static markup, never built from model data). */

const svg = (body: string): string => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICONS = {
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.3 9.4a2.8 2.8 0 1 1 3.4 2.8c-.6.2-.9.7-.9 1.3v.5"/><path d="M11.8 17.2h.4"/>'),
  open: svg('<path d="M3 7h6l2 2h10v10H3z"/><path d="M3 7V5h6"/>'),
  fit: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><rect x="8" y="8" width="8" height="8"/>'),
  fitSelection: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><circle cx="12" cy="12" r="3"/>'),
  hide: svg('<path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/><path d="M4 4l16 16"/>'),
  isolate: svg('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  showAll: svg('<path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.5"/>'),
  section: svg('<path d="M4 16l8-4 8 4-8 4z"/><path d="M4 16V8l8-4 8 4v8" stroke-dasharray="2 2"/><path d="M2 12h20"/>'),
  top: svg('<rect x="5" y="5" width="14" height="14"/><path d="M5 5l3 3h8l3-3M8 8v8h8V8"/>'),
  iso: svg('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>'),
  sidebar: svg('<rect x="3" y="4" width="18" height="16"/><path d="M15 4v16"/>'),
  flip: svg('<path d="M7 7h11l-3-3M17 17H6l3 3"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  twisty: '<svg viewBox="0 0 10 10" aria-hidden="true" focusable="false"><path d="M3 1l5 4-5 4z"/></svg>',
  eye: svg('<path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.5"/>'),
  eyeOff: svg('<path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/><path d="M4 4l16 16"/>'),
} as const;
