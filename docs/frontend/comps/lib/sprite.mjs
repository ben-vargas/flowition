// DESIGN §3.5: one hand-authored SVG sprite, 1.5px stroke on a 16px grid, no icon
// library. Every glyph is aria-hidden at the use site; the interactive parent carries
// the label. Status glyphs are the §3.2 vocabulary.

const G = {
  // ---- §3.2 status vocabulary ------------------------------------------------
  queued:    '<circle cx="8" cy="8" r="6" stroke-dasharray="2.2 2.3"/>',
  running:   '<circle cx="8" cy="8" r="6" opacity=".28"/><path d="M14 8a6 6 0 0 0-6-6"/>',
  done:      '<circle cx="8" cy="8" r="6"/><path d="m5.2 8.3 2 2 3.6-4.3"/>',
  cached:    '<path d="M13.9 8.4A5.9 5.9 0 1 1 12 3.6"/><path d="M14 2.3v3.4h-3.4"/>',
  failed:    '<circle cx="8" cy="8" r="6"/><path d="m5.9 5.9 4.2 4.2m0-4.2-4.2 4.2"/>',
  cancelled: '<circle cx="8" cy="8" r="6"/><path d="M4.2 11.8 11.8 4.2"/>',
  stale:     '<path d="M8.9 2.6l5.5 9.6a1 1 0 0 1-.9 1.5H2.5a1 1 0 0 1-.9-1.5l5.5-9.6a1 1 0 0 1 1.8 0Z"/><path d="M8 6.4v3"/><path d="M8 11.5h.01"/>',
  blocked:   '<circle cx="8" cy="8" r="6"/><path d="M6.2 6.2A1.8 1.8 0 1 1 8 8.4v.9"/><path d="M8 11.4h.01"/>',
  steered:   '<path d="M1.6 4h9v6.6h-9z"/><path d="m1.6 4.4 4.5 3.2L10.6 4.4"/><path d="m10.7 11.8 1.5 1.5 2.4-3.2"/>',
  unknown:   '<circle cx="8" cy="8" r="6"/><path d="M8 7.2v3.6"/><path d="M8 4.9h.01"/>',
  orphaned:  '<circle cx="8" cy="8" r="6" stroke-dasharray="1.4 2.2"/><path d="M8 5.2v3.4"/><path d="M8 10.9h.01"/>',

  // ---- §3.5 utility set ------------------------------------------------------
  chevron:  '<path d="m5.6 3.4 5 4.6-5 4.6"/>',
  chevdown: '<path d="m3.4 5.6 4.6 5 4.6-5"/>',
  copy:     '<rect x="5.6" y="5.6" width="7.4" height="7.4" rx="1"/><path d="M10.4 5.6V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v5.4a1 1 0 0 0 1 1h1.6"/>',
  check:    '<path d="m3 8.6 3.4 3.4L13 4.6"/>',
  close:    '<path d="M4 4l8 8M12 4l-8 8"/>',
  search:   '<circle cx="7" cy="7" r="4.3"/><path d="m10.2 10.2 3.5 3.5"/>',
  send:     '<path d="M2.6 8h10.8"/><path d="m9.2 3.8 4.2 4.2-4.2 4.2"/>',
  cancel:   '<circle cx="8" cy="8" r="6"/><path d="M5.6 8h4.8"/>',
  resume:   '<circle cx="8" cy="8" r="6"/><path d="m6.5 5.3 4.2 2.7-4.2 2.7z"/>',
  trash:    '<path d="M3.2 5.2h9.6"/><path d="M6.2 5.2V3.8a.8.8 0 0 1 .8-.8h2a.8.8 0 0 1 .8.8v1.4"/><path d="m4.6 5.2.6 7.6a1 1 0 0 0 1 .9h3.6a1 1 0 0 0 1-.9l.6-7.6"/>',
  external: '<path d="M9.6 3h3.4v3.4"/><path d="m13 3-5.2 5.2"/><path d="M11.4 9.6v2.6a1 1 0 0 1-1 1H3.8a1 1 0 0 1-1-1V5.6a1 1 0 0 1 1-1h2.6"/>',
  mail:     '<rect x="1.8" y="4" width="12.4" height="8" rx="1"/><path d="m1.9 4.6 6.1 4.2 6.1-4.2"/>',
  filter:   '<path d="M2.4 4.2h11.2"/><path d="M4.6 8h6.8"/><path d="M6.8 11.8h2.4"/>',
  columns:  '<rect x="2.6" y="3.2" width="10.8" height="9.6" rx="1"/><path d="M6.2 3.2v9.6M9.8 3.2v9.6"/>',
  gantt:    '<path d="M2.4 4.6h5.6M4.8 8h7.2M2.4 11.4h4.4"/>',
  tree:     '<path d="M2.8 3.2v8.4a1 1 0 0 0 1 1h1.8"/><path d="M2.8 7.6h2.8"/><rect x="6.4" y="2.2" width="7" height="2.6" rx=".6"/><rect x="6.4" y="6.3" width="7" height="2.6" rx=".6"/><rect x="6.4" y="10.4" width="7" height="2.6" rx=".6"/>',
  table:    '<rect x="2.6" y="3.4" width="10.8" height="9.2" rx="1"/><path d="M2.6 6.5h10.8M2.6 9.6h10.8M6.4 3.4v9.2"/>',
  keyboard: '<rect x="1.6" y="4.4" width="12.8" height="7.2" rx="1.2"/><path d="M4.2 7h.01M6.4 7h.01M8.6 7h.01M10.8 7h.01M4.6 9.3h6.8"/>',
  sun:      '<circle cx="8" cy="8" r="3.1"/><path d="M8 1.4v1.7M8 12.9v1.7M1.4 8h1.7M12.9 8h1.7M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2"/>',
  moon:     '<path d="M13.2 9.9A5.7 5.7 0 0 1 6.1 2.8a5.9 5.9 0 1 0 7.1 7.1Z"/>',
  clock:    '<circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.4 1.5"/>',
  terminal: '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1"/><path d="m4.6 6.4 2 1.8-2 1.8M8.6 10.4h3"/>',
  tool:     '<path d="M6 3.4 2.8 8 6 12.6M10 3.4 13.2 8 10 12.6"/>',
  reasoning:'<circle cx="4.6" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="11.4" cy="8" r="1.1"/>',
  filenew:  '<path d="M4 2.4h4.4L11.8 5.8v7.2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.4a1 1 0 0 1 1-1Z"/><path d="M8.2 2.6v3.4h3.4"/><path d="M6.6 10.2h3.2M8.2 8.6v3.2"/>',
  fileedit: '<path d="M11.4 8.6v4.4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.4a1 1 0 0 1 1-1h4"/><path d="m9.2 7.4 4-4 1.3 1.3-4 4-1.9.6z"/>',
  filedel:  '<path d="M4 2.4h4.4l3.4 3.4v7.2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.4a1 1 0 0 1 1-1Z"/><path d="M8.2 2.6v3.4h3.4"/><path d="m6.6 9 3.2 3.2m0-3.2L6.6 12.2"/>',
  filemove: '<path d="M4 2.4h4.4l3.4 3.4v7.2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.4a1 1 0 0 1 1-1Z"/><path d="M8.2 2.6v3.4h3.4"/><path d="M6 10.6h4M8.4 9.2l1.4 1.4-1.4 1.4"/>',
  plus:     '<path d="M8 3.6v8.8M3.6 8h8.8"/>',
  minus:    '<path d="M3.6 8h8.8"/>',
  drag:     '<path d="M6.4 3.4v9.2M9.6 3.4v9.2"/>',
  bolt:     '<path d="M8.8 1.8 3.6 9.2h3.6l-.8 5 5.2-7.4H8l.8-5Z"/>',
};

export const GLYPH_NAMES = Object.keys(G);

export const SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
${Object.entries(G).map(([k, d]) =>
  `<symbol id="i-${k}" viewBox="0 0 16 16">${d}</symbol>`).join('\n')}
</svg>`;

/** <use> an icon. size: '' | '12' | '14' | '20'; extra classes appended. */
export const ic = (name, size = '', cls = '') =>
  `<svg class="ic${size ? ` ic-${size}` : ''}${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
