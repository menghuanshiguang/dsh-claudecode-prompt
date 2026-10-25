/**
 * Unit tests for the pure text layer: no Harness runtime required.
 *
 * Run with `npm run test:transform` (or `node --test test/`).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeConfig, readPromptFile, DSH_TOOL_NAMES } from '../lib/config.js'
import {
  buildPromptText,
  composePrompt,
  dropHeadingSections,
  mapToolNames,
  splitH1Sections,
  stripDynamicTail,
} from '../lib/transform.js'

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

test('cli prompt: memory dropped, counter stripped, tools renamed', () => {
  const config = normalizeConfig({})
  const { text } = readPromptFile(config)
  const output = buildPromptText({
    raw: text,
    identity: config.identity,
    includeIdentity: config.includeIdentity,
    stripDynamicTail: config.stripDynamicTail,
    dropSections: config.dropSections,
    toolNames: config.toolNames,
  })

  assert.ok(output.startsWith(config.identity), 'identity leads the prompt')
  assert.ok(!/total_tokens/.test(output), 'dynamic counter is gone')
  assert.ok(!/^# (auto )?memory$/im.test(output), 'memory section is gone')
  assert.ok(!/\.cc-cfg/.test(output), 'capturing machine path is gone')
  assert.ok(output.includes('Prefer dedicated tools over pwsh when one fits (read, edit, write, glob, grep)'))
  assert.ok(output.includes('Use todo_write to plan and track work'))
  assert.ok(output.includes('Calling subagent with subagent_type: "fork"'))
  assert.ok(!/PowerShell|TaskCreate/.test(output), 'no Claude Code tool names survive')
})

test('vscode prompt: shorter variant, "# Harness" instead of "# System"', () => {
  const config = normalizeConfig({ variant: 'vscode' })
  const { text } = readPromptFile(config)
  const output = buildPromptText({
    raw: text,
    identity: config.identity,
    includeIdentity: config.includeIdentity,
    stripDynamicTail: config.stripDynamicTail,
    dropSections: config.dropSections,
    toolNames: config.toolNames,
  })

  assert.ok(output.includes('# Harness'))
  assert.ok(!output.includes('# System'))
  assert.ok(output.length < 6000, `expected the compact variant, got ${output.length} chars`)
})

test('verbatim mode leaves Claude Code tool names in place', () => {
  const config = normalizeConfig({ toolNames: 'verbatim' })
  const { text } = readPromptFile(config)
  const output = buildPromptText({ raw: text, dropSections: config.dropSections, toolNames: config.toolNames })

  assert.ok(output.includes('Prefer dedicated tools over PowerShell'))
  assert.ok(output.includes('Use TaskCreate to plan and track work.'))
})

test('cli prompt keeps literal double braces (interpolation must stay off)', () => {
  const config = normalizeConfig({})
  const { text } = readPromptFile(config)
  assert.ok(/\{\{/.test(text), 'the vendored CLI prompt is expected to contain {{…}}')
  assert.ok(/\{\{/.test(buildPromptText({ raw: text, stripDynamicTail: true })))
})
