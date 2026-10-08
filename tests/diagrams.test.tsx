import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { copyText, partsOf, pngSize } from '../hooks/register'

const SURFACES = ['terminal', 'desktop'] as const
const SITE = { bodyColumns: 100, scroll: { offset: 0, bodyRows: 30 }, view: {} }
const BAND = { hasSurvey: false, isWorking: false, maxRows: 30, ...SITE }
const FLOW = '┌──────┐    ┌─────────┐\n│ user │ ──▶│ server  │ <b>\n└──────┘    └─────────┘'
const REPLY = ['Some prose first.', '```js', 'const notADiagram = 1', '```', '**Slack request flow**', '```text', FLOW, '```', 'Closing line.'].join('\n')

// The engine beneath the plugin: an empty band, a finished turn, and a clock the test moves.
function engine(on: On) {
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })

  return mock.clock(on)
}

test('a reply splits into prose and a titled diagram', () => {
  const parts = partsOf(REPLY)

  expect(parts.map(part => part.kind)).toEqual(['text', 'diagram', 'text'])
  expect(parts[1]).toEqual({ kind: 'diagram', diagram: { title: 'Slack request flow', source: FLOW } })
  expect(parts[0]).toEqual({ kind: 'text', text: 'Some prose first.\n```js\nconst notADiagram = 1\n```' })
})

test('a diagram after a long sentence is titled "Diagram", not the sentence', () => {
  const reply = ['If you do not see a card, the mod is not showing it even though it says so here.', '```text', FLOW, '```'].join('\n')

  expect(partsOf(reply)[1]).toEqual({ kind: 'diagram', diagram: { title: 'Diagram', source: FLOW } })
})

test('a reply without a drawn block is left alone', () => {
  expect(partsOf('Just text.\n```js\nconst a = 1\n```').every(part => part.kind === 'text')).toBe(true)
})

