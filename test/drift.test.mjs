/**
 * Drift tests for the two copies this plugin keeps of somebody else's data.
 *
 *  A. `KNOWN_SECTION_ORDERS` in `index.js` is a hardcoded copy of the
 *     `SECTION_ORDERS` constants of `@deepseek-ai/dsh-system-prompt`. If the
 *     harness renames a section or moves an order, the plugin keeps placing the
 *     kept sections at the old slots and nothing throws. The package file is
 *     located via `DSH_SYSTEM_PROMPT_LIB`, then `$DSH_CHECKOUT` (or the local
 *     install), then the local install again — the local install lives inside an
 *     `app.asar` archive, which plain Node cannot open with `readFileSync`, so
 *     the archive header is parsed by hand (`readAsarEntry`); a candidate that
 *     cannot be read at all is a skip, never a failure (CI has neither DSH nor
 *     the archive).
 *
 *  B. `prompt/*.md` are vendored captures of the Claude Code prompt. `prompt/
 *     VERSION.json` records their sha256/bytes/lines and the extension version
 *     they were captured from. Both are checked against what is on disk and, when
 *     a Claude Code VS Code extension is installed, against its version.
 *
 * Both checks skip cleanly on a machine that has neither DSH nor Claude Code.
 *
 * Run with `node --test test/drift.test.mjs`.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Relative path of the package file inside a DSH checkout. */
const PACKAGE_LIB = 'node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js'

/** Install location of the harness on this machine. */
const LOCAL_CHECKOUT = 'D:/DSHPC/resources/app.asar/dsh'

/** Root of the VS Code extensions directory holding the Claude Code extension. */
const VSCODE_EXTENSIONS = 'C:/Users/fantasytat/.vscode/extensions'

/** Directory name prefix of the Claude Code extension. */
const EXTENSION_PREFIX = 'anthropic.claude-code-'

/** `key: value` row of a generated `const NAME = { … }` table; value may be `-1e3`. */
const ORDER_ENTRY =
  /(?:'([^'\n]*)'|"([^"\n]*)"|([A-Za-z_$][\w$]*))\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

/**
 * @param {string} path
 * @returns {string | null}
 */
function readTextOrNull(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    // ENOENT, ENOTDIR and EISDIR are all expected: the known install path points
    // inside an app.asar archive, which only Electron's patched fs can open.
    return null
  }
}

/**
 * Read one file out of an `.asar` archive with plain Node.
 *
 * An asar is two Chromium pickles followed by the blobs: `[uint32 4][uint32
 * headerPickleSize]`, then the header pickle (`uint32 payloadSize`, the JSON
 * tree, padding), then every file at `blobStart + entry.offset`. Electron's
 * patched fs is what normally reads this, and `node --test` does not have it, so
 * the forty lines live here instead of turning the drift check into a permanent
 * skip on the one machine that has DSH installed.
 *
 * @param {string} archive
 * @param {string} entryPath slash-separated path inside the archive
 * @returns {string | null}
 */
