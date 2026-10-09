// A button face for the desktop: a `Client` region that presses on the first click.
// The desktop's native plugin Button takes a first click as focus alone when it does
// not already hold the ring (a second click presses), so the pane's controls draw
// this instead there, and a click posts `{ press: true }` to the hooks module, which
// runs the handler registered under this Client's key.
import type { ClientModule } from 'claude-code'

export type ButtonFaceProps = {
  label: string
  /** primary: filled; secondary: outlined; danger: outlined in red; plain: text alone. */
  variant: 'primary' | 'secondary' | 'danger' | 'plain'
}

type ButtonFaceState = { isHover: boolean; isCancelled: boolean }

const ButtonFace: ClientModule<ButtonFaceProps, ButtonFaceState> = (props, surface) => {
  const { Box, Text } = surface.elements
  const state = surface.state ?? { isHover: false, isCancelled: false }
  // A press is the button's release inside the region, unless the pointer left it since
  // the press (dragged away: cancelled, as a click is). Nothing waits on a redraw after
  // the `down` (a trackpad tap delivers down and up in one frame): the flag is set on
  // the state object the running listener holds, and stored for the next.
  // Outside the region, as ClientPointerEvent defines it: a negative cell, or one at or
  // past the region's laid-out size (unknown, 0, before the first layout).
  const isOutside = (x: number, y: number) =>
    x < 0 || y < 0 || (surface.columns > 0 && x >= surface.columns) || (surface.rows > 0 && y >= surface.rows)
  surface.onPointer((e) => {
    if (e.type === 'enter') surface.setState({ isHover: true, isCancelled: false })
    else if (e.type === 'leave') surface.setState({ isHover: false, isCancelled: true })
    else if (e.type === 'down') {
      state.isCancelled = false
      surface.setState({ isHover: true, isCancelled: false })
    } else if (e.type === 'move' && e.button !== undefined && isOutside(e.x, e.y)) {
      // Captured after a down, moves arrive from outside too, with or without a leave.
      state.isCancelled = true
      surface.setState({ isHover: false, isCancelled: true })
    } else if (e.type === 'up' && e.button !== 'right' && e.button !== 'middle' && !state.isCancelled && !isOutside(e.x, e.y)) {
      surface.post({ press: true })
    }
  })
  surface.onKey((e) => {
    if (e.key === 'return' || e.key === ' ') surface.post({ press: true })
  })

  if (props.variant === 'plain') {
    return (
      <Text underline={state.isHover} wrap="truncate-end">
        {props.label}
      </Text>
    )
  }
  if (props.variant === 'primary') {
    return (
      <Box borderStyle="round" borderColor="text" backgroundColor="text" paddingX={1}>
        <Text bold color="inverseText" underline={state.isHover}>
          {props.label}
        </Text>
      </Box>
    )
  }
  const tone = props.variant === 'danger' ? { color: 'error' as const } : {}
  return (
    <Box borderStyle="round" {...(state.isHover ? { borderColor: props.variant === 'danger' ? ('error' as const) : ('suggestion' as const) } : { borderDimColor: true })} paddingX={1}>
      <Text {...tone}>{props.label}</Text>
    </Box>
  )
}

export default ButtonFace
