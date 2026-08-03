/**
 * §7.1.4 runtime CSP, injection site 2 of 2.
 *
 * The resolved `react-aria` monopackage prepends a `<style>` element to `document.head`
 * from exactly two places (`grep -rn "createElement('style')" node_modules/react-aria/dist`
 * → `private/interactions/usePress.mjs:607`, `private/overlays/usePreventScroll.mjs:102`;
 * `head.prepend` appears at the same two lines and nowhere else). The two need OPPOSITE
 * resolutions, because they differ in the one property that matters:
 *
 *   • `usePress` injects ONCE, for the lifetime of the document, guarded by
 *     `ownerDocument.getElementById('react-aria-pressable-style')`. A document-lifetime
 *     rule can simply be ours — `ui/base.css` ships it and `ui/pressableStyle.ts` claims
 *     the id so the injection never runs. See that file.
 *
 *   • `usePreventScroll` (which EVERY modal invokes via `ControlDialog`) injects
 *     per-modal and only on iOS: `preventScrollMobileSafari()` prepends the rule below on
 *     open and calls `style.remove()` on close. It has no id guard, so the slot-claiming
 *     trick does not apply — and the rule is NOT ours to hoist into `base.css`, because
 *     `* { overscroll-behavior: contain }` applied at all times is a different product
 *     than the same rule applied only while a modal is up. Scroll chaining out of a
 *     transcript pane into the page is correct behavior when there is no modal.
 *
 * So this one is allowed, by content hash, and only by content hash:
 *
 *     style-src 'self' 'sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg='
 *
 * That is not a relaxation in the sense §7.1.4 rejects. `'unsafe-inline'` admits every
 * inline stylesheet; a nonce admits every inline stylesheet the document chooses to mark,
 * and would force per-response HTML rewriting (§7.1.4's stated reason for refusing them,
 * unchanged — note `usePreventScroll` reads `getNonce()` and would have used one). A
 * hash source admits exactly one byte string and nothing else: any other injected rule,
 * from react-aria or from an XSS, is still blocked. Hash sources also do not apply to
 * `style=` attributes without `'unsafe-hashes'`, which is absent — so the §7.1.4 ban on
 * markup style attributes is untouched.
 *
 * The cost of a content hash is that it is pinned to react-aria's exact bytes, whitespace
 * included. `preventScrollStyle.test.ts` mounts a real `ControlDialog` with the platform
 * forced to iPhone, captures what react-aria actually injects, and fails if either the
 * text or its digest drifts from the constants below; `test/viewer-http.test.js` fails if
 * the server's policy stops carrying the digest exported here. A react-aria bump that
 * changes one space therefore breaks the build, not iOS scrolling in silence.
 */

/**
 * The exact text `usePreventScroll` puts in its `<style>` element, byte for byte
 * (`react-aria/dist/private/overlays/usePreventScroll.mjs:105–110`, after `.trim()`).
 */
export const PREVENT_SCROLL_RULE = `@layer {
  * {
    overscroll-behavior: contain;
  }
}`

/**
 * `sha256-<base64>` of {@link PREVENT_SCROLL_RULE} as UTF-8 — the CSP source expression
 * that admits it. Must appear verbatim in `SECURITY_HEADERS['content-security-policy']`
 * (src/viewer/http.js) and in §7.1.4's normative policy string.
 */
export const PREVENT_SCROLL_STYLE_HASH = 'sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg='
