import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Diagram, Picture } from '../types'

const MAX_DIAGRAMS = 50
const PANE = 'diagram'

// How the mod colors itself, picked in /config (`palette`). `terminal` paints no
// colors of its own: text, borders and backgrounds follow each person's terminal,
// whatever its theme. The presets paint a full palette whatever Claude Code's theme is.
type Ink = { color?: string; dimColor?: boolean }
type Palette = {
  text: Ink
  muted: Ink
  accent: Ink
  rule: { borderColor?: string; borderDimColor?: boolean }
  highlight: { borderColor?: string; borderDimColor?: boolean }
  background?: string
  surface?: string
}

const PALETTES: Record<string, Palette> = {
  terminal: {
    text: {},
    muted: { dimColor: true },
    accent: { color: 'claude' },
    rule: { borderDimColor: true },
    highlight: { borderColor: 'claude' },
  },
  // Braver's Solarized Light: base2 for the card, a step darker than the base3 cream of the chat.
  'solarized-light': {
    text: { color: '#073642' },
    muted: { color: '#586e75' },
    accent: { color: '#cb4b16' },
    rule: { borderColor: '#93a1a1' },
    highlight: { borderColor: '#cb4b16' },
    background: '#eee8d5',
    surface: '#e3dbc6',
  },
  'solarized-dark': {
    text: { color: '#93a1a1' },
    muted: { color: '#839496' },
    accent: { color: '#cb4b16' },
    rule: { borderColor: '#586e75' },
    highlight: { borderColor: '#cb4b16' },
    background: '#073642',
    surface: '#0d3f4c',
  },
}

// The title types itself back in this many characters per frame once a turn ends.
const REVEAL_STEP = 3
const REVEAL_FRAME_MS = 25

const list = atom({ plugin: 'diagrams', key: 'list' } as const, [])
const index = atom({ plugin: 'diagrams', key: 'index' } as const, 0)
const isOpen = atom({ plugin: 'diagrams', key: 'isOpen' } as const, false)
// How much of the chip's title shows; -1 is all of it.
const reveal = atom({ plugin: 'diagrams', key: 'reveal' } as const, -1)
// How many columns the full-screen view is panned right, for a diagram wider than the pane.
const pan = atom({ plugin: 'diagrams', key: 'pan' } as const, 0)
// Which multiplexer full screen zoomed ('herdr', 'tmux' or ''), so close undoes only its own zoom.
const zoomedBy = atom({ plugin: 'diagrams', key: 'zoomedBy' } as const, '')
const isFull = atom({ plugin: 'diagrams', key: 'isFull' } as const, false)
// Show the text version even where a picture is rendered.
const isText = atom({ plugin: 'diagrams', key: 'isText' } as const, false)
// The frame of the working chip's pulse.
const pulse = atom({ plugin: 'diagrams', key: 'pulse' } as const, 0)
const PULSE = ['◇', '◈', '◆', '◈']
const PULSE_FRAME_MS = 300

// The Mermaid renderer when `mmdc` isn't installed: pinned, fetched once into npx's cache.
const MERMAID_CLI = '@mermaid-js/mermaid-cli@11.17.0'
// The first render downloads the renderer and a headless Chrome.
const RENDER_TIMEOUT_MS = 300_000
// A terminal cell's width over its height (16x30 px in kitty, 8x17 in most), for
// sizing a picture in cells with its shape kept.
const CELL_ASPECT = 0.53
// Pictures render at 2x, so on a Retina screen with 16 px cells this many image
// pixels make one column at actual size; a picture is never stretched past it.
const PIXELS_PER_COLUMN = 16
// What full screen asks the dock for: more than any terminal has, so it gets the most it can.
const FULL_COLUMNS = 1000

const STYLE = `The user's diagrams mod pins every diagram you write to a small chip on the right above the prompt, which they expand to see it large, with a history.
- Put each diagram in its own fenced code block (\`\`\`text), drawn with Unicode box-drawing characters (┌ ─ ┐ │ └ ┘ ├ ┤ ┬ ┴ ┼) and arrows (──▶ ◀── ▲ ▼).
- Write a short title naming what it shows, in bold on its own line just before the block, e.g. "**Slack request flow**". The chip shows it.
- Keep each diagram at most 100 columns wide and about 25 lines tall; split a big picture into several blocks, each with its own title.`

const MERMAID_STYLE = `- Right after each diagram's block, write the same diagram as a \`\`\`mermaid block (flowchart, sequenceDiagram, stateDiagram-v2 or erDiagram, whichever fits); the mod renders it as a picture. Quote flowchart node labels (A["..."]) and edge labels (-->|"..."|); in sequence, state and ER diagrams write labels bare, since quotes there show literally. Keep it as simple as the text version.`

