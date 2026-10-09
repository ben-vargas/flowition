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

type CardState = { isHover: boolean; isCancelled: boolean }

const Card: ClientModule<CardProps, CardState> = (props, surface) => {
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
