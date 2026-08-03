// §2.6's JSON-tree caps, as a pure unit. Node env — no DOM here.
import { describe, expect, it } from 'vitest'

import {
  JSON_TREE_MAX_DEPTH,
  JSON_TREE_MAX_NODES,
  buildJsonTree,
  defaultExpanded,
  kindOf,
  serializeSubtree,
  summarize,
  visibleRows,
} from './tree.js'

/** A left spine `{a:{a:{a:…}}}` of the requested depth. */
function deep(depth: number): unknown {
  let value: unknown = 'bottom'
  for (let i = 0; i < depth; i++) value = { a: value }
  return value
}

describe('§2.6 JSON tree projection', () => {
  it('classifies every JSON kind, arrays before objects', () => {
    expect(kindOf(null)).toBe('null')
    expect(kindOf([])).toBe('array')
    expect(kindOf({})).toBe('object')
    expect(kindOf('x')).toBe('string')
    expect(kindOf(1)).toBe('number')
    expect(kindOf(false)).toBe('boolean')
  })

  it('projects a nested value with keys, sizes and per-node raw values', () => {
    const value = { ok: true, files: ['a', 'b'], counts: { agents: 2 } }
    const build = buildJsonTree(value)
    expect(build.capped).toBeNull()
    expect(build.root.size).toBe(3)
    const files = build.root.children.find((n) => n.key === 'files')!
    expect(files.kind).toBe('array')
    expect(files.size).toBe(2)
    expect(files.children.map((n) => n.key)).toEqual(['0', '1'])
    expect(files.children[0]!.value).toBe('a')
    // copy-subtree copies the TRUTH, not the projection.
    expect(files.raw).toEqual(['a', 'b'])
  })

  it('caps at depth 32 exactly, marks the container it cut, and reports the cap', () => {
    const build = buildJsonTree(deep(40))
    expect(build.capped).toBe('depth')
    expect(build.depth).toBe(JSON_TREE_MAX_DEPTH)
    // Walk to the deepest node and assert IT is the one flagged.
    let node = build.root
    while (node.children.length) node = node.children[0]!
    expect(node.depth).toBe(JSON_TREE_MAX_DEPTH)
    expect(node.elided).toBe('depth')
    // …and that its own value is intact, so copy-subtree and the raw download still work.
    expect(serializeSubtree(node.raw)).toContain('bottom')
  })

  it('does not cap a value that sits exactly at the depth limit', () => {
    const build = buildJsonTree(deep(JSON_TREE_MAX_DEPTH))
    expect(build.capped).toBeNull()
    expect(build.depth).toBe(JSON_TREE_MAX_DEPTH)
  })

  it('caps at 20,000 nodes and marks the container that lost children', () => {
    const wide = { items: Array.from({ length: 30_000 }, (_, i) => i) }
    const build = buildJsonTree(wide)
    expect(build.capped).toBe('nodes')
    expect(build.nodes).toBe(JSON_TREE_MAX_NODES)
    const items = build.root.children[0]!
    expect(items.elided).toBe('nodes')
    // The container still reports its REAL size, so the screen can say what it did not draw.
    expect(items.size).toBe(30_000)
    expect(items.children.length).toBeLessThan(30_000)
  })

  it('survives a value far deeper than any call stack would tolerate', () => {
    // 200,000 levels. A recursive walker dies here; the explicit stack does not.
    expect(() => buildJsonTree(deep(200_000))).not.toThrow()
    const build = buildJsonTree(deep(200_000))
    expect(build.capped).toBe('depth')
    expect(build.depth).toBe(JSON_TREE_MAX_DEPTH)
  })

  it('gives every node a distinct id even when keys contain the path separator', () => {
    const build = buildJsonTree({ 'a.b': 1, a: { b: 2 } })
    const ids = new Set<string>()
    for (const row of visibleRows(build, defaultExpanded(build, 32))) ids.add(row.id)
    expect(ids.size).toBe(4) // root + "a.b" + a + a.b
  })

  it('opens two levels by default and lists exactly the visible rows', () => {
    const build = buildJsonTree({ a: { b: { c: { d: 1 } } } })
    const open = defaultExpanded(build)
    const rows = visibleRows(build, open)
    // root, a, b — c is at depth 3 and its parent b is closed.
    expect(rows.map((r) => r.key)).toEqual([null, 'a', 'b'])
  })

  it('linearizes rows in document order once everything is open', () => {
    const build = buildJsonTree({ a: [1, 2], b: 'x' })
    const rows = visibleRows(build, defaultExpanded(build, 32))
    expect(rows.map((r) => r.key)).toEqual([null, 'a', '0', '1', 'b'])
  })

  it('serializeSubtree returns null rather than throwing on a stack-busting value', () => {
    expect(serializeSubtree(deep(200_000))).toBeNull()
    expect(serializeSubtree({ a: 1 })).toBe('{\n  "a": 1\n}')
  })

  it('summarizes containers in singular and plural', () => {
    const one = buildJsonTree({ a: [1], b: { k: 1 } })
    expect(summarize(one.root.children[0]!)).toBe('1 item')
    expect(summarize(one.root.children[1]!)).toBe('1 key')
    const many = buildJsonTree({ a: [1, 2], b: {} })
    expect(summarize(many.root.children[0]!)).toBe('2 items')
    expect(summarize(many.root.children[1]!)).toBe('0 keys')
  })

  it('treats a scalar result as a complete one-node tree', () => {
    const build = buildJsonTree('hello')
    expect(build.nodes).toBe(1)
    expect(build.capped).toBeNull()
    expect(build.root.kind).toBe('string')
    expect(build.root.value).toBe('hello')
  })
})