// Box-drawing and arrow characters; a fenced block with enough of them is a diagram.
const DRAWING = /[┌┐└┘├┤┬┴┼─│═║╔╗╚╝╭╮╯╰▶◀▲▼►◄→←↑↓]/g
const MIN_DRAWING_CHARS = 12
const FENCE = /(^|\n)```([^\n]*)\n([\s\S]*?)\n```/g

type Part = { kind: 'text'; text: string } | { kind: 'diagram'; diagram: Diagram }

export const register: Register = (on, options) => {
  const S = PALETTES[String(options.palette)] ?? PALETTES.terminal!
  // Full screen can wear its own palette, the card keeping the terminal's colors.
  const fullS = PALETTES[String(options.fullScreenPalette)] ?? S
  const isPictures = options.pictures === 'on'
  const theme = String(options.palette).endsWith('dark') ? 'dark' : 'neutral'
  let revealing: Timer | undefined
  let pulsing: Timer | undefined

  on('session.start', async ($, e, next) => {
    // A reload drops the timers, so a title stuck half typed shows whole.
    await update($, reveal, () => -1)
    await $.command.register({
      name: 'diagrams',
      description: 'Expand or collapse the diagram card above the prompt',
    })

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return {
      sections: [...composed.sections, { id: 'diagrams:style', text: isPictures ? `${STYLE}\n${MERMAID_STYLE}` : STYLE, scope: 'session' }],
    }
  })

  // While a turn runs the chip's symbol pulses, so it reads as working.
  on('turn.start', async ($, e, next) => {
    pulsing?.cancel()
    pulsing = $.clock.every(PULSE_FRAME_MS, () => void update($, pulse, n => (n + 1) % PULSE.length))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId) {
      return done
    }

    pulsing?.cancel()

    if (!e.isAborted) {
      for (const diagram of diagramsIn(e.answer)) {
        await pin($, diagram)
      }

      // Rendering takes seconds (minutes the first time): outside this dispatch.
      if (isPictures) {
        $.clock.after(0, () => void renderPictures($, S.background ?? 'transparent', theme))
      }
    }

    // The chip sat as a bare symbol while the turn ran; type its title back in.
    revealing?.cancel()
    await update($, reveal, () => 0)
    revealing = $.clock.every(REVEAL_FRAME_MS, async () => {
      const title = (await current($))?.title ?? ''
      const shown = await update($, reveal, n => (n < 0 || n + REVEAL_STEP >= title.length ? -1 : n + REVEAL_STEP))

      if (shown < 0) {
        revealing?.cancel()
      }
    })

    return done
  })

  // An earlier version registered this tool, and a registration outlives the code
  // that made it (there is no unregister), so calls to it still arrive: pin the diagram.
  on('tool.call', { tool: 'mcp__diagrams__show_diagram' }, async ($, e) => {
    const args = e as unknown as { title?: unknown; diagram?: unknown }
    const source = typeof args.diagram === 'string' ? args.diagram.replace(/\s+$/, '') : ''

    if (!isDiagram(source)) {
      return { deny: 'That is not a diagram. Write diagrams in a fenced ```text block in your reply instead.' }
    }

    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : 'Diagram'
    await pin($, { title, source })

    return { result: `Diagram "${title}" is pinned to the chip above the prompt. Next time, write diagrams in a fenced \`\`\`text block in your reply; the mod pins those too.` }
  })

  // Esc and the corner mark close full screen without our own close call.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await update($, isFull, () => false)
    await unzoom($)

    return closed
  })

  on('command.run', { command: 'diagrams' }, async $ => {
    if ((await read($, list)).length === 0) {
      return { text: 'No diagrams yet in this session.' }
    }

    const expanded = await update($, isOpen, open => !open)

    return { text: expanded ? 'Diagram expanded above the prompt.' : 'Diagram collapsed.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const all = await read($, list)
    const at = clamp(await read($, index), all.length)
    const diagram = all[at]

    if (!diagram || e.props.hasSurvey) {
      return next(e)
    }

    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // Pictures draw only where the surface has Image (the terminal); elsewhere the text.
    const Image = 'Image' in elements ? elements.Image : undefined
    const step = (by: number) => () => update($, index, i => clamp(i + by, all.length))
    const showsPicture = isPictures && !!Image && !!diagram.picture && !(await read($, isText))
    const toggle: Action[] = isPictures && diagram.picture
      ? [{ key: 'view', label: showsPicture ? '⌗ text' : '▦ picture', onPress: () => update($, isText, text => !text) }]
      : []
    const expand = () => update($, isOpen, () => true)
    const collapse = () => update($, isOpen, () => false)
    const fullScreen = async () => {
      await collapse()
      await openPane($)
    }
    const navigation = all.length > 1 && (
      <Box gap={1} flexShrink={0}>
        {/* Words beside the arrows: a one-cell arrow is too small to hit. */}
        <Button key="prev" label="‹ prev" plain onPress={step(-1)} />
        <Text {...S.muted}>
          {at + 1}/{all.length}
        </Text>
        <Button key="next" label="next ›" plain onPress={step(1)} />
      </Box>
    )

    // While Claude works the chip is a bare symbol, out of the way, that still expands.
    if (e.props.isWorking && !(await read($, isOpen))) {
      return (
        <Box justifyContent="flex-end">
          <Box borderStyle="round" {...S.rule} paddingX={1} gap={1}>
            <Button key="open-symbol" label={PULSE[(await read($, pulse)) % PULSE.length]!} plain onPress={expand} />
            {all.length > 1 && <Text {...S.muted}>{all.length}</Text>}
            <Button key="open" label="⤢" plain onPress={expand} />
          </Box>
        </Box>
      )
    }

    if (await read($, isOpen)) {
      return <Box justifyContent="flex-end">{expandedCard()}</Box>
    }

    // Full screen is open: the chip says so and closes it.
    if (await read($, isFull)) {
      return (
        <Box justifyContent="flex-end">
          <Box borderStyle="round" {...S.highlight} paddingX={1} gap={1}>
            <Text {...S.accent}>⛶</Text>
            <Text bold {...S.text} wrap="truncate-end">
              {diagram.title}
            </Text>
            <Text {...S.muted}>in full screen</Text>
            <Button key="close-full" label="close" onPress={() => closePane($)} />
          </Box>
        </Box>
      )
    }

    const shown = await read($, reveal)
    const title = shown < 0 ? diagram.title : diagram.title.slice(0, shown)

    return (
      <Box justifyContent="flex-end">
        <Box borderStyle="round" {...S.rule} paddingX={1} gap={1}>
          <Text {...S.accent}>◆</Text>
          {/* The whole title expands too, not only the small button at the end. */}
          <Button key="open-title" label={title || ' '} plain onPress={expand} />
          {shown < 0 && navigation}
          <Button key="open" label="expand" variant="primary" onPress={expand} />
        </Box>
      </Box>
    )

    // The chip grown into a card in place. Painting it over the chat (an absolute
    // Box above the band) left the chat garbled in a fullscreen terminal, so it takes
    // its rows; a diagram taller than the band's room is cut, with full screen offered.
    function expandedCard() {
      const lines = diagram!.source.split('\n')
      // One width for every diagram in the history, so switching doesn't move the controls.
      const widest = Math.max(...all.flatMap(one => one.source.split('\n').map(line => [...line].length)), 56)
      // Wide enough for every diagram's text and, with pictures on, its picture at actual size.
      const pictured = isPictures ? Math.max(0, ...all.map(one => (one.picture ? Math.ceil(one.picture.width / PIXELS_PER_COLUMN) : 0))) : 0
      const width = Math.min(e.props.bodyColumns, Math.max(widest, pictured) + 4)
      // The band's rows less the card's own: two border rows, the title bar, the footer
      // and the "more lines" note; more than that and the band scrolls, cutting off the top.
      const room = Math.max(4, e.props.maxRows - 5)
      const hidden = Math.max(0, lines.length - room)

      return (
        <Box flexDirection="column" width={width} borderStyle="round" {...S.highlight} backgroundColor={S.background}>
          <Box gap={1} paddingX={1} backgroundColor={S.surface}>
            <Text {...S.accent} backgroundColor={S.surface}>
              ◉
            </Text>
            <Text bold {...S.text} backgroundColor={S.surface} wrap="truncate-end">
              {diagram!.title}
            </Text>
          </Box>
          {showsPicture ? (
            pictureBox(S, Box, Image!, diagram!, width - 4, room)
          ) : (
            diagramLines(S, Box, Text, hidden > 0 ? lines.slice(0, room) : lines, 0)
          )}
          {!showsPicture && hidden > 0 && (
            <Text {...S.muted} backgroundColor={S.background}>
              {`  … ${hidden} more lines in full screen`}
            </Text>
          )}
          {/* Every control on the bottom row, which sits on the prompt and so stays put. */}
          <Box justifyContent="space-between" paddingX={1} backgroundColor={S.background}>
            <Box flexShrink={0}>{navigation || <Text backgroundColor={S.background}> </Text>}</Box>
            {actions(S, Box, Button, Text, [
              ...toggle,
              { key: 'full', label: '⛶ full', onPress: fullScreen },
              { key: 'browser', label: '↗ browser', onPress: () => openInBrowser($, diagram!) },
              { key: 'copy', label: '⧉ copy', onPress: press => copy($, diagram!, press.surface, showsPicture) },
              { key: 'close', label: '✕ close', onPress: collapse },
            ])}
          </Box>
        </Box>
      )
    }

  })

  // Full screen: Claude Code's pane, which the person scrolls with the arrows.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const S = fullS
    const diagram = await current($)
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const Image = 'Image' in elements ? elements.Image : undefined

    if (!diagram) {
      return <Text {...S.muted}>No diagrams yet.</Text>
    }

    const lines = diagram.source.split('\n')
    // The pane's width less its padding; a wider diagram pans sideways instead of being cut.
    const visible = Math.max(10, e.props.bodyColumns - 2)
    const widest = Math.max(...lines.map(line => [...line].length))
    const maxPan = Math.max(0, widest - visible)
    const left = Math.min(await read($, pan), maxPan)
    const panBy = (by: number) => () => update($, pan, at => Math.max(0, Math.min(at + by, maxPan)))
    const step = Math.max(10, Math.floor(visible / 2))
    const showsPicture = isPictures && !!Image && !!diagram.picture && !(await read($, isText))

    // At least the pane's height, so the palette fills it and the footer sits at its
    // bottom; a taller diagram makes it longer and the person scrolls with the arrows.
    return (
      <Box flexDirection="column" width={e.props.bodyColumns} minHeight={e.props.scroll.bodyRows} backgroundColor={S.background}>
        <Box gap={1} paddingX={1} backgroundColor={S.surface}>
          <Text {...S.accent} backgroundColor={S.surface}>
            ◉
          </Text>
          <Text bold {...S.text} backgroundColor={S.surface} wrap="truncate-end">
            {diagram.title}
          </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} backgroundColor={S.background}>
          {showsPicture
            ? pictureBox(S, Box, Image!, diagram, visible, Math.max(4, e.props.scroll.bodyRows - 4), true)
            : diagramLines(S, Box, Text, lines.map(line => [...line].slice(left, left + visible).join('')), 1)}
        </Box>
        <Box justifyContent="space-between" paddingX={1} backgroundColor={S.background}>
          {!showsPicture && maxPan > 0 ? (
            <Box gap={1} flexShrink={0}>
              <Button key="left" label="◀" plain onPress={panBy(-step)} />
              <Text {...S.muted} backgroundColor={S.background}>
                columns {left + 1}–{Math.min(left + visible, widest)} of {widest}
              </Text>
              <Button key="right" label="▶" plain onPress={panBy(step)} />
            </Box>
          ) : (
            <Text backgroundColor={S.background}> </Text>
          )}
          {actions(S, Box, Button, Text, [
            ...(isPictures && diagram.picture
              ? [{ key: 'view', label: showsPicture ? '⌗ text' : '▦ picture', onPress: () => update($, isText, text => !text) }]
              : []),
            { key: 'browser', label: '↗ browser', onPress: () => openInBrowser($, diagram) },
            { key: 'copy', label: '⧉ copy', onPress: press => copy($, diagram, press.surface, showsPicture) },
            { key: 'close', label: '✕ close', onPress: () => closePane($) },
          ])}
        </Box>
      </Box>
    )
  })
}

