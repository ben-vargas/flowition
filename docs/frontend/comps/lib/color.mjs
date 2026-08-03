// OKLCH -> sRGB, OKLab mixing, and WCAG 2.2 relative-contrast.
// Zero dependencies, node: builtins only (same invariant as the product).
//
// Why this exists in a comps directory: DESIGN §3.6 requires "an automated check of
// every (fg, bg) token pair in both themes". The comps must not ship a swatch that
// claims a ratio it does not have, so the ratios printed in tokens.html are computed
// here at generate time rather than typed by hand. W8 lifts this module into the
// viewer's test suite.

/** OKLCH triple -> linear-light sRGB (may be out of gamut). */
export function oklchToLinearSrgb(L, C, H) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const encode = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
const decode = (x) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));

/** Gamut-clip per channel, the way a browser paints an out-of-gamut oklch(). */
function toSrgb8(L, C, H) {
  return oklchToLinearSrgb(L, C, H).map((v) => clamp01(encode(clamp01(v))));
}

export function hex([L, C, H]) {
  const p = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  const [r, g, b] = toSrgb8(L, C, H);
  return `#${p(r)}${p(g)}${p(b)}`;
}

/** WCAG relative luminance of the painted (clipped) color. */
export function luminance([L, C, H]) {
  const [r, g, b] = toSrgb8(L, C, H).map(decode);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.2 contrast ratio between two OKLCH triples. */
export function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const toLab = ([L, C, H]) => {
  const h = (H * Math.PI) / 180;
  return [L, C * Math.cos(h), C * Math.sin(h)];
};
const toLch = ([L, a, b]) => {
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return [L, Math.hypot(a, b), h];
};

/**
 * `color-mix(in oklab, A p%, B)`.
 *
 * DEVIATION from DESIGN §3.2, which writes `color-mix(in oklch, …)`. Rectangular
 * (OKLab) interpolation is required for correctness here: `in oklch` interpolates hue
 * along an arc, and the light theme's two anchors are 160deg apart (canvas H=95 warm
 * paper, ink/accent H=255 blue). `color-mix(in oklch, var(--accent) 10%, var(--canvas))`
 * therefore lands on H=111 and paints --surface-selected #e9eadc, a pale GREEN. In
 * OKLab the same mix is #e1e8ef, the intended cool tint. See README "Deviations".
 */
export function mix(A, B, p) {
  const t = p / 100;
  const la = toLab(A);
  const lb = toLab(B);
  return toLch(la.map((v, i) => lb[i] + (v - lb[i]) * t));
}

/** OKLCH triple -> the CSS function text, for emitting into the token block. */
export const css = ([L, C, H]) =>
  `oklch(${+L.toFixed(4)} ${+C.toFixed(4)} ${+H.toFixed(2)})`;

export const r2 = (n) => n.toFixed(2);
