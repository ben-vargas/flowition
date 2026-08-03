// DESIGN §3.1's type scale, as ONE validator shared by the product CSS and the reference
// comps — plain ESM, no dependencies, importable from both node:test and vitest.
//
// Why it is shared rather than duplicated. Review round 4 found the shipped stylesheet
// clean and the *comp* stylesheet carrying seven non-monogram 9px declarations, because
// the gate that had just been written scanned `viewer/src` only. The comps are normative
// (§3.7 makes them the thing W11 builds against), so a scale the product obeys and the
// reference drawings do not is a contract that disagrees with itself. Two copies of a
// validator drift the same way one stylesheet did; there is now one, and both suites run it.
//
// The scale is closed: 11 (micro labels), 12 (meta rows), 13 (body/UI), 14 (transcript
// prose), 16 (panel titles), 20 (screen title), 24 (empty-state display). The one size
// below the scale that §3.2 DOES specify is the adapter monogram: "16×16 rounded square,
// 600-weight 9px Plex Sans". It is allowed in exactly the rule that draws it — `.ad` — and
// nowhere else. A badge glyph is not a general-purpose label tier.
//
// A future tier is added by amending §3.1 and this file together, which is the point.

/** §3.1's scale, in px, verbatim. */
export const APPROVED = new Set([11, 12, 13, 14, 16, 20, 24]);

/** §3.2's adapter monogram — the only sub-scale size in the system, and only here. */
export const MONOGRAM = { px: 9, selector: '.ad' };

/** The token spellings a healthy declaration uses instead of a literal px size. */
const TOKEN_RE = /var\(--fs-(?:micro|meta|ui|prose|title|screen|display)\)/g;

/** How many declarations in `text` take their size from a §3.1 token. */
export function tokenSizes(text) {
  return (text.match(TOKEN_RE) ?? []).length;
}

/**
 * Every hard-coded px font size in a stylesheet, with the selector of the rule it sits in.
 *
 * Three spellings count, because all three appear in this repo:
 *   `font-size: Npx`            — the plain declaration, in a rule or an inline style
 *   `font: … Npx/<line-height>` — the shorthand, which is how the comp CSS writes most of them
 * The comp stylesheet is a JS template literal and the comp pages carry inline `style="…"`
 * attributes, so the scan is over TEXT rather than over parsed CSS: an inline 9px label in
 * a page module is exactly the drift this is here to catch, and a CSS parser would not see it.
 *
 * `selector` is best-effort — the text before the last `{` on the line, or `inline style`
 * for a style attribute. It is diagnostic, except for the monogram exemption, where the
 * rule really is `.ad` on its own line in both stylesheets.
 */
export function fontSizes(text, file = '') {
  const found = [];
  let selector = '';
  text.split('\n').forEach((line, i) => {
    const open = line.indexOf('{');
    if (open >= 0 && !/style\s*=/.test(line.slice(0, open))) selector = line.slice(0, open).trim();
    const inline = /style\s*=\s*["'][^"']*(?:font-size:\s*\d|font:\s*[^;"']*\d+px\s*\/)/.test(line);
    const sizes = [
      ...line.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g),
      ...line.matchAll(/font:\s*[^;{}"']*?\b(\d+(?:\.\d+)?)px\s*\//g),
    ];
    for (const m of sizes) {
      found.push({ file, line: i + 1, px: Number(m[1]), selector: inline ? 'inline style' : selector });
    }
  });
  return found;
}

/** The declarations §3.1 does not admit. Empty is the only passing result. */
export function offenders(decls) {
  return decls.filter(
    (d) => !APPROVED.has(d.px) && !(d.px === MONOGRAM.px && d.selector === MONOGRAM.selector),
  );
}

/** One offender, as the line a failure message prints. */
export const describe = (d) => `${d.file}:${d.line} — ${d.px}px on "${d.selector}"`;

/** The message both suites fail with, so the fix reads the same wherever it is hit. */
export const WHY = 'DESIGN §3.1 fixes the scale at 11/12/13/14/16/20/24 (plus §3.2\'s 9px '
  + 'monogram on .ad). Use var(--fs-micro) for micro labels; a new tier needs a §3.1 '
  + 'amendment — and the amendment has to move docs/frontend/comps/lib/type-scale.mjs, '
  + 'which is what makes the product and the reference comps the same scale.';
