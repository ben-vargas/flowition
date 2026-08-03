/**
 * §2.6's collapsible JSON tree with copy-subtree.
 *
 * The projection and its caps live in `tree.ts` (pure, tested there); this file is the
 * rendering, and it has exactly two rules of its own:
 *
 *  • **Rows are flat.** `visibleRows` linearizes the expanded tree, so the DOM is a list of
 *    siblings with an indent, not 32 levels of nested `<div>`. Nesting would put the depth
 *    cap back into the layout/paint path it was written to keep it out of, and it would make
 *    the tree a 32-deep grouping for a screen reader reading a value.
 *  • **Text is text.** Every scalar goes through React as a text child (never
 *    `dangerouslySetInnerHTML`, which `src/ui/no-innerhtml.test.ts` enforces repo-wide), so
 *    a result value containing markup is a string that says `<script>`, not a script.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Icon } from '../../ui/Icon.js'
import {
  type JsonTreeBuild,
  type TreeNode,
  buildJsonTree,
  defaultExpanded,
  isContainer,
  serializeSubtree,
  summarize,
  visibleRows,
} from './tree.js'

export function JsonTree(
  { value, onCopyFailed }: { value: unknown; onCopyFailed?: (reason: string) => void },
) {
  const build = useMemo<JsonTreeBuild>(() => buildJsonTree(value), [value])
  const [expanded, setExpanded] = useState<Set<string>>(() => defaultExpanded(build))
  // A new value is a new tree; the previous value's open set means nothing against it.
  //
  // DURING RENDER, not in an effect. As an effect this was a real bug and the DOM test
  // caught it: React had not flushed the mount effect by the time the operator's first
  // collapse landed, so the deferred effect ran AFTER the toggle and reset the tree to its
  // default open set — the row visibly refused to collapse. Comparing the build identity in
  // render is React's own documented way to derive state from props, and it has no ordering
  // to lose (the same shape `RunHeader`'s armed-confirmation reset uses).
  const builtFrom = useRef(build)
  if (builtFrom.current !== build) {
    builtFrom.current = build
    setExpanded(defaultExpanded(build))
  }

  const toggle = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  const rows = useMemo(() => visibleRows(build, expanded), [build, expanded])

  return (
    <div className="jt" role="tree" aria-label="Result value">
      {rows.map((node) => (
        <JsonRow
          key={node.id}
          node={node}
          expanded={expanded.has(node.id)}
          onToggle={toggle}
          {...(onCopyFailed ? { onCopyFailed } : {})}
        />
      ))}
    </div>
  )
}

function JsonRow(
  { node, expanded, onToggle, onCopyFailed }: {
    node: TreeNode
    expanded: boolean
    onToggle: (id: string) => void
    onCopyFailed?: (reason: string) => void
  },
) {
  const container = isContainer(node.kind)
  const openable = container && node.children.length > 0
  const label = node.key ?? 'result'
  return (
    <div
      className="jt-row"
      role="treeitem"
      aria-level={node.depth + 1}
      {...(openable ? { 'aria-expanded': expanded } : {})}
      style={{ paddingLeft: `${node.depth * 14}px` }}
    >
      {openable ? (
        <button
          type="button" className="jt-twist"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
          onClick={() => onToggle(node.id)}
        >
          <Icon name={expanded ? 'chevdown' : 'chevron'} size={12} />
        </button>
      ) : <span className="jt-twist spacer" aria-hidden="true" />}

      <span className="jt-key">{node.key ?? <em>result</em>}</span>
      {container
        ? (
          <span className="jt-sum">
            {node.kind === 'array' ? '[ ' : '{ '}{summarize(node)}{node.kind === 'array' ? ' ]' : ' }'}
          </span>
        )
        : <JsonScalar kind={node.kind} value={node.value} />}

      {node.elided ? (
        <span className="badge warn" title={
          node.elided === 'depth'
            ? '§2.6 caps the tree at depth 32 — download the raw file to read below this'
            : '§2.6 caps the tree at 20,000 nodes — download the raw file to read the rest'
        }>
          {node.elided === 'depth' ? 'depth cap' : 'node cap'}
        </span>
      ) : null}

      <CopySubtree node={node} {...(onCopyFailed ? { onCopyFailed } : {})} />
    </div>
  )
}

function JsonScalar({ kind, value }: { kind: string; value: unknown }) {
  if (kind === 'string') return <span className="jt-v s">&ldquo;{String(value)}&rdquo;</span>
  if (kind === 'null') return <span className="jt-v n">null</span>
  return <span className={`jt-v ${kind === 'number' ? 'num' : 'b'}`}>{String(value)}</span>
}

/**
 * §2.6's "copy-subtree". Copies the node's OWN value serialized, not the projection, so a
 * subtree the tree elided still copies whole — and when it is too deep for
 * `JSON.stringify` itself, the button says so rather than silently copying nothing.
 */
function CopySubtree(
  { node, onCopyFailed }: { node: TreeNode; onCopyFailed?: (reason: string) => void },
) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = useCallback(() => {
    const text = serializeSubtree(node.raw)
    if (text == null) {
      onCopyFailed?.('this subtree is too deeply nested to serialize — download the raw result')
      return
    }
    void navigator?.clipboard?.writeText?.(text)
      .then(() => setCopied(true))
      // A denied clipboard is not an error the operator must act on; the value is on screen.
      .catch(() => setCopied(false))
  }, [node.raw, onCopyFailed])
  return (
    <button
      type="button" className="jt-copy icb sm"
      aria-label={`Copy ${node.key ?? 'result'} subtree`}
      onClick={copy}
    >
      <Icon name={copied ? 'check' : 'copy'} size={12} />
    </button>
  )
}
