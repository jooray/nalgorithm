/**
 * Nalgorithm Web — "open this post in a Nostr client" links
 *
 * Which client someone prefers is personal, so the presets are just starting
 * points and a custom template is a first-class option.
 */

export type ClientPreset = 'njump' | 'primal' | 'yakihonne' | 'custom'

export const CLIENT_PRESETS: Record<Exclude<ClientPreset, 'custom'>, { label: string; url: string }> = {
  njump: { label: 'njump', url: 'https://njump.me/{e}' },
  primal: { label: 'Primal', url: 'https://primal.net/e/{e}' },
  yakihonne: { label: 'Yakihonne', url: 'https://yakihonne.com/event/{e}' },
}

/**
 * Build a URL for an event.
 *
 * The template may either contain `{e}`, or be a bare prefix the event id is
 * appended to. Both spellings of the same client work, because there is no
 * reason to make someone remember which form this app wanted:
 *
 *   https://yakihonne.com/event/{e}   →  https://yakihonne.com/event/nevent1…
 *   https://yakihonne.com/event/      →  https://yakihonne.com/event/nevent1…
 *   https://yakihonne.com/event       →  https://yakihonne.com/event/nevent1…
 */
export function buildEventUrl(template: string, eventId: string): string {
  const trimmed = template.trim()
  if (!trimmed) return CLIENT_PRESETS.njump.url.replace('{e}', eventId)

  if (trimmed.includes('{e}')) {
    return trimmed.split('{e}').join(eventId)
  }
  // Prefix form — add the separating slash only if it is missing.
  return trimmed.replace(/\/?$/, '/') + eventId
}

/** The template for a given preset, or the custom one. */
export function resolveTemplate(preset: ClientPreset, customUrl: string): string {
  if (preset === 'custom') return customUrl
  return CLIENT_PRESETS[preset]?.url ?? CLIENT_PRESETS.njump.url
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
    const presetPrefix = preset.url.replace('{e}', '')
    if (normalized === presetPrefix) return key as ClientPreset
  }
  return 'custom'
}

/** Human-readable name for the current choice, for menu labels. */
export function clientLabel(preset: ClientPreset): string {
  return preset === 'custom' ? 'client' : CLIENT_PRESETS[preset].label
}
