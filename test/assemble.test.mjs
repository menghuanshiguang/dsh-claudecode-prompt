/**
 * Integration tests for the plugin itself, against a fake `systemPrompt` service.
 *
 * The fake model of the real thing:
 *   - `ctx.systemPrompt.getSectionOrder(name)` throws for unknown names.
 *   - `ctx.on('system-prompt/assemble', listener, { prepend })` builds a waterfall:
 *     a listener receives `(assembly, context, next)` and returns the next value in
 *     the chain. `prepend` unshifts, so the plugin that registers last is outermost
 *     and therefore has the final say over the returned assembly.
 *
 * Run with `npm run test:assemble` (or `node --test test/`).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../index.js'

/**
 * Build the fake service, register the plugin, and return an `assemble()` that runs
 * the waterfall exactly like the harness would.
 *
 * @param {object} options
 * @param {{ name: string, text?: string, interpolate?: boolean }[]} options.sections
 * @param {Record<string, number>} [options.orders]
 * @param {string[]} [options.keep]  Other sections to keep (test convenience).
 * @param {Record<string, unknown>} [options.config]  Plugin config overrides.
 */
function createHarness({ sections, orders = {}, config = {}, contexts = [], tools = [] }) {
  /** @type {{ listener: Function, options: { prepend?: boolean } }[]} */
  const listeners = []

  const ctx = {
    systemPrompt: {
      getSectionOrder(name) {
        if (!(name in orders)) throw new Error(`cannot get section order for "${name}"`)
        return orders[name]
      },
    },
    on(event, listener, options = {}) {
      assert.equal(event, 'system-prompt/assemble')
      listeners.push({ listener, options })
      return () => {}
    },
  }

  const base = { sections, contexts, tools, variables: { working_directory: 'D:\\x' } }

  const assemble = async () => {
    const ordered = []
    for (const entry of listeners) {
      if (entry.options.prepend) ordered.unshift(entry)
      else ordered.push(entry)
    }
    let chain = async () => base
    for (const entry of [...ordered].reverse()) {
      const next = chain
      chain = (...args) => entry.listener(...args, next)
    }
    return chain(base, {})
  }

  /** Register an extra waterfall listener, mimicking another plugin. */
  const addListener = (listener, options = {}) => {
    listeners.push({ listener, options })
  }

  apply(ctx, config)
  return { assemble, addListener, listeners, base }
}

