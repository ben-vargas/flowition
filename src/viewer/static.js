// Static SPA asset serving (DESIGN §5.8, parity #24–#26).
//
// Defense in depth against traversal, in this order: decode exactly once → reject NUL
// and any surviving `..` segment after normalization → join → verify
// `realpath(target)` stays under `realpath(root)`. The realpath step is the one that
// closes the symlink gap: a `dist/evil.js` symlink
// pointing at `~/.ssh/id_rsa` normalizes and joins cleanly and is caught only here.
//
// node: builtins only.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// parity #24 — woff included alongside woff2 so a fallback font never serves as
// application/octet-stream.
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

export const contentTypeFor = (file) => CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'

/**
 * The built SPA's root: module-relative (`<pkg>/viewer/dist`, which is what ships in
 * package.json#files per §4.6), with a dev fallback to `viewer/dist` under the current
 * working directory for a checkout run from elsewhere.
 *
 * @returns {string} an absolute path; it may not exist yet (the SPA lands in W8/W14).
 */
export function resolveDistRoot() {
  const shipped = fileURLToPath(new URL('../../viewer/dist', import.meta.url))
  const candidates = [shipped, path.join(process.cwd(), 'viewer', 'dist')]
  for (const dir of candidates) {
    try { if (fs.statSync(dir).isDirectory()) return dir } catch { /* next candidate */ }
  }
  return shipped
}

/**
 * Resolve a request path to a file inside `root`, or a refusal.
 *
 * Pure apart from the fs calls it must make (existence + realpath); returned shape is
 * `{file, realPath, isIndex}` on success or `{status, code, message}` on refusal, so the
 * HTTP layer owns every header and the traversal rules stay unit-testable.
 */
export function resolveAsset(root, rawPathname) {
  let decoded
  try {
    // Exactly once (§5.1 principle 1) — a double decode is how `%252e%252e` escapes.
    decoded = decodeURIComponent(rawPathname)
  } catch {
    return { status: 400, code: 'bad_request', message: 'malformed request path' }
  }
  if (decoded.includes('\0')) return { status: 400, code: 'bad_request', message: 'malformed request path' }

  const normalized = path.posix.normalize(decoded)
  // Defense in depth. Request targets are absolute, and both the WHATWG URL parser and
  // `posix.normalize` collapse dot segments in an absolute path down to the root — so a
  // surviving `..` here should be unreachable. It is checked anyway: the cost is one
  // string test, and the failure mode it guards is a path join above the asset root.
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../') || normalized.endsWith('/..')) {
    return { status: 403, code: 'forbidden', message: 'path outside the asset root' }
  }

  const relative = normalized.replace(/^\/+/, '')
  // `/` and any extension-less path are SPA routes, not files: the hash router means
  // deep links arrive as `/` requests anyway, but a stray `/settings` must still boot
  // the app rather than 404 (§5.8, parity #26).
  const wantsIndex = relative === '' || relative.endsWith('/') || !path.extname(relative)
  const target = wantsIndex ? path.join(root, 'index.html') : path.join(root, relative)

  let realRoot
  try {
    realRoot = fs.realpathSync(root)
  } catch {
    return { status: 404, code: 'not_found', message: 'viewer assets are not built — run the viewer build (viewer/dist is missing)' }
  }

  let realPath
  try {
    realPath = fs.realpathSync(target)
  } catch {
    return { status: 404, code: 'not_found', message: 'not found' }
  }

  // The containment check that makes symlinks safe. `realRoot + sep` prefix, not a bare
  // prefix: `/a/dist-evil` must not pass as a child of `/a/dist`.
  if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
    return { status: 403, code: 'forbidden', message: 'path outside the asset root' }
  }

  let stat
  try { stat = fs.statSync(realPath) } catch { return { status: 404, code: 'not_found', message: 'not found' } }
  if (!stat.isFile()) return { status: 404, code: 'not_found', message: 'not found' }

  return { file: target, realPath, size: stat.size, isIndex: wantsIndex || path.basename(realPath) === 'index.html' }
}

/**
 * Cache policy (§5.7): content-hashed bundle output under `assets/` is immutable;
 * everything else — `index.html`, `/boot-theme.js`, icons — is revalidated, because an
 * unhashed name that is cached forever cannot be updated.
 */
export function cacheControlFor(relativePath) {
  return /^assets[\\/]/.test(relativePath) ? 'public, max-age=31536000, immutable' : 'no-cache'
}
