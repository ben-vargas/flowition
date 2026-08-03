/**
 * The §2.6 JSON tree's projection, as pure data — bounded before a single element exists.
 *
 * DESIGN §2.6: objects render as "a collapsible JSON tree with copy-subtree, **capped at
 * depth 32 and 20,000 rendered nodes** with a 'download raw' fallback beyond either cap
 * (Sol-8 — a recursive tree on a hostile value must not exhaust the stack or the frame
 * budget)".
 *
 * Two properties this module is responsible for, and both are tested:
 *
 *  1. **No recursion, anywhere.** The value arriving here came off the wire and through
 *     `JSON.parse`, which is iterative in V8 and therefore has no trouble producing a
 *     structure that a recursive walker cannot survive. The build below uses an explicit
 *     stack, so the depth cap is a PRODUCT decision (what is worth rendering) rather than
 *     the only thing standing between a hostile payload and a `RangeError`.
 *  2. **The caps are reported, not silently applied.** `capped` names which cap fired, and
 *     `elided` marks the individual containers that were cut, so the screen can say what it
 *     did not draw and offer the raw file instead of presenting a truncated tree as whole.
 *     A viewer that quietly renders 20,000 of 400,000 nodes is lying by omission, which is
 *     the failure mode §2.6 exists to avoid.
 */

/** §2.6, verbatim. */
export const JSON_TREE_MAX_DEPTH = 32
/** §2.6, verbatim. */
export const JSON_TREE_MAX_NODES = 20_000

export type JsonKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'

export interface TreeNode {
  /** Stable within one build — the render uses it for React keys and expansion state. */
  id: string
  /** The property name or array index this node sits under; `null` at the root. */
  key: string | null
  kind: JsonKind
  /** Scalars only. Containers carry their children instead. */
  value: unknown
  children: TreeNode[]
  depth: number
  /** Entry count for containers; `null` for scalars. */
  size: number | null
  /**
   * Why this container has no children in the tree even though it has some on the wire.
   * `null` means it is complete: either it really is empty, or every child is present.
   */
  elided: 'depth' | 'nodes' | null
  /** The subtree's own value, so copy-subtree copies the TRUTH and not the projection. */
  raw: unknown
}

export interface JsonTreeBuild {
  root: TreeNode
  /** Nodes actually projected, root included. */
  nodes: number
  /** The first cap that fired, if any. Non-null ⇒ the screen owes a raw download. */
  capped: 'depth' | 'nodes' | null
  /** The deepest level reached (root = 0). */
  depth: number
}

export function kindOf(value: unknown): JsonKind {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'string': return 'string'
    case 'number': return 'number'
    case 'boolean': return 'boolean'
    default: return 'object'
  }
}

export const isContainer = (kind: JsonKind): boolean => kind === 'object' || kind === 'array'

/** Entries of a container in wire order. Non-containers have none. */
function entriesOf(value: unknown, kind: JsonKind): [string, unknown][] {
  if (kind === 'array') return (value as unknown[]).map((v, i) => [String(i), v])
  if (kind === 'object') return Object.entries(value as Record<string, unknown>)
  return []
}

/**
 * Undefined and functions cannot come out of `JSON.parse`, but `readAgentResult` hands back
 * whatever the journal held, so the kind switch above folds them into `object`. They render
 * as an empty object, which is what `JSON.stringify` would have written anyway.
 */
export function buildJsonTree(
  value: unknown,
  { maxDepth = JSON_TREE_MAX_DEPTH, maxNodes = JSON_TREE_MAX_NODES } = {},
): JsonTreeBuild {
  const rootKind = kindOf(value)
  const root: TreeNode = {
    id: '$',
    key: null,
    kind: rootKind,
    value: isContainer(rootKind) ? undefined : value,
    children: [],
    depth: 0,
    size: isContainer(rootKind) ? entriesOf(value, rootKind).length : null,
    elided: null,
    raw: value,
  }

  let nodes = 1
  let capped: 'depth' | 'nodes' | null = null
  let deepest = 0

  // Explicit stack — see the header. Breadth is irrelevant to correctness here; depth is
  // the thing that must never become a call frame.
  const stack: TreeNode[] = isContainer(rootKind) ? [root] : []
  while (stack.length) {
    const parent = stack.pop()!
    if (parent.depth >= maxDepth) {
      parent.elided = 'depth'
      capped ??= 'depth'
      continue
    }
    const entries = entriesOf(parent.raw, parent.kind)
    for (const [key, child] of entries) {
      if (nodes >= maxNodes) {
        parent.elided = 'nodes'
        capped ??= 'nodes'
        break
      }
      const kind = kindOf(child)
      const node: TreeNode = {
        // The path is the id. `JSON.stringify` on the key keeps ids unique for keys that
        // contain the separator, which a result value is entirely free to do.
        id: `${parent.id}.${JSON.stringify(key)}`,
        key,
        kind,
        value: isContainer(kind) ? undefined : child,
        children: [],
        depth: parent.depth + 1,
        size: isContainer(kind) ? entriesOf(child, kind).length : null,
        elided: null,
        raw: child,
      }
      nodes++
      if (node.depth > deepest) deepest = node.depth
      parent.children.push(node)
      if (isContainer(kind) && node.size! > 0) stack.push(node)
    }
  }

  return { root, nodes, capped, depth: deepest }
}

/**
 * The ids a tree opens with. §2.6 says "collapsible", not "collapsed": a result the
 * operator navigated to in order to READ should not make them click before it says
 * anything. Two levels is the compromise the transcript's tool cards already use — enough
 * to see the shape, bounded enough that a wide object does not become a wall.
 */
export function defaultExpanded(build: JsonTreeBuild, levels = 2): Set<string> {
  const open = new Set<string>()
  const stack: TreeNode[] = [build.root]
  while (stack.length) {
    const node = stack.pop()!
    if (node.depth >= levels || !node.children.length) continue
    open.add(node.id)
    for (const child of node.children) stack.push(child)
  }
  return open
}

/** Rows in document order for the currently-expanded set — what the renderer maps over. */
export function visibleRows(build: JsonTreeBuild, expanded: ReadonlySet<string>): TreeNode[] {
  const out: TreeNode[] = []
  const stack: TreeNode[] = [build.root]
  while (stack.length) {
    const node = stack.pop()!
    out.push(node)
    if (!expanded.has(node.id)) continue
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!)
  }
  return out
}

/**
 * What copy-subtree puts on the clipboard: the node's own value, serialized.
 *
 * `JSON.stringify` recurses, so a value deep enough to have tripped the depth cap can throw
 * `RangeError: Maximum call stack size exceeded` here. That is exactly the case §2.6 hands
 * to the raw download, so this returns `null` rather than throwing and the caller says so.
 */
export function serializeSubtree(value: unknown): string | null {
  try {
    const text = JSON.stringify(value, null, 2)
    return text === undefined ? 'undefined' : text
  } catch {
    return null
  }
}

/** The one-line preview a collapsed container shows: `{ 4 keys }` / `[ 12 items ]`. */
export function summarize(node: TreeNode): string {
  if (node.kind === 'array') return node.size === 1 ? '1 item' : `${node.size} items`
  if (node.kind === 'object') return node.size === 1 ? '1 key' : `${node.size} keys`
  return ''
}
