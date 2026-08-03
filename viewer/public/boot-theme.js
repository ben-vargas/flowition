// The §9.9 theme bootstrap: a separate first-party file, loaded render-blocking from
// <head> BEFORE the stylesheet, so the CSP's `script-src 'self'` holds (no inline script,
// §7.1.4 / critiques B1+Sol-3) and there is no wrong-theme flash (parity #109).
//
// Deliberately dependency-free, ES5-shaped and tiny: it runs before the bundle and must
// never be the thing that breaks the page. The storage key is shared with
// src/theme/theme.ts — change it in both or the boot and the toggle disagree.
//
// THREE INDEPENDENT try BLOCKS, deliberately. They used to be one, which meant a
// `localStorage.getItem` that throws — Safari's private mode, a Firefox profile with
// `dom.storage.enabled` off, any origin whose storage the user has blocked — skipped
// `prefers-color-scheme` entirely and forced dark on a machine set to light. Storage being
// unavailable says nothing about which theme the OS is asking for, and §9.9's system-follow
// applies exactly when there is no stored preference. So: read storage, and if that fails
// or holds anything other than a theme this app writes, ask the media query.
var stored = null
try {
  stored = localStorage.getItem('flowition.theme')
} catch (err) {
  stored = null
}

var dark
if (stored === 'dark' || stored === 'light') {
  dark = stored === 'dark'
} else {
  // No pinned theme (or an unrecognized one, which is not a preference either) — follow
  // the OS. Dark is the fallback only when the query itself is unavailable.
  try {
    dark = !window.matchMedia('(prefers-color-scheme: light)').matches
  } catch (err) {
    dark = true
  }
}

try {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
} catch (err) {
  /* no documentElement to paint — the bundle's own sync will set it after mount */
}