type Elements = ReturnType<EngineInterface['ui']['resolve']>
type TerminalImage = Extract<Elements, { Image: unknown }>['Image']

// The diagram as plain Text rows, not Code: Code paints its own background over the palette.
function diagramLines(S: Palette, Box: Elements['Box'], Text: Elements['Text'], lines: readonly string[], paddingY: number) {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={paddingY} backgroundColor={S.background}>
      {lines.map((line, row) => (
        <Text key={`line-${row}`} {...S.text} backgroundColor={S.background} wrap="truncate-end">
          {line || ' '}
        </Text>
      ))}
    </Box>
  )
}

// Diagrams whose render failed this load, so a broken one isn't retried after every turn.
const failed = new Set<string>()
let isRendering = false

// Renders the pinned diagrams that have Mermaid and no picture yet, one at a time.
async function renderPictures($: EngineInterface, background: string, theme: string) {
  if (isRendering) {
    return
  }

  isRendering = true

  try {
    for (const diagram of await read($, list)) {
      if (!diagram.mermaid || diagram.picture || failed.has(diagram.mermaid)) {
        continue
      }

      const picture = await render($, diagram.mermaid, background, theme)

      if (picture) {
        await update($, list, all => all.map(one => (one.mermaid === diagram.mermaid ? { ...one, picture } : one)))
      } else {
        failed.add(diagram.mermaid)
        $.ui.toast(`Could not render "${diagram.title}" as a picture; showing the text`)
      }
    }
  } finally {
    isRendering = false
  }
}

