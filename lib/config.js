/**
 * Configuration surface and prompt-file resolution.
 *
 * Harness rows are configured from `cordis.patch.yml`, and this plugin must work
 * whether the profile links the package or copies it — so, exactly like other
 * local prompt plugins, it has no runtime dependency: the schema is plain JS
 * normalization instead of a `schemastery` import.
 *
 * @module dsh-claudecode-prompt/config
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Claude Code's identity block for non-interactive (SDK / `claude -p`) runs — the
 * second entry of the captured `system[]` array, verbatim:
 *
 *   "You are a Claude agent, built on Anthropic's Claude Agent SDK."
 *
 * Interactive TTY runs use `You are Claude Code, Anthropic's official CLI for
 * Claude.` instead. A VSCode session is a non-interactive client, so this is the
 * line that actually reaches the model there; override with `identity` if you
 * want the interactive wording.
 */
export const DEFAULT_IDENTITY =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK."

/** Built-in prompt variants shipped with the package. */
export const VARIANTS = {
  cli: './prompt/claude-code-cli.md',
  vscode: './prompt/claude-code-vscode.md',
}

/**
 * Claude Code tool name -> Harness tool name.
 *
 * Deliberately limited to the names that actually appear in the static prompt
 * (see `grep -n 'Read\|Edit\|Write\|Glob\|Grep\|PowerShell\|TaskCreate\|Agent\|Skill'`
 * over `prompt/claude-code-cli.md`). `verbatim` disables the mapping entirely.
 */
export const DSH_TOOL_NAMES = {
  PowerShell: 'pwsh',
  Read: 'read',
  Edit: 'edit',
  Write: 'write',
  Glob: 'glob',
  Grep: 'grep',
  TaskCreate: 'todo_write',
  Agent: 'subagent',
  Skill: 'skill',
}

/**
 * Sections Claude Code keeps in its static prompt that have no counterpart in
 * Harness. Dropped by default:
 *
 *  - `memory` / `auto memory`: Claude Code's file-based memory store, including
 *    an absolute directory captured from *this* machine. Harness has no such
 *    store, so keeping the text would have the model write to a dead path.
 */
export const DEFAULT_DROPPED_SECTIONS = ['memory']

/** @typedef {ReturnType<typeof normalizeConfig>} ResolvedConfig */

/**
 * Fill in defaults and coerce loosely-typed YAML values.
 *
 * @param {Record<string, unknown>} [raw]
 * @param {{ cwd?: string }} [options]
 * @returns {object}
 */
export function normalizeConfig(raw = {}, { cwd = process.cwd() } = {}) {
  const source = raw ?? {}
  const variant = String(source.variant ?? 'cli').trim().toLowerCase()
  if (!(variant in VARIANTS) && !source.promptPath) {
    throw new Error(
      `[dsh-claudecode-prompt] unknown variant "${variant}" — use one of ${Object.keys(VARIANTS).join(', ')} or set promptPath`,
    )
  }

  const toolNamesMode = String(source.toolNames ?? 'dsh').trim().toLowerCase()
  let toolNames = {}
  if (toolNamesMode === 'dsh') {
    toolNames = { ...DSH_TOOL_NAMES, ...(isPlainObject(source.toolNameMap) ? source.toolNameMap : {}) }
  } else if (toolNamesMode === 'verbatim') {
    toolNames = isPlainObject(source.toolNameMap) ? { ...source.toolNameMap } : {}
  } else if (isPlainObject(toolNamesMode)) {
    // tolerate a raw object in the `toolNames` slot
    toolNames = { ...toolNamesMode }
  } else {
    throw new Error(
      `[dsh-claudecode-prompt] unknown toolNames mode "${toolNamesMode}" — use "dsh" or "verbatim"`,
    )
  }

  const promptPath = typeof source.promptPath === 'string' && source.promptPath.trim()
    ? (isAbsolute(source.promptPath.trim())
        ? source.promptPath.trim()
        : resolve(cwd, source.promptPath.trim()))
    : null

  return {
    enabled: source.enabled !== false,
    debug: source.debug === true,
    variant,
    promptPath,
    identity: typeof source.identity === 'string' ? source.identity : DEFAULT_IDENTITY,
    includeIdentity: source.includeIdentity !== false,
    stripDynamicTail: source.stripDynamicTail !== false,
    dropSections: toStringArray(source.dropSections, DEFAULT_DROPPED_SECTIONS),
    toolNames,
    toolNamesMode,
    keepSections: toStringArray(source.keepSections, []),
    sectionPrefix: nonEmptyString(source.sectionPrefix, 'claudecode'),
    identityOrder: finiteNumber(source.identityOrder, 100),
    promptOrder: finiteNumber(source.promptOrder, 950),
  }
}

/**
 * Read the raw captured prompt body for a resolved config.
 *
 * @param {object} config  Output of {@link normalizeConfig}.
 * @returns {{ text: string, source: string }}
 */
export function readPromptFile(config) {
  const source = config.promptPath ?? fileURLToPath(new URL(VARIANTS[config.variant], import.meta.url))
  let text
  try {
    text = readFileSync(source, 'utf8')
  } catch (error) {
    throw new Error(
      `[dsh-claudecode-prompt] cannot read prompt file ${source}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (text.trim() === '') {
    throw new Error(`[dsh-claudecode-prompt] prompt file ${source} is empty`)
  }
  return { text, source }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} value
 * @param {string[]} fallback
 * @returns {string[]}
 */
function toStringArray(value, fallback) {
  if (value === null || value === undefined) return [...fallback]
  if (typeof value === 'string') {
    const single = value.trim()
    return single === '' ? [] : [single]
  }
  if (!Array.isArray(value)) return [...fallback]
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function nonEmptyString(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function finiteNumber(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : fallback
}