function readAsarEntry(archive, entryPath) {
  /** @type {number | undefined} */
  let fd
  try {
    fd = openSync(archive, 'r')
    const head = Buffer.alloc(8)
    if (readSync(fd, head, 0, 8, 0) !== 8) return null
    const headerPickleSize = head.readUInt32LE(4)
    if (headerPickleSize <= 0 || headerPickleSize > 64 * 1024 * 1024) return null
    const headerPickle = Buffer.alloc(headerPickleSize)
    if (readSync(fd, headerPickle, 0, headerPickleSize, 8) !== headerPickleSize) return null
    // Chromium pickle: [uint32 payloadSize][uint32 stringLength][json…][padding].
    const jsonSize = headerPickle.readUInt32LE(4)
    if (jsonSize <= 0 || jsonSize > headerPickleSize - 8) return null
    const header = JSON.parse(headerPickle.toString('utf8', 8, 8 + jsonSize))

    /** @type {any} */
    let node = header
    for (const part of entryPath.split('/')) {
      node = node?.files?.[part]
      if (!node) return null
    }
    if (node.unpacked || typeof node.size !== 'number') return null
    const offset = Number(node.offset)
    if (!Number.isFinite(offset)) return null

    const blob = Buffer.alloc(node.size)
    const blobStart = 8 + headerPickleSize
    if (readSync(fd, blob, 0, node.size, blobStart + offset) !== node.size) return null
    return blob.toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Read a candidate path that may live in a directory or inside an `.asar`.
 *
 * @param {string} candidate
 * @returns {string | null}
 */
function readLibFile(candidate) {
  const direct = readTextOrNull(candidate)
  if (direct !== null) return direct
  for (const separator of [sep, '/']) {
    const marker = `.asar${separator}`
    const index = candidate.indexOf(marker)
    if (index === -1) continue
    const archive = candidate.slice(0, index + '.asar'.length)
    const entryPath = candidate.slice(index + marker.length).split(sep).join('/')
    return readAsarEntry(archive, entryPath)
  }
  return null
}

/**
 * Candidate locations of the package lib file, most specific first, deduplicated.
 *
 * @returns {string[]}
 */
function packageLibCandidates() {
  /** @type {string[]} */
  const candidates = []
  if (process.env.DSH_SYSTEM_PROMPT_LIB) candidates.push(process.env.DSH_SYSTEM_PROMPT_LIB)
  candidates.push(join(process.env.DSH_CHECKOUT || LOCAL_CHECKOUT, PACKAGE_LIB))
  candidates.push(join(LOCAL_CHECKOUT, PACKAGE_LIB))
  return [...new Set(candidates)]
}

/**
 * Parse an object literal declared as `const <name> = { … }` into key → number.
 * Both the quoted keys of `index.js` and the identifier keys of `SECTION_ORDERS`
 * are accepted, as are exponent literals such as `-1e3`.
 *
 * @param {string} source
 * @param {string} constName
 * @returns {Map<string, number> | null}
 */
function parseOrderTable(source, constName) {
  const start = source.indexOf(`const ${constName} = {`)
  if (start === -1) return null
  const open = source.indexOf('{', start)
  const close = source.indexOf('\n}', open)
  if (close === -1) return null
  const entries = new Map()
  for (const match of source.slice(open + 1, close).matchAll(ORDER_ENTRY)) {
    entries.set(match[1] ?? match[2] ?? match[3], Number(match[4]))
  }
  return entries.size > 0 ? entries : null
}

/**
 * Section names the package registers itself, with the SECTION_ORDERS constant
 * each one is placed by. Reads `this.section({ name: '…' | CONST, order: … })`
 * calls and resolves `CONST` through `const CONST = '…'` declarations.
 *
 * The package only registers a handful of names this way (`harness:identity` and
 * the two persona slots); the `tool:*` / `mcp:*` sections are registered by the
 * tool plugins, which is why the constant table below is checked separately.
 *
 * @param {string} source
 * @returns {Map<string, { constant?: string, literalOrder?: number }>}
 */
function parseRegisteredSections(source) {
  /** @type {Map<string, string>} */
  const stringConstants = new Map()
  for (const match of source.matchAll(/const ([A-Za-z_$][\w$]*)\s*=\s*['"]([^'"]*)['"]/g)) {
    stringConstants.set(match[1], match[2])
  }

  /** @type {Map<string, { constant?: string, literalOrder?: number }>} */
  const registered = new Map()
  for (const call of source.matchAll(/section\(\{([\s\S]*?)\}\)/g)) {
    const body = call[1]
    const nameMatch = body.match(/\bname\s*:\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][\w$]*))/)
    if (!nameMatch) continue
    const resolved = nameMatch[1] ?? nameMatch[2] ?? stringConstants.get(nameMatch[3])
    if (!resolved) continue

    const orderMatch = body.match(
      /\border\s*:\s*(?:this\.getSectionOrder\(\s*['"]([A-Z_$][\w$]*)['"]\s*\)|SECTION_ORDERS\.([A-Z_$][\w$]*)|(-?\d+(?:\.\d+)?))/,
    )
    if (!orderMatch) {
      registered.set(resolved, {})
      continue
    }
    if (orderMatch[3] !== undefined) {
      registered.set(resolved, { literalOrder: Number(orderMatch[3]) })
      continue
    }
    registered.set(resolved, { constant: orderMatch[1] ?? orderMatch[2] })
  }
  return registered
}

/**
 * Naming convention that ties a section name to its SECTION_ORDERS constant:
 * `tool:web_search` ↔ `TOOL_WEB_SEARCH`, `deliverable:file-references` ↔
 * `DELIVERABLE_FILE_REFERENCES`.
 *
 * @param {string} name
 * @returns {string}
 */
function toConstantName(name) {
  return name.replace(/[:-]/g, '_').toUpperCase()
}

/**
 * Installed Claude Code VS Code extensions, newest version first.
 *
 * @returns {{ version: string, dir: string }[]}
 */
function installedExtensions() {
  /** @type {{ version: string, dir: string }[]} */
  const found = []
  const roots = [...new Set([VSCODE_EXTENSIONS, join(homedir(), '.vscode', 'extensions')])]
  const seen = new Set()
  for (const root of roots) {
    /** @type {string[]} */
    let entries
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.startsWith(EXTENSION_PREFIX)) continue
      const dir = resolve(root, entry)
      if (seen.has(dir)) continue
      seen.add(dir)
      const manifestPath = join(dir, 'package.json')
      const manifest = readTextOrNull(manifestPath)
      if (manifest === null) continue
      let version
      try {
        version = JSON.parse(manifest).version
      } catch {
        continue
      }
      if (typeof version !== 'string') continue
      found.push({ version, dir })
    }
  }
  const rank = (/** @type {string} */ version) =>
    version.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  return found.sort((a, b) => {
    const left = rank(b.version)
    const right = rank(a.version)
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      const delta = (left[i] ?? 0) - (right[i] ?? 0)
      if (delta !== 0) return delta
    }
    return 0
  })
}

