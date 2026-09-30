/**
 * Nalgorithm Web — icon set
 *
 * Authored SVG, one stroke (1.75) and one style (round caps and joins, no
 * fill unless stated) on a 24 grid. Strings are static and trusted, so they
 * are safe to assign with innerHTML; never interpolate user text into them.
 */

const PATHS = {
  play: '<path d="M8 5.5v13a.6.6 0 0 0 .92.5l10.2-6.5a.6.6 0 0 0 0-1L8.92 5a.6.6 0 0 0-.92.5Z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
  back15: '<path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M4 4.5v4h4"/>',
  fwd30: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4.5v4h-4"/>',
  digest: '<rect x="3.5" y="4" width="17" height="16" rx="3.5"/><path d="M10 9.2v5.6a.4.4 0 0 0 .6.35l4.6-2.8a.4.4 0 0 0 0-.7l-4.6-2.8a.4.4 0 0 0-.6.35Z"/>',
  feed: '<path d="M4 7h.01M4 12h.01M4 17h.01M8.5 7H14M8.5 12h11M8.5 17h11"/><path d="M16.5 7.5l3-3M17 4.5h2.5V7"/>',
  tune: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v3.5A2.5 2.5 0 0 1 15.5 20h-9A2.5 2.5 0 0 1 4 17.5v-9A2.5 2.5 0 0 1 6.5 6H10"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6.5A2.5 2.5 0 0 0 13 4H6.5A2.5 2.5 0 0 0 4 6.5V13a2.5 2.5 0 0 0 2.5 2.5h2"/>',
  more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  reply: '<path d="M9.5 6 4 11.5 9.5 17"/><path d="M4.5 11.5H14a6 6 0 0 1 6 6V19"/>',
  boost: '<path d="M17 3.5 20.5 7 17 10.5"/><path d="M3.5 11V9.5A2.5 2.5 0 0 1 6 7h14.5"/><path d="M7 20.5 3.5 17 7 13.5"/><path d="M20.5 13v1.5a2.5 2.5 0 0 1-2.5 2.5H3.5"/>',
  like: '<path d="M12 20s-7.5-4.4-7.5-10.1A4.4 4.4 0 0 1 12 7.2a4.4 4.4 0 0 1 7.5 2.7C19.5 15.600 12 20 12 20Z"/>',
  zap: '<path d="M13 3 5.5 13.500H12L11 21l7.500-10.500H12Z"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4M4 4v3.500h3.500"/><path d="M4 13a8 8 0 0 0 14.500 4M20 20v-3.500h-3.500"/>',
  check: '<path d="m5 12.500 4.500 4.500L19 7.500"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  notes: '<path d="M8 6.500h11M8 12h11M8 17.500h7"/><path d="M4.500 6.500h.01M4.500 12h.01M4.500 17.500h.01"/>',
  offline: '<path d="M3 3l18 18"/><path d="M8.500 16.500a5 5 0 0 1 4.600-1.300M5 12.900a9.500 9.500 0 0 1 3-1.900M16.500 11.300a9.500 9.500 0 0 1 2.500 1.600M2 9a14.500 14.500 0 0 1 4.200-2.600M10.500 5.100A14.500 14.500 0 0 1 22 9"/><path d="M12 20h.01"/>',
  dot: '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
  chevron: '<path d="m6.500 9.500 5.500 5.500 5.500-5.500"/>',
  user: '<circle cx="12" cy="8.500" r="3.500"/><path d="M5 20a7 7 0 0 1 14 0"/>',
} as const

export type IconName = keyof typeof PATHS

export function icon(name: IconName, size = 24): string {
  return `<svg class="icon icon-${name}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`
}