// The picture at actual size, its shape kept, shrunk only when the room is smaller;
// in full screen (`grows`) as large as the room.
function pictureBox(S: Palette, Box: Elements['Box'], Image: TerminalImage, diagram: Diagram, columns: number, rows: number, grows = false) {
  const picture = diagram.picture!
  const rowsPerColumn = (picture.height / picture.width) * CELL_ASPECT
  const wide = Math.min(255, grows ? columns : picture.width / PIXELS_PER_COLUMN, columns, rows / rowsPerColumn)

  return (
    <Box paddingX={1} justifyContent="center" backgroundColor={S.background}>
      <Image
        source={{ file: picture.path, format: 'png' }}
        columns={Math.max(1, Math.round(wide))}
        rows={Math.max(1, Math.min(255, Math.round(wide * rowsPerColumn)))}
        alt={diagram.title}
      />
    </Box>
  )
}

// Renders Mermaid to a PNG in the temp folder with mmdc, or the pinned renderer through npx.
async function render($: EngineInterface, mermaid: string, background: string, theme: string): Promise<Picture | undefined> {
  const folder = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')
  const name = `${folder}/claude-diagram-${hash(`${mermaid}|${background}|${theme}`)}`
  await $.fs.write(`${name}.mmd`, mermaid)
  const args = ['-i', `${name}.mmd`, '-o', `${name}.png`, '-b', background, '-t', theme, '-s', '2', '-q']

  for (const argv of [['mmdc', ...args], ['npx', '-y', '-p', MERMAID_CLI, 'mmdc', ...args]]) {
    const isDone = await $.process.run(argv, { timeoutMs: RENDER_TIMEOUT_MS }).then(
      run => run.exitCode === 0,
      () => false,
    )

    if (isDone) {
      const { base64 } = await $.fs.read(`${name}.png`, { as: 'bytes' })
      const size = pngSize(base64)

      return size && { path: `${name}.png`, ...size }
    }
  }

  return undefined
}

