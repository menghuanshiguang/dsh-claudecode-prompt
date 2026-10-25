#!/usr/bin/env node
/**
 * End-to-end proof that DSH really boots with the Claude Code prompt mounted.
 *
 * Everything happens in a throwaway profile under `$DSH_HOME/profiles`, because
 * `dsh` resolves plugin packages from the profile's `node_modules` and there is no
 * way to mount a host row without one. The profile holds a directory junction to
 * this repo (no admin rights needed on Windows) plus a one-row insert patch, so
 * the boot under test is the same mount path a user gets from `dsh plugin add`.
 *
 * The live profiles are never touched: the profile name is unique per process and
 * is deleted in a `finally`.
 *
 * @module dsh-claudecode-prompt/tools/verify
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TAG = '[dsh-claudecode-prompt]'
/** With `keepSections: []` nothing survives except the plugin's own two sections. */
const EXPECTED_SECTIONS = 'claudecode:identity, claudecode:prompt'
const PROMPT = 'say ok'
const TIMEOUT_MS = 120_000

const PROFILE_NAME = `ccprompt-verify-${process.pid}`
const DSH_HOME = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE_NAME)

const PROFILE_PACKAGE_JSON = {
  name: `dsh-profile-${PROFILE_NAME}`,
  private: true,
  dependencies: {},
  dsh: {
    profile: {
      // headless boots, answers one prompt and exits — the cheapest shape that
      // still runs the real `system-prompt/assemble` waterfall.
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
      patchReload: 'startup',
    },
  },
}

const PATCH_YML = [
  '- insert:',
  '    - id: claudecode-prompt',
  '      name: dsh-claudecode-prompt',
  '      config:',
  '        debug: true',
  '        keepSections: []',
  '',
].join('\n')

/**
 * Locate the `dsh` CLI. `DSH_BIN` wins so a non-PATH install still verifies.
 *
 * @returns {string | null}
 */
function findDsh() {
  const explicit = process.env.DSH_BIN?.trim()
  if (explicit) return explicit

  const names = process.platform === 'win32'
    ? ['dsh.exe', 'dsh.cmd', 'dsh.bat', 'dsh']
    : ['dsh']

  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    const dir = entry.replace(/^"|"$/g, '').trim()
    if (dir === '') continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        /* not here */
      }
    }
  }
  return null
}

/**
 * Create the temp profile: package.json, empty root tree, junction to this repo,
 * and the insert patch row.
 *
 * @returns {string} how the plugin was mounted ('junction' | 'copy')
 */
function writeProfile() {
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
  fs.mkdirSync(path.join(PROFILE_DIR, 'node_modules'), { recursive: true })

  fs.writeFileSync(
    path.join(PROFILE_DIR, 'package.json'),
    `${JSON.stringify(PROFILE_PACKAGE_JSON, null, 2)}\n`,
  )
  // The composed tree lives in the patches; this root file is just the empty base.
  fs.writeFileSync(path.join(PROFILE_DIR, 'cordis.yml'), '[]\n')
  fs.writeFileSync(path.join(PROFILE_DIR, 'cordis.patch.yml'), PATCH_YML)

  return linkPlugin(path.join(PROFILE_DIR, 'node_modules', 'dsh-claudecode-prompt'))
}

/**
 * @param {string} target
 * @returns {string}
 */
function linkPlugin(target) {
  try {
    // 'junction' is the only link type Windows creates unprivileged.
    fs.symlinkSync(REPO_ROOT, target, 'junction')
    return 'junction'
  } catch {
    fs.cpSync(REPO_ROOT, target, {
      recursive: true,
      filter: (source) => !/[/\\](\.git|node_modules|cc-prompt-raw|captures|vsix)([/\\]|$)/.test(source.slice(REPO_ROOT.length)),
    })
    return 'copy'
  }
}

/**
 * Turn the launcher path into a spawnable command with an exact argv.
 *
 * A `.cmd` shim on Windows is not an executable image: it is a batch file, and
 * spawning it either needs `shell: true` — which concatenates the argv array
 * unescaped (DEP0190) and splits a prompt like "say ok" into two arguments — or a
 * manual round through cmd.exe. Preferring the JavaScript entry the shim itself
 * calls keeps the argv intact and skips the shell entirely; cmd.exe is only the
 * fallback for a shim laid out some other way.
 *
 * @param {string} bin
 * @param {string[]} args
 * @returns {{ command: string, argv: string[], shell?: boolean }}
 */
