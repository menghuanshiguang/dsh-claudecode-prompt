/**
 * Unit tests for the pure text layer: no Harness runtime required.
 *
 * Run with `npm run test:transform` (or `node --test test/`).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeConfig, readPromptFile, DSH_TOOL_NAMES } from '../lib/config.js'
import {
  applyRewrites,
  buildPromptText,
  composePrompt,
  DEFAULT_REWRITES,
  dropHeadingSections,
  mapToolNames,
  splitH1Sections,
  stripDynamicTail,
} from '../lib/transform.js'

/**
 * Render a vendored prompt through the pipeline `index.js` uses (identity
 * included), so the assertions below see what the model would actually read.
 *
 * @param {object} config  Output of `normalizeConfig`.
 * @param {object} [overrides]
 * @returns {string}
 */
function renderPrompt(config, overrides = {}) {
  const { text } = readPromptFile(config)
  return buildPromptText({
    raw: text,
    identity: config.identity,
    includeIdentity: config.includeIdentity,
    stripDynamicTail: config.stripDynamicTail,
    dropSections: config.dropSections,
    toolNames: config.toolNames,
    rewrites: config.rewrites,
    ...overrides,
  })
}

test('stripDynamicTail removes the frozen token counter', () => {
  const input = '# Body\n\ntext\n\n<total_tokens>15000000 tokens left</total_tokens>'
  assert.equal(stripDynamicTail(input), '# Body\n\ntext')

  // A prompt without the marker is only trailing-trimmed.
  assert.equal(stripDynamicTail('# Body\n\ntext   \n\n'), '# Body\n\ntext')
})

test('stripDynamicTail removes the marker mid-text too', () => {
  const input = 'a\n<total_tokens>12 tokens left</total_tokens>\nb'
  assert.equal(stripDynamicTail(input), 'a\nb')
})

