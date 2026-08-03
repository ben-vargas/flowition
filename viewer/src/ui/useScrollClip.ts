import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react'

export interface ScrollClip {
  top: boolean
  bottom: boolean
}

export function readScrollClip(element: HTMLElement): ScrollClip {
  return {
    top: element.scrollTop > 1,
    bottom: element.scrollHeight - element.scrollTop - element.clientHeight > 4,
  }
}

/**
 * Metric-driven scroll affordances for #107. ResizeObserver handles viewport/content
 * sizing; the layout pass catches React commits even where a test/browser has no observer.
 */
export function useScrollClip<T extends HTMLElement>(ref: RefObject<T | null>): ScrollClip {
  const [clip, setClip] = useState<ScrollClip>({ top: false, bottom: false })
  const update = useCallback(() => {
    const element = ref.current
    if (!element) return
    const next = readScrollClip(element)
    setClip((current) => current.top === next.top && current.bottom === next.bottom ? current : next)
  }, [ref])

  useLayoutEffect(update)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(element)
    for (const child of element.children) observer?.observe(child)
    update()
    return () => {
      element.removeEventListener('scroll', update)
      observer?.disconnect()
    }
  }, [ref, update])

  return clip
}
