/**
 * dsh-claudecode-prompt — run DeepSeek Harness on Claude Code's system prompt.
 *
 * What changes: the assembled system prompt. What does not: tools, runtime
 * context (working directory / sandbox / approval policy), model, UI, every other
 * plugin. The swap happens at the `system-prompt/assemble` waterfall, the only
 * point where the full section list is visible and rewritable without touching
 * any other plugin's contribution.
 *
 * Why a waterfall listener instead of a `complete: true` section:
 *
 *  - `complete` collapses the prompt to a single section, which cannot coexist
 *    with `keepSections` (a preset or a user may want another plugin's section
 *    to survive) — see the guard discussion below for the second reason.
 *  - sunder's assembly guard treats a single foreign section as a hostile
 *    takeover and re-attaches its own three sections (so a `complete` swap loses);
 *    an outer waterfall listener registered after it has the last word instead.
 *
 * The listener is registered `{ prepend: true, global: true }` so it sits at the
 * front of the listener chain — for a waterfall the first listener is the
 * outermost one, i.e. the one whose return value wins. Because `prepend` unshifts,
 * the *last* plugin to register wins, which is why the bundle order in the
 * profile must place this package after `dsh-sunder`.
 *
 * @module dsh-claudecode-prompt
 */

import { normalizeConfig, readPromptFile } from './lib/config.js'
import { buildPromptText } from './lib/transform.js'

/** Cordis plugin name. */
export const name = 'claudecode-prompt'

/** The only service this plugin needs: the prompt registry and its waterfall. */
export const inject = ['systemPrompt']

const TAG = '[dsh-claudecode-prompt]'

/**
 * Sections whose presence proves another prompt plugin (sunder) is still
 * contributing — used only for diagnostics.
 */
const FOREIGN_SECTION_PREFIXES = ['sunder:']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)

  if (!config.enabled) {
    console.info(`${TAG} disabled by config`)
    return
  }

  const { text: raw, source } = readPromptFile(config)
  const promptText = buildPromptText({
    raw,
    identity: config.identity,
    includeIdentity: config.includeIdentity,
    stripDynamicTail: config.stripDynamicTail,
    dropSections: config.dropSections,
    toolNames: config.toolNames,
  })
  const identityText = config.identity.trim()

  /** Section order lookup, memoized; `null` when the registry has no such name. */
  const orderCache = new Map()
  const orderOf = (sectionName) => {
    if (orderCache.has(sectionName)) return orderCache.get(sectionName)
    let order = null
    try {
      const resolved = ctx.systemPrompt.getSectionOrder(sectionName)
      if (Number.isFinite(resolved)) order = resolved
    } catch {
      /* unknown section name — fall through to the positional fallback */
    }
    orderCache.set(sectionName, order)
    return order
  }

  const identitySectionName = `${config.sectionPrefix}:identity`
  const promptSectionName = `${config.sectionPrefix}:prompt`
  let reportedForeign = false

  ctx.on(
    'system-prompt/assemble',
    async (...args) => {
      const next = args[args.length - 1]
      const assembly = typeof next === 'function' ? await next() : args[0]
      if (!assembly || !Array.isArray(assembly.sections)) return assembly

      const rewritten = rewriteAssembly(assembly, {
        config,
        promptText,
        identityText,
        identitySectionName,
        promptSectionName,
        orderOf,
      })

      if (config.debug) {
        console.info(
          `${TAG} sections ${assembly.sections.length} -> ${rewritten.sections.length}` +
            ` [${rewritten.sections.map((section) => section.name).join(', ')}]`,
        )
      }

      if (!reportedForeign && assembly.sections.some(isForeignSection)) {
        reportedForeign = true
        console.warn(
          `${TAG} dropped sections contributed by another prompt plugin ` +
            `(${assembly.sections.filter(isForeignSection).map((section) => section.name).join(', ')}). ` +
            'If they come back, that plugin has an outer assembly guard: set `guard: false` ' +
            'on its row, and make sure this bundle is listed after it in dsh.profile.bundles.',
        )
      }

      return rewritten
    },
    { global: true, prepend: true },
  )

  console.info(
    `${TAG} active — variant=${config.variant} source=${source} ` +
      `chars=${promptText.length} identity=${config.includeIdentity ? 'on' : 'off'} ` +
      `tools=${config.toolNamesMode} dropped=[${config.dropSections.join(', ')}] ` +
      `keep=[${config.keepSections.join(', ')}]`,
  )
}

/**
 * Replace the assembled section list with the Claude Code prompt, preserving
 * `keepSections` (and their relative order) plus everything that is not the
 * system prompt at all — `contexts`, `tools` and `variables` are passed through
 * untouched, which is what keeps runtime context and the tool schemas intact.
 *
 * @param {{ sections: { name: string, text: string, interpolate?: boolean }[] }} assembly
 * @param {object} options
 * @returns {{ sections: { name: string, text: string, interpolate?: boolean }[] }}
 */
function rewriteAssembly(assembly, options) {
  const { config, promptText, identityText, identitySectionName, promptSectionName, orderOf } = options

  const keep = new Set(config.keepSections)
  /** @type {{ name: string, text: string, interpolate?: boolean, order: number }[]} */
  const before = []
  /** @type {{ name: string, text: string, interpolate?: boolean, order: number }[]} */
  const after = []

  for (const section of assembly.sections) {
    if (!section || typeof section.name !== 'string' || !keep.has(section.name)) continue
    const order = orderOf(section.name)
    const entry = {
      name: section.name,
      text: section.text,
      interpolate: section.interpolate,
      // An unknown order has to land somewhere deterministic; before our prompt
      // is the conservative choice (it cannot displace the tool instructions,
      // which are gone anyway).
      order: order === null ? Number.NEGATIVE_INFINITY : order,
    }
    if (entry.order < config.promptOrder) before.push(entry)
    else after.push(entry)
  }

  before.sort(byOrder)
  after.sort(byOrder)

  const own = []
  if (config.includeIdentity && identityText !== '') {
    own.push({ name: identitySectionName, text: identityText, interpolate: false, order: config.identityOrder })
  }
  own.push({ name: promptSectionName, text: promptText, interpolate: false, order: config.promptOrder })

  const merged = [...before, ...own, ...after]
  merged.sort(byOrder)

  return {
    ...assembly,
    sections: merged.map((section) => ({
      name: section.name,
      text: section.text,
      interpolate: section.interpolate,
    })),
  }
}

/**
 * @param {{ order: number }} a
 * @param {{ order: number }} b
 * @returns {number}
 */
function byOrder(a, b) {
  return a.order - b.order
}

/**
 * @param {{ name?: unknown }} section
 * @returns {boolean}
 */
function isForeignSection(section) {
  const sectionName = typeof section?.name === 'string' ? section.name : ''
  return FOREIGN_SECTION_PREFIXES.some((prefix) => sectionName.startsWith(prefix))
}