test('splitH1Sections keeps the preamble and nests H2 under its H1', () => {
  const chunks = splitH1Sections('preamble\n# One\ntext\n## Sub\nmore\n# Two\nlast\n')
  assert.deepEqual(
    chunks.map((chunk) => chunk.heading),
    [null, 'one', 'two'],
  )
  assert.match(chunks[1].text, /## Sub/)
})

test('dropHeadingSections matches whole-word runs, including qualifiers', () => {
  const prompt = 'pre\n# Memory\nmem body\n# auto memory\nmore\n# Environment\nenv\n'

  assert.equal(dropHeadingSections(prompt, ['memory']), 'pre\n# Environment\nenv\n')
  assert.equal(dropHeadingSections(prompt, ['auto memory']), 'pre\n# Memory\nmem body\n# Environment\nenv\n')
  assert.equal(dropHeadingSections(prompt, []), prompt)
  // Unknown names never mangle the prompt.
  assert.equal(dropHeadingSections(prompt, ['nonsense']), prompt)
})

test('mapToolNames replaces whole words only, in one pass', () => {
  const input = 'Prefer Read over PowerShell; Reading is fine. Agent, Agentic Reading.'
  const output = mapToolNames(input, { Read: 'read', PowerShell: 'pwsh', Agent: 'subagent' })

  assert.equal(output, 'Prefer read over pwsh; Reading is fine. subagent, Agentic Reading.')
})

test('mapToolNames never chains one replacement into another', () => {
  // If replacements were applied sequentially, A -> B would then become C.
  assert.equal(mapToolNames('A B', { A: 'B', B: 'C' }), 'B C')
})

test('mapToolNames ignores identity mappings and empty targets', () => {
  assert.equal(mapToolNames('Read', { Read: 'Read' }), 'Read')
  assert.equal(mapToolNames('Read', { Read: '' }), 'Read')
})

test('composePrompt mirrors the system[] block layout', () => {
  assert.equal(composePrompt({ body: 'body', identity: 'who' }), 'who\n\nbody')
  assert.equal(composePrompt({ body: 'body', identity: 'who', includeIdentity: false }), 'body')
  assert.equal(composePrompt({ body: 'body', identity: '   ' }), 'body')
})

test('DSH tool map covers every tool named in the vendored prompts', () => {
  assert.deepEqual(Object.keys(DSH_TOOL_NAMES).sort(), [
    'Agent',
    'Edit',
    'Glob',
    'Grep',
    'PowerShell',
    'Read',
    'Skill',
    'TaskCreate',
    'Write',
  ])
})

test('normalizeConfig rejects unknown variants and tool modes', () => {
  assert.throws(() => normalizeConfig({ variant: 'nope' }), /unknown variant/)
  assert.throws(() => normalizeConfig({ toolNames: 'nope' }), /unknown toolNames mode/)
  // promptPath overrides the variant check entirely.
  assert.doesNotThrow(() => normalizeConfig({ variant: 'nope', promptPath: 'x.md' }))
})

test('normalizeConfig coerces YAML-ish values', () => {
  const config = normalizeConfig({
    enabled: 'yes',
    includeIdentity: 'no',
    dropSections: 'memory',
    keepSections: [' a ', '', 3],
    toolNames: 'verbatim',
    identityOrder: '7',
  })

  assert.equal(config.enabled, true) // only an explicit false disables
  assert.equal(config.includeIdentity, true) // only an explicit false disables
  assert.deepEqual(config.dropSections, ['memory'])
  assert.deepEqual(config.keepSections, ['a'])
  assert.deepEqual(config.toolNames, {})
  assert.equal(config.identityOrder, 7)
})

test('cli prompt: memory dropped, counter stripped, tools renamed, sentences rewritten', () => {
  const config = normalizeConfig({})
  const output = renderPrompt(config)

  assert.ok(output.startsWith(config.identity), 'identity leads the prompt')
  assert.ok(!/total_tokens/.test(output), 'dynamic counter is gone')
  assert.ok(!/^# (auto )?memory$/im.test(output), 'memory section is gone')
  assert.ok(!/\.cc-cfg/.test(output), 'capturing machine path is gone')
  assert.ok(output.includes('Prefer dedicated tools over pwsh when one fits (read, edit, write, glob, grep)'))
  assert.ok(output.includes('Use todo_write to plan and track work'))
  assert.ok(output.includes('Calling subagent_fork creates a fork of the current conversation'))
  assert.ok(!/PowerShell|TaskCreate/.test(output), 'no Claude Code tool names survive')
})

test('vscode prompt: shorter variant, "# Harness" instead of "# System"', () => {
  const config = normalizeConfig({ variant: 'vscode' })
  const output = renderPrompt(config)

  assert.ok(output.includes('# Harness'))
  assert.ok(!output.includes('# System'))
  assert.ok(output.length < 6000, `expected the compact variant, got ${output.length} chars`)
})

test('verbatim mode leaves Claude Code tool names in place', () => {
  const config = normalizeConfig({ toolNames: 'verbatim' })
  const output = renderPrompt(config)

  assert.ok(output.includes('Prefer dedicated tools over PowerShell'))
  assert.ok(output.includes('Use TaskCreate to plan and track work.'))
})

test('cli prompt keeps literal double braces (interpolation must stay off)', () => {
  const config = normalizeConfig({})
  const { text } = readPromptFile(config)
  assert.ok(/\{\{/.test(text), 'the vendored CLI prompt is expected to contain {{…}}')
  assert.ok(/\{\{/.test(buildPromptText({ raw: text, stripDynamicTail: true })))
})

const VARIANTS = ['cli', 'vscode']

// Sentences that describe the real Claude Code product rather than this harness.
// The vendored prompt carries them until the rewrite layer strips them, and none
// of them may reach the model.
const CLAUDE_CODE_ONLY_TEXT = [
  'subagent_type',
  'anthropics/claude-code',
  'claude.ai/code',
  'Fast mode for Claude Code',
  'claude-opus-5-5',
]

test('default rewrites strip every Claude-Code-only reference from both variants', () => {
  for (const variant of VARIANTS) {
    const output = renderPrompt(normalizeConfig({ variant }))
    for (const needle of CLAUDE_CODE_ONLY_TEXT) {
      assert.ok(!output.includes(needle), `${variant}: "${needle}" survived the default rewrites`)
    }
    assert.ok(!output.includes('# Environment'), `${variant}: empty "# Environment" section left behind`)
  }
})

test('default rewrites fire where the vendored text has them', () => {
  const cli = renderPrompt(normalizeConfig({ variant: 'cli' }))
  assert.ok(cli.includes('Calling subagent_fork creates a fork of the current conversation'))
  assert.ok(cli.includes('- /help: run `dsh --help` in a shell for the harness command line help.'))
  assert.ok(cli.includes('- To report a problem, open an issue on the harness repository.'))
  assert.ok(cli.includes('**If you ARE the fork** — execute directly; do not re-delegate.'))

  // The compact variant has none of those three lines, so the same rewrites must
  // stay no-ops there instead of inventing text.
  const vscode = renderPrompt(normalizeConfig({ variant: 'vscode' }))
  assert.ok(!vscode.includes('dsh --help'))
  assert.ok(!vscode.includes('open an issue on the harness repository'))
  assert.ok(!vscode.includes('subagent_fork'))
})

test('every default rewrite matches the prompt it was written for', () => {
  const renamedBody = (variant) => {
    const config = normalizeConfig({ variant })
    const { text } = readPromptFile(config)
    return mapToolNames(stripDynamicTail(dropHeadingSections(text, config.dropSections)), config.toolNames)
  }

  // Order matters: the "# Environment" cleanup only matches once the three bullets
  // underneath it are gone, so replay the list entry by entry rather than all at once.
  let cli = renamedBody('cli')
  DEFAULT_REWRITES.forEach(({ pattern, flags, replace }, index) => {
    const next = cli.replace(new RegExp(pattern, flags ?? 'g'), replace)
    assert.notEqual(next, cli, `default rewrite #${index} no longer matches prompt/claude-code-cli.md: ${pattern}`)
    cli = next
  })

  let vscode = renamedBody('vscode')
  for (const index of [3, 4, 5, 6]) {
    const { pattern, flags, replace } = DEFAULT_REWRITES[index]
    const next = vscode.replace(new RegExp(pattern, flags ?? 'g'), replace)
    assert.notEqual(next, vscode, `default rewrite #${index} no longer matches prompt/claude-code-vscode.md`)
    vscode = next
  }
  for (const index of [0, 1, 2]) {
    const { pattern, flags, replace } = DEFAULT_REWRITES[index]
    assert.equal(
      vscode.replace(new RegExp(pattern, flags ?? 'g'), replace),
      vscode,
      `default rewrite #${index} is CLI-only and must not touch the compact prompt`,
    )
  }
})

test('rewrites: false leaves the Claude-Code-only text in place', () => {
  const config = normalizeConfig({ rewrites: false })
  assert.deepEqual(config.rewrites, [])
  const output = renderPrompt(config)

  for (const needle of CLAUDE_CODE_ONLY_TEXT) {
    assert.ok(output.includes(needle), `"${needle}" must survive when the layer is disabled`)
  }
  assert.ok(output.includes('# Environment'))
})

test('a configured rewrite list replaces the defaults', () => {
  // REPLACE, not extend: the defaults patch one Claude Code release, and a
  // configured list has to explain the whole output on its own.
  const configured = [{ pattern: 'Claude Code', replace: 'the harness' }]
  const config = normalizeConfig({ rewrites: configured })
  assert.deepEqual(config.rewrites, configured)

  const output = renderPrompt(config)
  assert.ok(output.includes('the harness'))
  assert.ok(!output.includes('Claude Code'), 'the custom list rewrites every occurrence')
  assert.ok(output.includes('subagent_type'), 'the default fork rewrite must not run')
  assert.ok(!output.includes('dsh --help'), 'the default /help rewrite must not run')
  assert.ok(output.includes('# Environment'), 'the default Environment cleanup must not run')
})

test('rewrite cleanup leaves no triple newlines or edge blank lines', () => {
  const output = renderPrompt(normalizeConfig({}), { includeIdentity: false, identity: '' })
  assert.ok(!/(?:\r\n|\n){3,}/.test(output), 'runs of 3+ newlines are collapsed')
  assert.ok(!/^[ \t]*\r?\n/.test(output), 'no leading blank line')
  assert.ok(!/\r?\n[ \t]*$/.test(output), 'no trailing blank line')
})

test('applyRewrites runs in order, defaults to the g flag and supports $1', () => {
  const ordered = [
    { pattern: '^a (b)$', replace: 'x $1' },
    { pattern: 'b', replace: 'c' },
  ]
  assert.equal(applyRewrites('a b', ordered), 'x c')

  const text = 'a\r\n\r\n\r\n\r\nb'
  assert.equal(applyRewrites(text, []), text, 'an empty list must not touch the text')
})

test('buildPromptText rewrites nothing unless given a list', () => {
  const config = normalizeConfig({})
  const { text } = readPromptFile(config)
  const output = buildPromptText({ raw: text, dropSections: config.dropSections, toolNames: config.toolNames })

  assert.ok(output.includes('subagent_type'))
  assert.ok(output.includes('# Environment'))
})

test('invalid rewrite config fails at normalize time and names the pattern', () => {
  assert.throws(
    () => normalizeConfig({ rewrites: [{ pattern: 'Calling (', replace: '' }] }),
    /invalid rewrite pattern "Calling \("/,
    'the message must quote the offending pattern',
  )
  assert.throws(() => normalizeConfig({ rewrites: 'no' }), /rewrites must be false or an array/)
  assert.throws(() => normalizeConfig({ rewrites: [{}] }), /rewrites\[0\]\.pattern must be a non-empty string/)
  assert.throws(
    () => normalizeConfig({ rewrites: [{ pattern: 'x', replace: 1 }] }),
    /rewrites\[0\]\.replace must be a string/,
  )
  assert.throws(
    () => normalizeConfig({ rewrites: [{ pattern: 'x', flags: 7 }] }),
    /rewrites\[0\]\.flags must be a string/,
  )
})
