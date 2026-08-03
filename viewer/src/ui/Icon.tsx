// §3.5. Every glyph is `aria-hidden`; the interactive parent carries the label, or an
// adjacent visually-hidden span does (see StatusGlyph).

import { GLYPH_PATHS, GLYPH_NAMES, type GlyphName, type GlyphPart } from './icons.js'

/** Renders the 43-symbol sprite once, at the app root. Same-document ids only. */
export function IconSprite() {
  return (
    <svg width={0} height={0} className="icon-sprite" aria-hidden="true" focusable="false">
      {GLYPH_NAMES.map((name) => (
        <symbol key={name} id={`i-${name}`} viewBox="0 0 16 16">
          {(GLYPH_PATHS[name] as GlyphPart[]).map(part)}
        </symbol>
      ))}
    </svg>
  )
}

function part(el: GlyphPart, i: number) {
  if (el.t === 'path') return <path key={i} d={el.d} opacity={el.opacity} />
  if (el.t === 'rect') {
    return <rect key={i} x={el.x} y={el.y} width={el.w} height={el.h} rx={el.rx} />
  }
  return (
    <circle
      key={i} cx={el.cx} cy={el.cy} r={el.r}
      strokeDasharray={el.dash} opacity={el.opacity}
    />
  )
}

export interface IconProps {
  name: GlyphName
  /** 12 / 14 / 20 pick the stroke-compensated size classes; default is the 16px grid. */
  size?: 12 | 14 | 16 | 20
  className?: string
  spin?: boolean
}

export function Icon({ name, size, className, spin }: IconProps) {
  const cls = ['ic']
  if (size && size !== 16) cls.push(`ic-${size}`)
  if (spin) cls.push('ic-spin')
  if (className) cls.push(className)
  return (
    <svg className={cls.join(' ')} aria-hidden="true" focusable="false">
      <use href={`#i-${name}`} />
    </svg>
  )
}
