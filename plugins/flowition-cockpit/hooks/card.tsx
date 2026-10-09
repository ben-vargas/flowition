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
  // A press is the button's release, unless the pointer left the region since it last
  // came in (dragged away: cancelled, as a click is). Nothing waits on a redraw after
  // the `down`, and no cell position is trusted: a trackpad tap delivers down and up
  // in one frame, and on the desktop an edge of a bordered face can map outside it.
  surface.onPointer((e) => {
    if (e.type === 'enter') surface.setState({ isHover: true, isCancelled: false })
    else if (e.type === 'leave') surface.setState({ isHover: false, isCancelled: true })
    else if (e.type === 'up' && e.button !== 'right' && e.button !== 'middle' && !state.isCancelled) surface.post({ press: true })
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
