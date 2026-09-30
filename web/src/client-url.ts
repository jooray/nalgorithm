/**
 * Nalgorithm Web — "open this in a Nostr client" links
 *
 * Which client someone prefers is personal, so the presets are just starting
 * points and a custom template is a first-class option. This file is pure (no
 * DOM, no imports) so it can be tested directly.
 *
 * Every URL that leaves this file has passed the scheme allowlist below.
 */

export type ClientPreset = 'njump' | 'primal' | 'yakihonne' | 'app' | 'custom'

interface PresetInfo {
  label: string
  /** Event link template, `{e}` is the nevent. */
  url: string
  /** Profile link template, `{npub}` is the npub. */
  profileUrl: string
}

export const CLIENT_PRESETS: Record<Exclude<ClientPreset, 'custom'>, PresetInfo> = {
  njump: { label: 'njump', url: 'https://njump.me/{e}', profileUrl: 'https://njump.me/{npub}' },
  primal: { label: 'Primal', url: 'https://primal.net/e/{e}', profileUrl: 'https://primal.net/p/{npub}' },
  yakihonne: { label: 'Yakihonne', url: 'https://yakihonne.com/event/{e}', profileUrl: 'https://yakihonne.com/profile/{npub}' },
  // NIP-21: hands the identifier to whichever app registered the nostr: scheme.
  app: { label: 'my Nostr app', url: 'nostr:{e}', profileUrl: 'nostr:{npub}' },
}

export function isClientPreset(value: unknown): value is ClientPreset {
  return value === 'custom' || (typeof value === 'string' && Object.hasOwn(CLIENT_PRESETS, value))
}

/**
 * Schemes a link template may use: web links, and the NIP-21 `nostr:` scheme
 * (`web+nostr` is the spelling browsers require for registered protocol
 * handlers). Everything else, javascript:, data:, vbscript:, file: and so on,
 * is refused, because templates are typed by the user and a link that runs
 * script when clicked is never what they meant.
 */
const ALLOWED_SCHEMES = new Set(['http', 'https', 'nostr', 'web+nostr'])

/** The lower-cased scheme of a URL or template, or null when it has none. */
function schemeOf(url: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url)
  return m ? m[1].toLowerCase() : null
}

/**
 * True when the URL starts with an allowed scheme. Whitespace and control
 * characters are refused outright: browsers strip them while parsing, which is
 * how "java\tscript:" gets past naive checks.
 */
export function isAllowedLink(url: string): boolean {
  if (/[\u0000- \u007f-\u009f]/.test(url.trim()) || url.trim() !== url) return false
  const scheme = schemeOf(url)
  return scheme !== null && ALLOWED_SCHEMES.has(scheme)
}

/** The URL if it is safe to put in an href, otherwise null. */
export function safeLink(url: string): string | null {
  return isAllowedLink(url) ? url : null
}

/** Why a custom template was refused, or null if it is fine (or empty). */
export function validateTemplate(template: string): string | null {
  const t = template.trim()
  if (!t) return null
  if (!isAllowedLink(t.replace(/\{[a-z]+\}/gi, 'x'))) {
    return 'Use an http://, https:// or nostr: link.'
  }
  return null
}

/**
 * Fill a template, or append to it when it has no placeholder.
 *
 * A template may contain any of `names` as `{name}`. A bare prefix works too,
 * because there is no reason to make someone remember which form this app
 * wanted:
 *
 *   https://yakihonne.com/event/{e}   ->  https://yakihonne.com/event/nevent1...
 *   https://yakihonne.com/event/      ->  https://yakihonne.com/event/nevent1...
 *   https://yakihonne.com/event       ->  https://yakihonne.com/event/nevent1...
 *
 * `primary` is what a bare prefix gets. Returns '' if the result is not an
 * allowed link.
 */
function expand(template: string, values: Record<string, string>, primary: string): string {
  const t = template.trim()
  let out: string
  if (/\{[a-z]+\}/i.test(t)) {
    out = t.replace(/\{([a-z]+)\}/gi, (whole, name: string) => (name in values ? values[name] : whole))
  } else if (t.endsWith(':') || /^[a-z][a-z0-9+.-]*:[^/]*$/i.test(t)) {
    out = t + values[primary] // "nostr:" style, nothing to separate
  } else {
    out = t.replace(/\/?$/, '/') + values[primary]
  }
  return isAllowedLink(out) ? out : ''
}

/** Build a URL for an event. Falls back to njump for an empty or unsafe template. */
export function buildEventUrl(template: string, nevent: string): string {
  const url = template.trim() ? expand(template, { e: nevent, nevent, note: nevent }, 'e') : ''
  return url || CLIENT_PRESETS.njump.url.replace('{e}', nevent)
}

export interface ProfileIds {
  npub: string
  nprofile: string
  /** Hex, only ever placed into a URL the reader wrote a `{pubkey}` template for. */
  pubkey: string
}

/** Build a URL for a profile. Placeholders: {npub}, {nprofile}, {pubkey}. */
export function buildProfileUrl(template: string, ids: ProfileIds): string {
  const url = template.trim() ? expand(template, { ...ids }, 'npub') : ''
  return url || CLIENT_PRESETS.njump.profileUrl.replace('{npub}', ids.npub)
}

/** NIP-21 URI for any bech32 identifier (npub, nprofile, nevent, note). */
export function nostrUri(bech32: string): string {
  return `nostr:${bech32}`
}

/** The event template for a preset, or the custom one (blank if it is not allowed). */
export function resolveTemplate(preset: ClientPreset, customUrl: string): string {
  if (preset === 'custom') return validateTemplate(customUrl) ? '' : customUrl
  return CLIENT_PRESETS[preset]?.url ?? CLIENT_PRESETS.njump.url
}

/** The profile template for a preset, or the custom one (blank if it is not allowed). */
export function resolveProfileTemplate(preset: ClientPreset, customProfileUrl: string): string {
  if (preset === 'custom') return validateTemplate(customProfileUrl) ? '' : customProfileUrl
  return CLIENT_PRESETS[preset]?.profileUrl ?? CLIENT_PRESETS.njump.profileUrl
}

/**
 * Work out which preset a stored URL corresponds to.
 *
 * Used to migrate the older `njumpBaseUrl` setting, which held a bare prefix,
 * without resetting anyone's choice.
 */
export function presetFromUrl(url: string): ClientPreset {
  const normalized = url.trim().replace(/\/?$/, '/').replace('{e}/', '')
  for (const [key, preset] of Object.entries(CLIENT_PRESETS)) {
    if (key === 'app') continue
    const presetPrefix = preset.url.replace('{e}', '')
    if (normalized === presetPrefix) return key as ClientPreset
  }
  return 'custom'
}

/** Human-readable name for the current choice, for menu labels. */
export function clientLabel(preset: ClientPreset): string {
  return preset === 'custom' ? 'client' : CLIENT_PRESETS[preset].label
}