// A PNG's size from its header: width and height are the big-endian words at bytes 16 and 20.
export function pngSize(base64: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []

  for (let at = 0; at + 4 <= Math.min(base64.length, 32); at += 4) {
    const word = [0, 1, 2, 3].reduce((sum, i) => (sum << 6) | Math.max(0, alphabet.indexOf(base64[at + i] ?? 'A')), 0)
    bytes.push((word >> 16) & 255, (word >> 8) & 255, word & 255)
  }

  const word = (at: number) => (((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)) >>> 0
  const width = word(16)
  const height = word(20)

  return width > 0 && height > 0 ? { width, height } : undefined
}

function hash(text: string) {
  let value = 5381

  for (const char of text) {
    value = ((value * 33) ^ char.codePointAt(0)!) >>> 0
  }

  return value.toString(36)
}

async function openPane($: EngineInterface) {
  await update($, pan, () => 0)
  await $.ui.close({ id: PANE })
  await zoom($)
  await update($, isFull, () => true)
  // Docked beside a fullscreen transcript, ask for every column the dock will give.
  await $.ui.open({ id: PANE, title: 'Diagram', focus: true, closeOnEscape: true, holdToasts: true, columns: FULL_COLUMNS })
}

type Action = { key: string; label: string; onPress: Parameters<Elements['Button']>[0]['onPress'] }

async function closePane($: EngineInterface) {
  await $.ui.close({ id: PANE })
  await update($, isFull, () => false)
  await unzoom($)
}

// Full screen makes the terminal pane fill its window first when it sits in a
// multiplexer split (herdr or tmux), and close puts it back; elsewhere nothing changes.
async function zoom($: EngineInterface) {
  const run = (argv: string[]) => $.process.run(argv).then(r => (r.exitCode === 0 ? r.stdout : undefined), () => undefined)
  const herdrPane = await $.env.get('HERDR_PANE_ID')

  if (herdrPane) {
    const herdr = (await $.env.get('HERDR_BIN_PATH')) || 'herdr'
    const layout = await run([herdr, 'pane', 'layout', '--pane', herdrPane])
    const isZoomed = layout === undefined || /"zoomed"\s*:\s*true/.test(layout)

    if (!isZoomed && (await run([herdr, 'pane', 'zoom', '--pane', herdrPane, '--on'])) !== undefined) {
      await update($, zoomedBy, () => 'herdr')
    }

    return
  }

  const tmuxPane = await $.env.get('TMUX_PANE')

  if (tmuxPane && (await run(['tmux', 'display', '-p', '-t', tmuxPane, '#{window_zoomed_flag}']))?.trim() === '0') {
    if ((await run(['tmux', 'resize-pane', '-Z', '-t', tmuxPane])) !== undefined) {
      await update($, zoomedBy, () => 'tmux')
    }
  }
}

async function unzoom($: EngineInterface) {
  const by = await read($, zoomedBy)

  if (!by) {
    return
  }

  await update($, zoomedBy, () => '')
  const run = (argv: string[]) => $.process.run(argv).catch(() => undefined)

  if (by === 'herdr') {
    const herdrPane = await $.env.get('HERDR_PANE_ID')
    const herdr = (await $.env.get('HERDR_BIN_PATH')) || 'herdr'

    if (herdrPane) {
      await run([herdr, 'pane', 'zoom', '--pane', herdrPane, '--off'])
    }
  } else if (by === 'tmux') {
    const tmuxPane = await $.env.get('TMUX_PANE')

    if (tmuxPane) {
      await run(['tmux', 'resize-pane', '-Z', '-t', tmuxPane])
    }
  }
}

// A row of quiet text buttons, dots between them: no brackets, no hotkey labels.
function actions(S: Palette, Box: Elements['Box'], Button: Elements['Button'], Text: Elements['Text'], list: readonly Action[]) {
  return (
    <Box gap={1} flexShrink={0}>
      {list.flatMap((action, at) => [
        ...(at > 0 ? [<Text key={`dot-${action.key}`} {...S.muted} backgroundColor={S.background}>·</Text>] : []),
        <Button key={action.key} label={action.label} plain onPress={action.onPress} />,
      ])}
    </Box>
  )
}

// Writes the diagram as a page to the temp folder and opens it in the default browser:
// readable on any screen, light or dark, and nothing to install.
async function openInBrowser($: EngineInterface, diagram: Diagram) {
  const folder = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')
  const slug = diagram.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'diagram'
  const path = `${folder}/claude-diagram-${slug}.html`
  // The picture goes into the page itself, so the file stands alone.
  const picture = diagram.picture
    ? await $.fs.read(diagram.picture.path, { as: 'bytes' }).then(read => read.base64, () => undefined)
    : undefined
  await $.fs.write(path, page(diagram, picture))

  for (const opener of ['open', 'xdg-open']) {
    // A missing opener throws or exits non-zero; either way, try the next one.
    const opened = await $.process.run([opener, path]).then(
      run => run.exitCode === 0,
      () => false,
    )

    if (opened) {
      $.ui.toast('Diagram opened in your browser')

      return
    }
  }

  $.ui.toast(`Diagram page written to ${path}`)
}

// The browser page: the picture when there is one (base64 PNG), with the text a
// tab away, and copy buttons for each.
function page(diagram: Diagram, picture?: string) {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const title = escape(diagram.title)
  const text = JSON.stringify(copyText(diagram)).replace(/</g, '\\u003c')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  /* Theme tokens: the system's choice, or the one picked with the moon/sun button. */
  :root {
    --bg: #f7f6f3; --dots: #e4e1da; --surface: #ffffff; --text: #1d1f23; --muted: #6f737a;
    --line: #e7e4dd; --hover: #f1efea; --accent: #d0602a; --paper: #ffffff;
    --bar: rgb(255 255 255 / .9); --bar-line: #e2dfd8; --bar-text: #4d5158; --bar-hover: #f1efea;
    color-scheme: light;
  }
  :root[data-theme="dark"] {
    --bg: #121316; --dots: #26282d; --surface: #1c1e22; --text: #f2f2f0; --muted: #a9adb4;
    --line: #34373e; --hover: #2a2d33; --accent: #f08a58; --paper: #fbfaf7;
    --bar: #33373e; --bar-line: #4a4f57; --bar-text: #e4e6ea; --bar-hover: #474c55;
    color-scheme: dark;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #121316; --dots: #26282d; --surface: #1c1e22; --text: #f2f2f0; --muted: #a9adb4;
      --line: #34373e; --hover: #2a2d33; --accent: #f08a58; --paper: #fbfaf7;
      --bar: #33373e; --bar-line: #4a4f57; --bar-text: #e4e6ea; --bar-hover: #474c55;
      color-scheme: dark;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column; background: var(--bg); color: var(--text); overflow: hidden;
    background-image: radial-gradient(var(--dots) 1px, transparent 1px); background-size: 20px 20px;
    font: 14px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased; transition: background-color .2s;
  }
  header { display: flex; align-items: center; gap: 10px; padding: 16px 22px; }
  .mark { width: 8px; height: 8px; border-radius: 2px; background: var(--accent); transform: rotate(45deg); flex: none; }
  h1 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* The stage scrolls when zoomed past the window; dragging pans it. */
  main { flex: 1; overflow: auto; display: grid; padding: 12px 24px 96px; cursor: grab; }
  main.dragging { cursor: grabbing; user-select: none; }
  .sheet {
    margin: auto; border-radius: 14px; overflow: hidden;
    box-shadow: 0 0 0 1px var(--line), 0 1px 2px rgb(0 0 0 / .04), 0 12px 32px rgb(0 0 0 / .08);
  }
  /* The picture is drawn dark on transparent: it sits on paper in both themes. */
  img { display: block; padding: 24px; background: var(--paper); -webkit-user-drag: none; }
  /* The text on the plain sheet, in the page's own ink. */
  pre {
    margin: 0; padding: 28px 32px; color: var(--text); background: var(--surface);
    font: 14px/1.35 ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  }
  .hidden { display: none; }
  nav {
    position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); display: flex; align-items: center; gap: 2px;
    padding: 5px; background: var(--bar); backdrop-filter: blur(10px); border: 1px solid var(--bar-line);
    border-radius: 12px; box-shadow: 0 10px 32px rgb(0 0 0 / .18); white-space: nowrap; max-width: calc(100vw - 24px); overflow-x: auto;
  }
  nav button {
    font: inherit; font-size: 13px; color: var(--bar-text); background: none; border: 0; border-radius: 8px;
    padding: 5px 10px; cursor: pointer; transition: color .15s, background .15s;
  }
  nav button:hover, nav button[aria-pressed="true"] { color: var(--text); background: var(--bar-hover); }
  nav button.done { color: var(--accent); }
  nav .icon { width: 30px; padding: 5px 0; font-size: 16px; line-height: 1; }
  nav output { min-width: 48px; text-align: center; font-size: 12px; color: var(--bar-text); font-variant-numeric: tabular-nums; }
  nav .rule { width: 1px; height: 18px; margin: 0 6px; background: var(--bar-line); flex: none; }
</style>
</head>
<body>
<header><span class="mark"></span><h1>${title}</h1></header>
<main id="stage">
  <div class="sheet">
    ${picture ? `<img id="picture" alt="${title}" src="data:image/png;base64,${picture}">` : ''}
    <pre id="diagram"${picture ? ' class="hidden"' : ''}>${escape(diagram.source)}</pre>
  </div>
</main>
<nav>
  <button class="icon" id="zoom-out" title="Zoom out (−)">−</button>
  <output id="zoom">100%</output>
  <button class="icon" id="zoom-in" title="Zoom in (+)">+</button>
  <button id="fit" title="Fit to window (0)">Fit</button>
  ${picture ? '<span class="rule"></span><button id="show-picture" aria-pressed="true">Picture</button><button id="show-text" aria-pressed="false">Text</button>' : ''}
  <span class="rule"></span>
  ${picture ? '<button id="copy-image">Copy picture</button>' : ''}
  <button id="copy">Copy${picture ? ' text' : ''}</button>
  <span class="rule"></span>
  <button class="icon" id="theme" title="Switch light and dark">☾</button>
</nav>
<script>
  // The theme: the system's until picked; the pick is remembered for every diagram page.
  const themeButton = document.getElementById('theme')
  const isDark = () => (document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark'
  const paintTheme = () => { themeButton.textContent = isDark() ? '☀' : '☾' }
  try { const kept = localStorage.getItem('diagram-theme'); if (kept) document.documentElement.dataset.theme = kept } catch {}
  paintTheme()
  themeButton.onclick = () => {
    const next = isDark() ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    try { localStorage.setItem('diagram-theme', next) } catch {}
    paintTheme()
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paintTheme)

  const stage = document.getElementById('stage')
  const pre = document.getElementById('diagram')
  const img = document.getElementById('picture')
  const label = document.getElementById('zoom')
  let isText = !img
  let zoom = 1

  // 100% is the picture at its natural size (rendered at 2x) or the text at 14px.
  const shown = () => (isText ? pre : img)
  function base() {
    if (isText) {
      pre.style.fontSize = '14px'
      return { width: pre.scrollWidth, height: pre.scrollHeight }
    }
    return { width: img.naturalWidth / 2 + 48, height: img.naturalHeight / 2 + 48 }
  }
  function apply() {
    if (isText) pre.style.fontSize = 14 * zoom + 'px'
    else img.style.width = (img.naturalWidth / 2) * zoom + 48 + 'px'
    label.textContent = Math.round(zoom * 100) + '%'
  }
  function setZoom(next) { zoom = Math.min(8, Math.max(0.1, next)); apply() }
  function fit() {
    const size = base()
    setZoom(Math.min(1, (stage.clientWidth - 48) / size.width, (stage.clientHeight - 108) / size.height))
  }
  document.getElementById('zoom-in').onclick = () => setZoom(zoom * 1.25)
  document.getElementById('zoom-out').onclick = () => setZoom(zoom / 1.25)
  document.getElementById('fit').onclick = fit
  addEventListener('keydown', e => {
    if (e.key === '+' || e.key === '=') setZoom(zoom * 1.25)
    else if (e.key === '-') setZoom(zoom / 1.25)
    else if (e.key === '0') fit()
  })
  // Pinch or ctrl+scroll zooms.
  stage.addEventListener('wheel', e => {
    if (!e.ctrlKey) return
    e.preventDefault()
    setZoom(zoom * Math.exp(-e.deltaY / 200))
  }, { passive: false })
  let drag
  stage.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop }; stage.classList.add('dragging') })
  addEventListener('pointermove', e => { if (drag) { stage.scrollLeft = drag.left - (e.clientX - drag.x); stage.scrollTop = drag.top - (e.clientY - drag.y) } })
  addEventListener('pointerup', () => { drag = undefined; stage.classList.remove('dragging') })

  function flash(button, text) {
    const before = button.textContent
    button.textContent = text
    button.classList.add('done')
    setTimeout(() => { button.textContent = before; button.classList.remove('done') }, 1400)
  }
  const copy = document.getElementById('copy')
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(${text}); flash(copy, 'Copied') }
    catch { flash(copy, 'Select and copy') }
  }

  if (img) {
    const showPicture = document.getElementById('show-picture')
    const showText = document.getElementById('show-text')
    function show(text) {
      isText = text
      img.classList.toggle('hidden', text)
      pre.classList.toggle('hidden', !text)
      showPicture.setAttribute('aria-pressed', String(!text))
      showText.setAttribute('aria-pressed', String(text))
      fit()
    }
    showPicture.onclick = () => show(false)
    showText.onclick = () => show(true)
    const copyImage = document.getElementById('copy-image')
    copyImage.onclick = async () => {
      try {
        const blob = await (await fetch(img.src)).blob()
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
        flash(copyImage, 'Copied')
      } catch { flash(copyImage, 'Right-click to copy') }
    }
    img.complete ? fit() : img.addEventListener('load', fit)
  } else {
    fit()
  }
