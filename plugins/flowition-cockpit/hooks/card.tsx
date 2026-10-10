// A clickable card face: a `Client` region the whole of which presses. A Button presses
// only on its label, so cards draw their title and subtitle here instead, and a click
// anywhere on them posts `{ press: true }`: the hooks module runs the handler it
// registered under this Client's key, as for a button face.
import type { ClientModule } from 'claude-code'

export type CardProps = {
  title: string
  subtitle: string
  /** More lines under the subtitle (an agent's stats, its error), inside the click. */
  lines: { text: string; isError: boolean }[]
}

type CardState = { isHover: boolean; isCancelled: boolean; isPressed: boolean }

const Card: ClientModule<CardProps, CardState> = (props, surface) => {
  const { Box, Text } = surface.elements
  const state = surface.state ?? { isHover: false, isCancelled: false, isPressed: false }
  // A press is the button's release inside the region, unless the pointer left it since
  // the press (dragged away: cancelled, as a click is). Nothing waits on a redraw after
  // the `down` (a trackpad tap delivers down and up in one frame): the flag is set on
  // the state object the running listener holds, and stored for the next.
  // Off the face, for a captured move or release: the desktop draws a face's border and
  // padding around the cells it counts (`columns` x `rows`: a chip is one row), so the
  // face a person sees reaches a cell past them on every side, and only past that has
  // the pointer left it (unknown sizes, 0 before the first layout, bound nothing).
  const isOutside = (x: number, y: number) =>
    x < -1 || y < -1 || (surface.columns > 0 && x > surface.columns) || (surface.rows > 0 && y > surface.rows)
  surface.onPointer((e) => {
    if (e.type === 'enter') surface.setState({ ...state, isHover: true, isCancelled: false })
    else if (e.type === 'leave') surface.setState({ ...state, isHover: false, isCancelled: true })
    else if (e.type === 'down' && e.button === 'left') {
      // Delivered with nothing captured, a down is on the face, whatever cell it reads.
      state.isPressed = true
      state.isCancelled = false
      surface.setState({ isHover: true, isCancelled: false, isPressed: true })
    } else if (e.type === 'move' && e.button !== undefined && isOutside(e.x, e.y)) {
      // Captured after a down, moves arrive from outside too, with or without a leave.
      state.isCancelled = true
      surface.setState({ ...state, isHover: false, isCancelled: true })
    } else if (e.type === 'up' && e.button === 'left') {
      // Only a release that ends this face's own press, inside it, presses; and only
      // once (the press is consumed), whatever up arrives after.
      const isPress = state.isPressed && !state.isCancelled && !isOutside(e.x, e.y)
      state.isPressed = false
      surface.setState({ ...state, isPressed: false })
      if (isPress) surface.post({ press: true })
    }
  })
  surface.onKey((e) => {
    if (e.key === 'return' || e.key === ' ') surface.post({ press: true })
  })
  return (
    <Box flexDirection="column">
      <Text bold underline={state.isHover} wrap="truncate-end">
        {props.title}
      </Text>
      <Text dimColor wrap="truncate-end">
        {props.subtitle}
      </Text>
      {props.lines.map((line) =>
        line.isError ? (
          <Text color="error" wrap="wrap">
            {line.text}
          </Text>
        ) : (
          <Text dimColor wrap="truncate-end">
            {line.text}
          </Text>
        ),
      )}
    </Box>
  )
}

export default Card