test('KNOWN_SECTION_ORDERS matches the installed @deepseek-ai/dsh-system-prompt', (t) => {
  const candidates = packageLibCandidates()
  let libPath = null
  let libText = null
  for (const candidate of candidates) {
    const text = readLibFile(candidate)
    if (text !== null) {
      libPath = candidate
      libText = text
      break
    }
  }
  if (libText === null) {
    t.skip(
      'cannot read @deepseek-ai/dsh-system-prompt/lib/index.js — set DSH_SYSTEM_PROMPT_LIB ' +
        `to that file to enable this check (tried: ${candidates.join(', ')})`,
    )
    return
  }

  const ours = parseOrderTable(readFileSync(join(repoRoot, 'index.js'), 'utf8'), 'KNOWN_SECTION_ORDERS')
  assert.ok(ours, 'cannot parse KNOWN_SECTION_ORDERS out of index.js — re-derive the extraction in test/drift.test.mjs')

  const theirs = parseOrderTable(libText, 'SECTION_ORDERS')
  assert.ok(
    theirs,
    `cannot parse SECTION_ORDERS out of ${libPath} — the table shape changed; ` +
      're-derive the extraction in test/drift.test.mjs',
  )
  const registered = parseRegisteredSections(libText)

  // Section names the package registers itself must all be known to the plugin.
  const missing = [...registered.keys()].filter((name) => !ours.has(name)).sort()
  assert.deepEqual(
    missing,
    [],
    `@deepseek-ai/dsh-system-prompt registers section(s) missing from KNOWN_SECTION_ORDERS: ` +
      `${missing.join(', ')} — update KNOWN_SECTION_ORDERS in index.js`,
  )

  // Every section name we place by hand must keep the order the package assigns
  // to the matching SECTION_ORDERS constant; a moved number silently mis-orders.
  /** @type {string[]} */
  const moved = []
  /** @type {string[]} */
  const stale = []
  /** @type {string[]} */
  const unmodeled = []

  const byConstant = new Map()
  for (const [name, order] of ours) byConstant.set(toConstantName(name), { name, order })

  for (const [constant, order] of theirs) {
    const known = byConstant.get(constant)
    if (!known) {
      unmodeled.push(`${constant}=${order}`)
      continue
    }
    if (known.order !== order) moved.push(`${known.name}: recorded ${known.order}, package ${constant}=${order}`)
  }

  for (const [name, { constant, literalOrder }] of registered) {
    const packageOrder = constant ? theirs.get(constant) : literalOrder
    if (packageOrder === undefined) continue
    const flag = `${name}:`
    if (ours.get(name) !== packageOrder && !moved.some((entry) => entry.startsWith(flag))) {
      moved.push(`${name}: recorded ${ours.get(name)}, package ${constant ?? 'literal order'} ${packageOrder}`)
    }
  }

  const constantNames = new Set(theirs.keys())
  for (const name of ours.keys()) {
    if (registered.has(name)) continue
    if (constantNames.has(toConstantName(name))) continue
    stale.push(name)
  }

  assert.deepEqual(
    moved,
    [],
    'section orders moved in @deepseek-ai/dsh-system-prompt: ' +
      `${moved.join('; ')} — update KNOWN_SECTION_ORDERS in index.js`,
  )

  t.diagnostic(`read ${libPath}`)
  t.diagnostic(
    `package registers ${registered.size} section name(s): ${[...registered.keys()].sort().join(', ') || '(none)'}`,
  )
  t.diagnostic(`package SECTION_ORDERS: ${theirs.size} constant(s); KNOWN_SECTION_ORDERS: ${ours.size} name(s)`)
  t.diagnostic(
    stale.length > 0
      ? `stale in KNOWN_SECTION_ORDERS (harmless, the package no longer has them): ${stale.join(', ')}`
      : 'stale in KNOWN_SECTION_ORDERS: none',
  )
  t.diagnostic(
    unmodeled.length > 0
      ? `package constants not modeled by KNOWN_SECTION_ORDERS (harmless): ${unmodeled.join(', ')}`
      : 'package constants not modeled by KNOWN_SECTION_ORDERS: none',
  )
})

