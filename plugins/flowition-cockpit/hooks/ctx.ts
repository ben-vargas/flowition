// What a view module draws with: the surface's elements, and the pane's own controls
// (button and card faces that press on the first click on the desktop, native
// elements elsewhere), built once per render in register.tsx.
import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { ButtonFaceProps } from './button'
import type { CardProps } from './card'

type Table = Elements[RenderSurface]

export type Ctx = {
  Box: Table['Box']
  Text: Table['Text']
  Markdown: Table['Markdown']
  Code: Table['Code']
  /** Where the surface draws SVG (not the terminal). */
  Svg: Elements['desktop']['Svg'] | null
  /** Where the surface takes typing (not the mobile app). */
  Input: Elements['desktop']['Input'] | null
  btn: (key: string, label: string, onPress: () => unknown, variant?: ButtonFaceProps['variant'], fill?: boolean) => RenderElement
  face: (key: string, props: CardProps, onPress: () => unknown, fallback: () => RenderElement) => RenderElement
  badge: (state: string) => RenderElement
  now: number
}