</script>
</body>
</html>
`
}

// Adds a diagram to the history, or finds it there, and points the chip at it.
async function pin($: EngineInterface, diagram: Diagram) {
  const all = await update($, list, prior =>
    prior.some(one => one.source === diagram.source) ? prior : [...prior, diagram].slice(-MAX_DIAGRAMS),
  )
  await update($, index, () => all.findIndex(one => one.source === diagram.source))
}

async function current($: EngineInterface) {
  const all = await read($, list)

  return all[clamp(await read($, index), all.length)]
}

// Copies what the card shows: the picture as an image where the machine has a tool
// for that (macOS, or xclip), else the text.
async function copy($: EngineInterface, diagram: Diagram, surface: Parameters<EngineInterface['ui']['copy']>[0]['surface'], isPicture: boolean) {
  if (isPicture && diagram.picture && (await copyImage($, diagram.picture.path))) {
    $.ui.toast('Picture copied, ready to paste into Slack, GitHub or Notion')

    return
  }

  const copied = await $.ui.copy({ text: copyText(diagram), surface })
  $.ui.toast(copied.isCopied ? 'Diagram copied, ready to paste into Slack, GitHub or Notion' : 'Could not copy the diagram')
}

async function copyImage($: EngineInterface, path: string) {
  const tools = [
    ['osascript', '-e', `set the clipboard to (read (POSIX file ${JSON.stringify(path)}) as «class PNGf»)`],
    ['xclip', '-selection', 'clipboard', '-t', 'image/png', '-i', path],
  ]

  for (const argv of tools) {
    if (await $.process.run(argv).then(run => run.exitCode === 0, () => false)) {
      return true
    }
  }

  return false
}

// What copy puts on the clipboard: the title as a plain line (Slack shows **bold** as
// asterisks) and the diagram fenced, so Slack, GitHub and Notion keep it monospace.
export function copyText(diagram: Diagram) {
  return `${diagram.title}\n\`\`\`\n${diagram.source}\n\`\`\`\n`
}