test('vendored prompt files match prompt/VERSION.json', () => {
  const versionPath = join(repoRoot, 'prompt/VERSION.json')
  const recorded = JSON.parse(readFileSync(versionPath, 'utf8'))
  /** @type {string[]} */
  const drift = []

  for (const [relative, meta] of Object.entries(recorded.files)) {
    const buffer = readFileSync(join(repoRoot, relative))
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    // Text lines: the captures end without a trailing newline, so the last line
    // counts but produces no extra empty entry (`wc -l` would report one fewer).
    const lines = buffer.toString('utf8').split('\n').length
    if (sha256 !== meta.sha256) drift.push(`${relative}: sha256 ${sha256} != recorded ${meta.sha256}`)
    if (buffer.length !== meta.bytes) drift.push(`${relative}: ${buffer.length} bytes != recorded ${meta.bytes}`)
    if (lines !== meta.lines) drift.push(`${relative}: ${lines} lines != recorded ${meta.lines}`)
  }

  assert.deepEqual(drift, [], `prompt files changed; refresh prompt/VERSION.json\n  ${drift.join('\n  ')}`)
})

test('vendored prompts come from the installed Claude Code version', (t) => {
  const extensions = installedExtensions()
  if (extensions.length === 0) {
    t.skip(`no ${EXTENSION_PREFIX}* extension under ${VSCODE_EXTENSIONS} — skipping the installed-version check`)
    return
  }

  const recorded = JSON.parse(readFileSync(join(repoRoot, 'prompt/VERSION.json'), 'utf8'))
  const [newest] = extensions
  assert.equal(
    newest.version,
    recorded.claudeCodeVersion,
    `Claude Code ${newest.version} is installed (${newest.dir}) but prompt/VERSION.json records ` +
      `${recorded.claudeCodeVersion} — re-capture the prompts with \`python tools/capture_cc_prompt.py\` ` +
      'and bump claudeCodeVersion in prompt/VERSION.json',
  )
  t.diagnostic(`installed: ${newest.version} (${newest.dir})`)
  if (extensions.length > 1) {
    t.diagnostic(`other installed versions: ${extensions.slice(1).map((entry) => entry.version).join(', ')}`)
  }
})