const DSH_SECTIONS = [
  { name: 'sunder:identity', text: 'sunder identity' },
  { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
  { name: 'plan:policy', text: 'plan policy' },
  { name: 'tool:bash', text: 'bash tool' },
]

test('replaces the whole prompt and leaves contexts/tools/variables alone', async () => {
  const contexts = [{ name: 'working-directory', text: 'cwd is D:\\x' }]
  const tools = [{ name: 'ops_bash', description: 'run a command' }]
  const { assemble, base } = createHarness({ sections: [...DSH_SECTIONS], contexts, tools })

  const result = await assemble()

  assert.deepEqual(result.sections.map((section) => section.name), [
    'claudecode:identity',
    'claudecode:prompt',
  ])
  assert.ok(result.sections[0].text.startsWith('You are a Claude agent'))
  assert.ok(result.sections[1].text.includes('# Doing tasks'))
  assert.equal(result.contexts, base.contexts, 'contexts are passed through by reference')
  assert.equal(result.tools, base.tools, 'tool schemas are passed through by reference')
  assert.deepEqual(result.variables, base.variables)
  assert.ok(!result.sections.some((section) => /DeepSeek Harness|sunder|plan policy/.test(section.text)))
})

test('own sections are emitted with interpolate:false so {{…}} stays literal', async () => {
  // The CLI prompt's interpolate-hostile braces live in the memory section, which is
  // dropped by default — keep every section here to prove the text is passed through
  // untouched and that the section itself is marked non-interpolating.
  const { assemble } = createHarness({ sections: DSH_SECTIONS, config: { dropSections: [] } })
  const result = await assemble()

  for (const section of result.sections) assert.equal(section.interpolate, false)
  assert.match(result.sections[1].text, /\{\{short-kebab-case-slug\}\}/)
})

test('keepSections preserves foreign sections at their registry order', async () => {
  const { assemble } = createHarness({
    sections: [
      ...DSH_SECTIONS,
      { name: 'astra:identity-head', text: 'head' },
      { name: 'astra:identity', text: 'core' },
    ],
    orders: { 'astra:identity-head': 901, 'astra:identity': 20000 },
    config: { keepSections: ['astra:identity-head', 'astra:identity'] },
  })

  const result = await assemble()

  assert.deepEqual(
    result.sections.map((section) => section.name),
    ['claudecode:identity', 'astra:identity-head', 'claudecode:prompt', 'astra:identity'],
  )
  assert.ok(result.sections[0].text.startsWith('You are a Claude agent'))
  assert.equal(result.sections[1].text, 'head')
  assert.ok(result.sections[2].text.startsWith('You are an agent working with the user'))
  assert.equal(result.sections[3].text, 'core')
})

test('kept sections with no resolvable order and no resolvable neighbour fall before the prompt', async () => {
  // Nothing around them in the assembly has a known order either, so there is
  // nothing to interpolate from; "in front" is the conservative default.
  const { assemble } = createHarness({
    sections: [
      { name: 'custom:first', text: 'first' },
      { name: 'custom:second', text: 'second' },
    ],
    config: { keepSections: ['custom:first', 'custom:second'] },
  })

  assert.deepEqual(
    (await assemble()).sections.map((section) => section.name),
    ['custom:first', 'custom:second', 'claudecode:identity', 'claudecode:prompt'],
  )
})

test('the static order table places kept sections even when the registry answers nothing', async () => {
  // Live boot: getSectionOrder() returned nothing for every section, DSH's own
  // included. The table (SECTION_ORDERS of dsh-system-prompt 0.2.1-rc.3) is what
  // keeps sunder's rules/footer behind Claude Code's instructions instead of
  // ahead of them.
  const { assemble } = createHarness({
    sections: [
      { name: 'sunder:identity', text: 'sunder identity' },
      { name: 'deployment:persona-prefix', text: 'persona prefix' },
      { name: 'tool:read', text: 'read tool' },
      { name: 'sunder:rules', text: 'sunder rules' },
      { name: 'deployment:persona-suffix', text: 'persona suffix' },
      { name: 'sunder:footer', text: 'sunder footer' },
    ],
    config: { keepSections: ['sunder:identity', 'sunder:rules', 'sunder:footer'] },
  })

  assert.deepEqual(
    (await assemble()).sections.map((section) => section.name),
    ['sunder:identity', 'claudecode:identity', 'claudecode:prompt', 'sunder:rules', 'sunder:footer'],
  )
})

test('kept sections with an unresolvable order borrow their neighbours (the live sunder case)', async () => {
  // Seen in a real boot: the registry resolved neither sunder:identity nor
  // sunder:rules/footer from inside this plugin, so every kept section collapsed to
  // the same placeholder order and sunder's "rules" text landed *in front of*
  // Claude Code's instructions. The incoming list is already sorted, so neighbours
  // that do resolve can place the rest.
  const { assemble } = createHarness({
    sections: [
      { name: 'sunder:identity', text: 'sunder identity' },
      { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
      { name: 'tool:bash', text: 'bash tool' },
      { name: 'sunder:rules', text: 'sunder rules' },
      { name: 'sunder:footer', text: 'sunder footer' },
    ],
    orders: { 'harness:identity': -1000, 'tool:bash': 1000 },
    config: { keepSections: ['sunder:identity', 'sunder:rules', 'sunder:footer'] },
  })

  assert.deepEqual(
    (await assemble()).sections.map((section) => section.name),
    ['sunder:identity', 'claudecode:identity', 'claudecode:prompt', 'sunder:rules', 'sunder:footer'],
  )
})

test('includeIdentity:false and no keepSections collapses to a single section', async () => {
  const { assemble } = createHarness({ sections: DSH_SECTIONS, config: { includeIdentity: false } })

  const result = await assemble()
  assert.deepEqual(result.sections.map((section) => section.name), ['claudecode:prompt'])
})

test('vscode variant is what actually gets mounted', async () => {
  const { assemble } = createHarness({ sections: DSH_SECTIONS, config: { variant: 'vscode' } })

  const prompt = (await assemble()).sections.at(-1).text
  assert.ok(prompt.includes('# Harness'))
  assert.ok(prompt.length < 6000)
})

test('an outer assembly guard registered after this plugin wins (bundle order matters)', async () => {
  // A sunder-style guard: it sees whatever came out of the chain and re-attaches
  // its own sections. Registered *after* our plugin, `prepend` puts it outermost,
  // so this documents why the bundle must be listed after dsh-sunder.
  const guard = async (...args) => {
    const next = args.at(-1)
    const assembly = await next()
    return { ...assembly, sections: [...assembly.sections, { name: 'sunder:rules', text: 'rules' }] }
  }

  const { assemble, addListener } = createHarness({ sections: DSH_SECTIONS })
  addListener(guard, { prepend: true })

  assert.deepEqual(
    (await assemble()).sections.map((section) => section.name),
    ['claudecode:identity', 'claudecode:prompt', 'sunder:rules'],
  )
})

test('registered after such a guard, this plugin still has the last word', async () => {
  const guard = async (...args) => {
    const next = args.at(-1)
    const assembly = await next()
    return { ...assembly, sections: [...assembly.sections, { name: 'sunder:rules', text: 'rules' }] }
  }

  // Guard registers first (sunder loads earlier), plugin second -> plugin outermost.
  const listeners = []
  const ctx = {
    systemPrompt: { getSectionOrder: () => 1 },
    on(event, listener, options = {}) {
      listeners.push({ listener, options })
      return () => {}
    },
  }
  listeners.push({ listener: guard, options: { prepend: true } })
  apply(ctx, {})

  const base = { sections: DSH_SECTIONS, contexts: [], tools: [], variables: {} }
  const ordered = []
  for (const entry of listeners) {
    if (entry.options.prepend) ordered.unshift(entry)
    else ordered.push(entry)
  }
  let chain = async () => base
  for (const entry of [...ordered].reverse()) {
    const next = chain
    chain = (...args) => entry.listener(...args, next)
  }

  const result = await chain(base, {})
  assert.deepEqual(
    result.sections.map((section) => section.name),
    ['claudecode:identity', 'claudecode:prompt'],
  )
})

test('enabled:false registers nothing', async () => {
  const { assemble, listeners } = createHarness({ sections: DSH_SECTIONS, config: { enabled: false } })

  assert.equal(listeners.length, 0)
  assert.deepEqual((await assemble()).sections.map((section) => section.name), [
    'sunder:identity',
    'harness:identity',
    'plan:policy',
    'tool:bash',
  ])
})

test('promptPath loads an arbitrary prompt body', async () => {
  const { fileURLToPath } = await import('node:url')
  const path = fileURLToPath(new URL('../prompt/claude-code-vscode.md', import.meta.url))
  const { assemble } = createHarness({ sections: DSH_SECTIONS, config: { promptPath: path } })

  assert.ok((await assemble()).sections.at(-1).text.includes('# Harness'))
})