function resolveInvocation(bin, args) {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(bin)) {
    return { command: bin, argv: args }
  }

  const shimDir = path.dirname(bin)
  const binJs = path.join(shimDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (fs.existsSync(binJs)) {
    // Same entry the shim's `"%_prog%" "%dp0%\node_modules\...\bin.js" %*` line runs.
    return { command: process.execPath, argv: [binJs, ...args] }
  }

  // Unknown shim layout: hand cmd.exe one already-quoted command line. Passing an
  // argv array here instead would make Node escape the quotes as `\"`, which
  // cmd.exe does not parse — the argument has to stay a single string, and
  // without an argv array there is no shell deprecation either.
  const line = [bin, ...args].map((entry) => `"${entry.replaceAll('"', '""')}"`).join(' ')
  return { command: line, argv: [], shell: true }
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ code: number | null, out: string, timedOut?: boolean, error?: Error }>}
 */
function runDsh(bin, args, cwd) {
  return new Promise((resolve) => {
    const { command, argv, shell } = resolveInvocation(bin, args)
    const child = spawn(command, argv, {
      cwd,
      shell: Boolean(shell),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    let timedOut = false
    child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { out += chunk })

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, TIMEOUT_MS)

    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, out, error })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, timedOut })
    })
  })
}

/**
 * @param {import('node:child_process').ChildProcess} child
 */
function killTree(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    // Killing cmd.exe leaves the node child behind.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } else {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

/**
 * @param {string} text
 * @returns {{ ok: boolean, problems: string[], activeLine?: string, sectionsLine?: string }}
 */
function check(text) {
  const lines = text.split(/\r?\n/)
  const problems = []

  const activeLine = lines.find((line) => line.includes(`${TAG} active —`))
  if (!activeLine) problems.push(`missing "${TAG} active —" line`)

  const sectionsLine = lines.find((line) => /\[dsh-claudecode-prompt\] sections \d+ -> \d+ \[/.test(line))
  if (!sectionsLine) {
    problems.push(`missing "${TAG} sections N -> M [...]" line (is debug: true set?)`)
  } else {
    const match = sectionsLine.match(/\[dsh-claudecode-prompt\] sections (\d+) -> (\d+) \[([^\]]*)\]/)
    const list = match[3].split(',').map((entry) => entry.trim()).filter(Boolean).join(', ')
    const emitted = Number(match[2])
    if (list !== EXPECTED_SECTIONS) {
      problems.push(`section list is [${list}], expected [${EXPECTED_SECTIONS}]`)
    }
    if (emitted !== EXPECTED_SECTIONS.split(',').length) {
      problems.push(`reported ${emitted} output sections for a ${EXPECTED_SECTIONS.split(',').length}-name list`)
    }
  }

  return { ok: problems.length === 0, problems, activeLine, sectionsLine }
}

async function main() {
  const bin = findDsh()
  if (!bin) {
    console.log('SKIP: no `dsh` CLI on PATH (set DSH_BIN to the launcher to run this check)')
    return
  }

  const overlayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccprompt-verify-'))
  const overlayFile = path.join(overlayDir, 'cordis.patch.yml')
  // An empty overlay: `--patch` is exercised, but the plugin row must NOT repeat
  // here — the loader rejects a second entry with the same id
  // ("duplicate loader entry id"), and the profile layer already carries it.
  fs.writeFileSync(overlayFile, '[]\n')

  let mounted = ''
  try {
    mounted = writeProfile()
    console.log(`cli      ${bin}`)
    console.log(`profile  ${PROFILE_DIR} (plugin mounted by ${mounted})`)
    console.log(`prompt   "${PROMPT}"`)
    console.log('')

    const args = ['--profile', PROFILE_NAME, '--patch', overlayFile, PROMPT]
    const result = await runDsh(bin, args, os.tmpdir())

    if (result.error) {
      console.log(`FAIL: could not run ${bin}: ${result.error.message}`)
      process.exitCode = 1
      return
    }
    if (result.timedOut) {
      console.log(`FAIL: dsh did not exit within ${TIMEOUT_MS / 1000}s`)
      dumpTail(result.out)
      process.exitCode = 1
      return
    }

    const verdict = check(result.out)
    for (const line of [verdict.activeLine, verdict.sectionsLine]) {
      if (line) console.log(line.trim())
    }
    console.log('')

    if (result.code !== 0) verdict.problems.unshift(`dsh exited with code ${result.code}`)
    if (!verdict.ok) {
      console.log(`FAIL: ${verdict.problems.join('; ')}`)
      dumpTail(result.out)
      process.exitCode = 1
      return
    }

    console.log(`PASS — dsh booted (exit 0) with the Claude Code prompt mounted: ${EXPECTED_SECTIONS}`)
  } finally {
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
    fs.rmSync(overlayDir, { recursive: true, force: true })
  }
}

/**
 * @param {string} text
 */
function dumpTail(text) {
  const lines = text.split(/\r?\n/).filter((line) => line !== '')
  console.log(`--- captured output (last ${Math.min(lines.length, 40)} lines) ---`)
  for (const line of lines.slice(-40)) console.log(line)
  console.log('--- end ---')
}

await main()
