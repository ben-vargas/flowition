import { useRef, type ComponentPropsWithoutRef } from 'react'

import { useScrollClip } from './useScrollClip.js'

type Surface = 'canvas' | 'surface' | 'well'

function clipClass(className: string | undefined, top: boolean, bottom: boolean, surface: Surface) {
  return [
    className,
    top ? 'fade-t' : '',
    bottom ? 'fade-b' : '',
    surface === 'surface' ? 'on-surface' : surface === 'well' ? 'on-well' : '',
  ].filter(Boolean).join(' ')
}

export function ScrollFadePre(
  { className, surface = 'canvas', ...props }: ComponentPropsWithoutRef<'pre'> & { surface?: Surface },
) {
  const ref = useRef<HTMLPreElement>(null)
  const clip = useScrollClip(ref)
  return <pre {...props} ref={ref} className={clipClass(className, clip.top, clip.bottom, surface)} />
}

export function ScrollFadeDiv(
  { className, surface = 'canvas', ...props }: ComponentPropsWithoutRef<'div'> & { surface?: Surface },
) {
  const ref = useRef<HTMLDivElement>(null)
  const clip = useScrollClip(ref)
  return <div {...props} ref={ref} className={clipClass(className, clip.top, clip.bottom, surface)} />
}
