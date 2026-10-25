/**
 * Text transforms applied to a captured Claude Code system prompt before it is
 * handed to DeepSeek Harness.
 *
 * Everything here is pure string -> string and side-effect free, so the whole
 * normalization is unit-testable without any Harness runtime. The vendored
 * prompt files under `prompt/` are kept byte-exact; every rewrite below is an
 * explicit, configurable step instead of a pre-edited file, so a reader can diff
 * "what Anthropic ships" against "what this plugin sends".
 *
 * @module dsh-claudecode-prompt/transform
 */

/**
 * Claude Code appends its live remaining-context counter to the system prompt on
 * every request, e.g. `<total_tokens>15000000 tokens left</total_tokens>`.
 * A captured copy therefore freezes one machine's number; it is meaningless (and
 * actively wrong) inside Harness, which reports its own budget elsewhere.
 */
const TOTAL_TOKENS_TAG = /[ \t]*<total_tokens>[\s\S]*?<\/total_tokens>[ \t]*\r?\n?/g

/**
 * Remove every `<total_tokens>…</total_tokens>` marker and normalize trailing
 * whitespace.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripDynamicTail(text) {
  return String(text ?? '')
    .replace(TOTAL_TOKENS_TAG, '')
    .trimEnd()
}

/**
 * Split a markdown prompt into H1-delimited chunks.
 *
 * The returned array keeps the preamble (any text before the first `# `) as a
 * chunk with `heading: null`. `## ` sub-headings stay inside their parent chunk,
 * which is what section dropping needs: `# auto memory` must take
 * `## Types of memory` and friends with it.
 *
 * @param {string} text
 * @returns {{ heading: string | null, text: string }[]}
 */
export function splitH1Sections(text) {
  const source = String(text ?? '')
  /** @type {{ heading: string | null, text: string }[]} */
  const chunks = []
  for (const part of source.split(/(?=^# )/m)) {
    if (part === '') continue
    const match = /^# (.+)$/m.exec(part)
    const isH1 = part.startsWith('# ')
    chunks.push({
      heading: isH1 && match ? match[1].trim().toLowerCase() : null,
      text: part,
    })
  }
  return chunks
}

/**
 * Split a heading (or a configured name) into comparable word tokens.
 *
 * @param {string} value
 * @returns {string[]}
 */
function wordTokens(value) {
  return String(value ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0)
}

/**
 * True when `name` appears in `heading` as a contiguous run of whole words.
 *
 * This is what makes a short, release-proof entry like `memory` match both
 * `# Memory` and `# auto memory` without turning a bare substring test loose on
 * the prompt (where `memory` would also match `# Memory management`, but `read`
 * would not match `# Reading files`… which it does, as a whole word — hence
 * defaults are phrased carefully and the list is fully user-controlled).
 *
 * @param {string} heading
 * @param {string} name
 * @returns {boolean}
 */
function headingMatches(heading, name) {
  const haystack = wordTokens(heading)
  const needle = wordTokens(name)
  if (needle.length === 0) return false
  if (needle.length > haystack.length) return false
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matched = true
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false
        break
      }
    }
    if (matched) return true
  }
  return false
}

/**
 * Drop whole H1 sections whose heading contains a configured name (whole-word
 * match, case-insensitive, `# ` prefix not included). Unknown names are ignored,
 * so a list written for one Claude Code release keeps working after Anthropic
 * renames a section.
 *
 * @param {string} text
 * @param {string[]} names
 * @returns {string}
 */
export function dropHeadingSections(text, names) {
  const drop = (names ?? [])
    .map((name) => String(name ?? '').trim())
    .filter((name) => name.length > 0)
  if (drop.length === 0) return String(text ?? '')

  const kept = splitH1Sections(text).filter(
    (chunk) => chunk.heading === null || !drop.some((name) => headingMatches(chunk.heading, name)),
  )
  return kept.map((chunk) => chunk.text).join('')
}

/**
 * Escape a literal string for use inside a RegExp.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Rename tools inside prompt prose so the model is told about the tools it
 * actually has.
 *
 * The Claude Code prompt names its own tool set (`PowerShell`, `Read`, `Agent`,
 * …). Harness exposes different names (`pwsh`, `read`, `subagent`, …), and a
 * prompt that instructs the model to "prefer Read over PowerShell" while neither
 * exists produces confidently wrong narration. Only a handful of tool names ever
 * appear in the static prompt, and they are replaced in a single regex pass so
 * one rename can never feed another (no `Read` -> `read` -> … cascade).
 *
 * @param {string} text
 * @param {Record<string, string>} mapping  Claude Code name -> Harness name.
 * @returns {string}
 */
export function mapToolNames(text, mapping) {
  const entries = Object.entries(mapping ?? {}).filter(
    ([from, to]) =>
      typeof from === 'string' &&
      from.length > 0 &&
      typeof to === 'string' &&
      to.length > 0 &&
      from !== to,
  )
  if (entries.length === 0) return String(text ?? '')

  const ordered = entries.sort((a, b) => b[0].length - a[0].length)
  const alternation = ordered.map(([from]) => escapeRegExp(from)).join('|')
  const table = new Map(entries)
  return String(text ?? '').replace(
    new RegExp(`\\b(?:${alternation})\\b`, 'g'),
    (match) => table.get(match) ?? match,
  )
}

/**
 * Compose the final system prompt text from an identity line and a body.
 *
 * Mirrors Claude Code's own layout, where `system[]` carries the identity as its
 * own block ahead of the instructions. Harness renders sections joined by a blank
 * line, so the two blocks are concatenated the same way here.
 *
 * @param {{ body: string, identity?: string, includeIdentity?: boolean }} options
 * @returns {string}
 */
export function composePrompt({ body, identity = '', includeIdentity = true }) {
  const trimmedBody = String(body ?? '').trim()
  if (!includeIdentity) return trimmedBody
  const trimmedIdentity = String(identity ?? '').trim()
  if (trimmedIdentity === '') return trimmedBody
  return `${trimmedIdentity}\n\n${trimmedBody}`
}

/**
 * Run the full transform chain in the documented order.
 *
 * Order matters: drop sections first (so a dropped section cannot contribute a
 * tool name that then gets renamed), then strip the dynamic tail, then rename
 * tools, then compose.
 *
 * @param {object} options
 * @param {string} options.raw                Captured prompt body.
 * @param {string} [options.identity]
 * @param {boolean} [options.includeIdentity]
 * @param {boolean} [options.stripDynamicTail]  Defaults to true.
 * @param {string[]} [options.dropSections]
 * @param {Record<string, string>} [options.toolNames]
 * @returns {string}
 */
export function buildPromptText({
  raw,
  identity = '',
  includeIdentity = true,
  stripDynamicTail: strip = true,
  dropSections = [],
  toolNames = {},
}) {
  let text = String(raw ?? '')
  text = dropHeadingSections(text, dropSections)
  if (strip) text = stripDynamicTail(text)
  text = mapToolNames(text, toolNames)
  return composePrompt({ body: text, identity, includeIdentity })
}