for (const surface of SURFACES) {
  test(`no chip before any diagram; after a reply its title types back in (${surface})`, async ($, on) => {
    const clock = engine(on)
    const mount = (requestId: string, props = BAND) =>
      $.ui.mount({ plugin: 'diagrams', surface, component: 'AbovePrompt', props, requestId })

    expect(await (await mount('empty')).find({ key: 'open' })).toBeUndefined()

    await $.turn.complete({ answer: REPLY, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    // Expand is there from the first frame, so it never moves out from under a click.
    expect(await (await mount('typing')).find({ key: 'open' })).toBeDefined()

    await clock.advance(1000)
    const band = await mount('typed')
    expect(await band.find({ text: 'Slack request flow' })).toBeDefined()
    expect(await band.find({ key: 'open' })).toBeDefined()
    await $.ui.press({ plugin: 'diagrams', key: 'open-title', requestId: 'typed' })
    expect(await (await mount('title-pressed')).find({ key: 'full' })).toBeDefined()
    await $.ui.press({ plugin: 'diagrams', key: 'close', requestId: 'title-pressed' })

    const working = await mount('working', { ...BAND, isWorking: true })
    expect(await working.find({ text: 'Slack request flow' })).toBeUndefined()
    expect(await working.find({ key: 'open-symbol' })).toBeDefined()

    // Expanding mid-turn shows the diagram, and it stays up while the turn runs.
    await $.ui.press({ plugin: 'diagrams', key: 'open', requestId: 'working' })
    const card = await mount('working-card', { ...BAND, isWorking: true })
    expect(await card.find({ text: '│ user │ ──▶│ server  │' })).toBeDefined()
  })
}

test('expand grows the card in place, full screen opens the pane, close collapses', async ($, on) => {
  const clock = engine(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  const mount = (requestId: string) =>
    $.ui.mount({ plugin: 'diagrams', surface: 'terminal', component: 'AbovePrompt', props: BAND, requestId })

  await $.turn.complete({ answer: REPLY, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(1000)
  await mount('chip')
  await $.ui.press({ plugin: 'diagrams', key: 'open', requestId: 'chip' })

  const card = await mount('card')
  expect(await card.find({ text: '│ user │ ──▶│ server  │' })).toBeDefined()
  expect(await card.find({ key: 'copy' })).toBeDefined()
  expect(await card.find({ key: 'full' })).toBeDefined()

  await $.ui.press({ plugin: 'diagrams', key: 'close', requestId: 'card' })
  const chip = await mount('again')
  expect(await chip.find({ key: 'open' })).toBeDefined()
  expect(await chip.find({ key: 'copy' })).toBeUndefined()

  const pane = await $.ui.mount({
    plugin: 'diagrams',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'diagram',
    props: { title: 'Diagram', isFocused: true, placement: 'dock', ...SITE },
  })
  expect(await pane.find({ text: '│ user │ ──▶│ server  │' })).toBeDefined()
  expect(await pane.find({ key: 'close' })).toBeDefined()
})

for (const palette of ['terminal', 'solarized-light'] as const) {
  test(`the ${palette} palette draws the expanded card`, { options: { palette } }, async ($, on) => {
    const clock = engine(on)
    const mount = (requestId: string) =>
      $.ui.mount({ plugin: 'diagrams', surface: 'terminal', component: 'AbovePrompt', props: BAND, requestId })

    await $.turn.complete({ answer: REPLY, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.advance(1000)
    await mount('chip')
    await $.ui.press({ plugin: 'diagrams', key: 'open', requestId: 'chip' })

    expect(await (await mount('card')).find({ text: '│ user │ ──▶│ server  │' })).toBeDefined()
  })
}

test('browser writes the diagram as a page and opens it', async ($, on) => {
  const clock = engine(on)
  const written: { path: string; text: string }[] = []
  const ran: string[][] = []
  on('env.get', () => ({ value: '/tmp/test/' }))
  on('fs.write', (_$, e) => {
    written.push({ path: e.path, text: e.text })

    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    ran.push([...e.argv])

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', () => ({ value: undefined }))
  const mount = (requestId: string) =>
    $.ui.mount({ plugin: 'diagrams', surface: 'terminal', component: 'AbovePrompt', props: BAND, requestId })

  await $.turn.complete({ answer: REPLY, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(1000)
  await mount('chip')
  await $.ui.press({ plugin: 'diagrams', key: 'open', requestId: 'chip' })
  await mount('card')
  await $.ui.press({ plugin: 'diagrams', key: 'browser', requestId: 'card' })

  expect(written[0]?.path).toBe('/tmp/test/claude-diagram-slack-request-flow.html')
  expect(written[0]?.text).toContain('&lt;') // nothing in the diagram is read as markup
  expect(ran).toEqual([['open', '/tmp/test/claude-diagram-slack-request-flow.html']])
})

test('copy fences the diagram under its title, ready for Slack and GitHub', () => {
  expect(copyText({ title: 'Slack request flow', source: FLOW })).toBe(`Slack request flow\n\`\`\`\n${FLOW}\n\`\`\`\n`)
})

test('a call to the old show_diagram tool still pins its diagram', async ($, on) => {
  engine(on)
  const called = await $.tool.call({ tool: 'mcp__diagrams__show_diagram', title: 'Old tool', diagram: FLOW })
  expect(called.deny).toBeUndefined()

  const pane = await $.ui.mount({
    plugin: 'diagrams',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'diagram',
    props: { title: 'Diagram', isFocused: true, placement: 'dock', ...SITE },
  })
  expect(await pane.find({ text: 'Old tool' })).toBeDefined()
})

test('a diagram wider than full screen pans sideways instead of being cut', async ($, on) => {
  engine(on)
  const wide = ['┌' + '─'.repeat(150) + '┐', '│ left end' + ' '.repeat(132) + 'right end │', '└' + '─'.repeat(150) + '┘'].join('\n')
  await $.tool.call({ tool: 'mcp__diagrams__show_diagram', title: 'Wide', diagram: wide })
  const before = await $.ui.mount({
    plugin: 'diagrams',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'diagram',
    props: { title: 'Diagram', isFocused: true, placement: 'dock', ...SITE },
  })
  expect(await before.find({ text: 'left end' })).toBeDefined()
  expect(await before.find({ text: 'right end' })).toBeUndefined()

  await $.ui.press({ plugin: 'diagrams', key: 'right', requestId: 'diagram' })
  await $.ui.press({ plugin: 'diagrams', key: 'right', requestId: 'diagram' })
  expect(await before.find({ text: 'right end' })).toBeDefined()
  expect(await before.find({ text: 'left end' })).toBeUndefined()
})

test('full screen zooms the herdr pane, and close un-zooms only what it zoomed', async ($, on) => {
  const clock = engine(on)
  const ran: string[][] = []
  const env: Record<string, string> = { HERDR_PANE_ID: 'w1:p1', HERDR_BIN_PATH: '/bin/herdr' }
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('process.run', (_$, e) => {
    ran.push([...e.argv])
    const stdout = e.argv.includes('layout') ? '{"result":{"layout":{"zoomed":false}}}' : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  const mount = (requestId: string) =>
    $.ui.mount({ plugin: 'diagrams', surface: 'terminal', component: 'AbovePrompt', props: BAND, requestId })

  await $.turn.complete({ answer: REPLY, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(1000)
  await mount('chip')
  await $.ui.press({ plugin: 'diagrams', key: 'open', requestId: 'chip' })
  await mount('card')
  await $.ui.press({ plugin: 'diagrams', key: 'full', requestId: 'card' })

  expect(ran).toContainEqual(['/bin/herdr', 'pane', 'zoom', '--pane', 'w1:p1', '--on'])

  await $.ui.mount({
    plugin: 'diagrams',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'diagram',
    props: { title: 'Diagram', isFocused: true, placement: 'dock', ...SITE },
  })
  await $.ui.press({ plugin: 'diagrams', key: 'close', requestId: 'diagram' })

  expect(ran.at(-1)).toEqual(['/bin/herdr', 'pane', 'zoom', '--pane', 'w1:p1', '--off'])
})

const MERMAID = 'flowchart LR\n  A["user"] --> B["server"]'
const PICTURE_REPLY = ['**Slack request flow**', '```text', FLOW, '```', '```mermaid', MERMAID, '```'].join('\n')

test('a mermaid block right after a text diagram becomes its picture source', () => {
  const parts = partsOf(PICTURE_REPLY)

  expect(parts).toEqual([{ kind: 'diagram', diagram: { title: 'Slack request flow', source: FLOW, mermaid: MERMAID } }])
})

test('a mermaid block on its own is a diagram too', () => {
  const parts = partsOf(['**Flow**', '```mermaid', MERMAID, '```'].join('\n'))

  expect(parts).toEqual([{ kind: 'diagram', diagram: { title: 'Flow', source: MERMAID, mermaid: MERMAID } }])
})

test('pngSize reads a PNG header', () => {
  expect(pngSize('iVBORw0KGgoAAAANSUhEUgAAA4gAAACMCAIAAACxqxAS')).toEqual({ width: 904, height: 140 })
})

test('with pictures on, a reply is rendered and the card shows the picture, with a text toggle', { options: { pictures: 'on' } }, async ($, on) => {
  const clock = engine(on)
  const ran: string[][] = []
  on('env.get', () => ({ value: '/tmp/test' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', () => ({ value: { base64: 'iVBORw0KGgoAAAANSUhEUgAAA4gAAACMCAIAAACxqxAS' } }))
  on('process.run', (_$, e) => {
    ran.push([...e.argv])

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const mount = (requestId: string) =>
    $.ui.mount({ plugin: 'diagrams', surface: 'terminal', component: 'AbovePrompt', props: BAND, requestId })

  await $.turn.complete({ answer: PICTURE_REPLY, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(1000)
  expect(ran[0]?.[0]).toBe('mmdc')

  await mount('chip')
  await $.ui.press({ plugin: 'diagrams', key: 'open', requestId: 'chip' })
  const card = await mount('card')
  expect(await card.find({ type: 'Image' })).toBeDefined()
  expect(await card.find({ key: 'view' })).toBeDefined()

  await $.ui.press({ plugin: 'diagrams', key: 'view', requestId: 'card' })
  expect(await card.find({ type: 'Image' })).toBeUndefined()
  expect(await card.find({ text: '│ user │ ──▶│ server  │' })).toBeDefined()
})


test('with a picture, copy puts the image on the clipboard and the browser page shows it', { options: { pictures: 'on' } }, async ($, on) => {
  const clock = engine(on)
  const ran: string[][] = []
  const written: Record<string, string> = {}
  on('env.get', () => ({ value: '/tmp/test' }))
  on('fs.write', (_$, e) => {
    written[e.path] = e.text

    return { value: undefined }
  })
  on('fs.read', () => ({ value: { base64: 'iVBORw0KGgoAAAANSUhEUgAAA4gAAACMCAIAAACxqxAS' } }))
  on('process.run', (_$, e) => {
    ran.push([...e.argv])

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', () => ({ value: undefined }))

  await $.turn.complete({ answer: PICTURE_REPLY, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(1000)
  await $.ui.mount({ plugin: 'diagrams', surface: 'terminal', component: 'AbovePrompt', props: BAND, requestId: 'chip' })
  await $.ui.press({ plugin: 'diagrams', key: 'open', requestId: 'chip' })
  await $.ui.mount({ plugin: 'diagrams', surface: 'terminal', component: 'AbovePrompt', props: BAND, requestId: 'card' })

  await $.ui.press({ plugin: 'diagrams', key: 'copy', requestId: 'card' })
  expect(ran.at(-1)?.[0]).toBe('osascript')

  await $.ui.press({ plugin: 'diagrams', key: 'browser', requestId: 'card' })
  const html = Object.entries(written).find(([path]) => path.endsWith('.html'))?.[1] ?? ''
  expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo')
  expect(html).toContain('Copy picture')
})
