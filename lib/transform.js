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
 * @typedef {object} Rewrite
 * @property {string} pattern   RegExp source, applied with a global flag by default.
 * @property {string} replace   Replacement text; `$1`… expand capture groups.
 * @property {string} [flags]   Defaults to `g`.
 */

/**
 * Whole-sentence fixes applied after {@link mapToolNames}.
 *
 * Renaming a tool word is not enough where Claude Code's sentence describes
 * something Harness does not have: `subagent_type: "fork"` is a Claude Code tool
 * argument, `/help` is its TUI command, the feedback URL and the model-ID advice
 * point at Anthropic, and `/fast` is its own toggle. A prompt that tells the model
 * to use any of those produces confidently wrong behaviour, so those lines are
 * rewritten or deleted instead of renamed.
 *
 * Patterns are written against the POST-rename text but accept both spellings of
 * the fork tool (`subagent` and verbatim `Agent`), so `toolNames: 'verbatim'` still
 * loses the argument it cannot have. They tolerate CRLF, because the vendored
 * captures use CRLF. A rule written for one Claude Code release simply stops
 * matching after Anthropic rewords a sentence — it can never corrupt unrelated text.
 *
 * @type {Rewrite[]}
 */
export const DEFAULT_REWRITES = [
  {
    // Deletes the second half of the same bullet too: "Other subagent_type values
    // start fresh agents" is meaningless once the argument is gone.
    pattern:
      '^([ \\t]*)-[ \\t]*Calling[ \\t]+(?:sub)?agent[ \\t]+with[ \\t]+subagent_type:[^\\r\\n]*?creates[ \\t]+a[ \\t]+fork[^\\r\\n]*',
    flags: 'gim',
    replace:
      "$1- Calling subagent_fork creates a fork of the current conversation — it inherits your full conversation context and keeps its tool output out of your context. Reach for it when research or multi-step implementation work would otherwise fill your context with raw output you won't need again. **If you ARE the fork** — execute directly; do not re-delegate.",
  },
  {
    pattern: '^([ \\t]*)-[ \\t]*/help:[^\\r\\n]*',
    flags: 'gim',
    replace: '$1- /help: run `dsh --help` in a shell for the harness command line help.',
  },
  {
    pattern: '^([ \\t]*)-[ \\t]*To give feedback,[^\\r\\n]*',
    flags: 'gim',
    replace: '$1- To report a problem, open an issue on the harness repository.',
  },
  {
    // The three Environment bullets below exist only in Claude Code's product, so
    // the whole line goes — including its newline, or deleting it would leave a
    // blank line behind.
    pattern: '^[ \\t]*-[ \\t]*Claude Code is available as a CLI[^\\r\\n]*(?:\\r?\\n)?',
    flags: 'gim',
    replace: '',
  },
  {
    pattern: '^[ \\t]*-[ \\t]*Fast mode for Claude Code[^\\r\\n]*(?:\\r?\\n)?',
    flags: 'gim',
    replace: '',
  },
  {
    // Harness runs DeepSeek models; advising Anthropic model IDs would leak into
    // code the model writes for the user.
    pattern: '^[ \\t]*-[ \\t]*The most recent Claude models are the Claude 5 family[^\\r\\n]*(?:\\r?\\n)?',
    flags: 'gim',
    replace: '',
  },
  {
    // Consequence of the deletions above: `# Environment` keeps its heading but
    // loses every bullet, and an empty heading is an artifact of this layer, not
    // of the captured prompt. Only matches when nothing but a heading follows.
    pattern: '^#[ \\t]*Environment[ \\t]*(?:\\r?\\n)+(?=# )',
    flags: 'gm',
    replace: '',
  },
]

/**
 * Compile a rewrite list into RegExp objects.
 *
 * Compiling happens per assembly call so the config surface stays plain JSON (a
 * `RegExp` does not survive the YAML round-trip); `normalizeConfig` runs the same
 * function up front, so a syntax error is reported once at boot with the pattern
 * quoted, instead of throwing while the prompt is being assembled.
 *
 * @param {Rewrite[]} [rewrites]
 * @returns {{ pattern: string, regex: RegExp, replace: string }[]}
 */
export function compileRewrites(rewrites = []) {
  return (rewrites ?? []).map((rewrite) => {
    const pattern = typeof rewrite?.pattern === 'string' ? rewrite.pattern : String(rewrite?.pattern ?? '')
    const flags = typeof rewrite?.flags === 'string' ? rewrite.flags : 'g'
    const replace = typeof rewrite?.replace === 'string' ? rewrite.replace : ''
    try {
      return { pattern, regex: new RegExp(pattern, flags), replace }
    } catch (error) {
      throw new Error(
        `[dsh-claudecode-prompt] invalid rewrite pattern ${JSON.stringify(pattern)}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })
}

/**
 * Apply sentence rewrites in order, then clean up the blank lines they leave.
 *
 * @param {string} text
 * @param {Rewrite[]} [rewrites]
 * @returns {string}
 */
export function applyRewrites(text, rewrites = []) {
  const compiled = compileRewrites(rewrites)
  // No list means no layer: return the text byte-exact, cleanup included, so
  // `rewrites: false` cannot alter the prompt it was told not to touch.
  if (compiled.length === 0) return String(text ?? '')

  let output = String(text ?? '')
  for (const { regex, replace } of compiled) {
    output = output.replace(regex, replace)
  }
  return normalizeBlankLines(output)
}

/**
 * Collapse the blank-line debris a deletion leaves behind.
 *
 * Removing a line or a paragraph makes its neighbours adjacent; without this the
 * assembled prompt ends up with doubled blank lines. Three or more newlines always
 * mean one blank line too many, and leading/trailing blank lines are pure noise in
 * a section — so normalize both. The file's own EOL style is preserved, since the
 * vendored captures are CRLF.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeBlankLines(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  return text
    .replace(/(?:[ \t]*\r?\n){3,}/g, `${eol}${eol}`)
    .replace(/^(?:[ \t]*\r?\n)+/, '')
    .replace(/(?:[ \t]*\r?\n)+$/, '')
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
 * tools, then apply sentence rewrites — the rewrite patterns are written against
 * the renamed text, because that is the text the model would read — then compose.
 *
 * `rewrites` defaults to `[]` on purpose: this function stays a pure text layer,
 * and the defaults are injected by the config layer (`DEFAULT_REWRITES`), so a
 * caller that only wants tool renaming is never surprised by deleted sentences.
 *
 * @param {object} options
 * @param {string} options.raw                Captured prompt body.
 * @param {string} [options.identity]
 * @param {boolean} [options.includeIdentity]
 * @param {boolean} [options.stripDynamicTail]  Defaults to true.
 * @param {string[]} [options.dropSections]
 * @param {Record<string, string>} [options.toolNames]
 * @param {Rewrite[]} [options.rewrites]
 * @returns {string}
 */
export function buildPromptText({
  raw,
  identity = '',
  includeIdentity = true,
  stripDynamicTail: strip = true,
  dropSections = [],
  toolNames = {},
  rewrites = [],
}) {
  let text = String(raw ?? '')
  text = dropHeadingSections(text, dropSections)
  if (strip) text = stripDynamicTail(text)
  text = mapToolNames(text, toolNames)
  text = applyRewrites(text, rewrites)
  return composePrompt({ body: text, identity, includeIdentity })
}