function clamp(i: number, length: number) {
  return Math.max(0, Math.min(i, length - 1))
}

function isDiagram(source: string) {
  return (source.match(DRAWING) ?? []).length >= MIN_DRAWING_CHARS && source.split('\n').length >= 3
}

// A reply split into its prose and its diagrams. A short line just before a
// diagram becomes its title and leaves the prose.
export function partsOf(text: string): Part[] {
  const parts: Part[] = []
  let from = 0

  for (const match of text.matchAll(FENCE)) {
    const language = (match[2] ?? '').trim().toLowerCase()
    const source = (match[3] ?? '').replace(/\s+$/, '')
    const isMermaid = language === 'mermaid'

    if (!isMermaid && !isDiagram(source)) {
      continue
    }

    const before = text.slice(from, match.index + (match[1] ?? '').length)
    const previous = parts.at(-1)

    // A Mermaid block right after a text diagram is that diagram's picture.
    if (isMermaid && !before.trim() && previous?.kind === 'diagram' && !previous.diagram.mermaid) {
      previous.diagram.mermaid = source
      from = match.index + match[0].length
      continue
    }

    const { prose, title } = splitTitle(before)

    if (prose.trim()) {
      parts.push({ kind: 'text', text: prose.trim() })
    }

    parts.push({ kind: 'diagram', diagram: isMermaid ? { title, source, mermaid: source } : { title, source } })
    from = match.index + match[0].length
  }

  const rest = text.slice(from)

  if (rest.trim()) {
    parts.push({ kind: 'text', text: rest.trim() })
  }

  return parts
}

export function diagramsIn(text: string): Diagram[] {
  return partsOf(text).flatMap(part => (part.kind === 'diagram' ? [part.diagram] : []))
}

function splitTitle(before: string) {
  const lines = before.replace(/\s+$/, '').split('\n')
  const last = lines.at(-1)?.trim() ?? ''
  const plain = last.replace(/^#+\s*/, '').replace(/[*_`]/g, '').replace(/:$/, '').trim()
  const isTitleLine = plain.length > 0 && plain.length <= 60 && (/^(\*\*|__|#)/.test(last) || /:$/.test(last))

  if (isTitleLine) {
    return { prose: lines.slice(0, -1).join('\n'), title: plain }
  }

  return { prose: before, title: 'Diagram' }
}
