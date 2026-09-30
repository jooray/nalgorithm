/**
 * Nalgorithm Web — time labels (pure)
 */

/** Note age as a client shows it: "now", "5m", "2h", "3d", then a date. */
export function relativeTime(unixSeconds: number, nowMs = Date.now()): string {
  const diff = Math.max(0, nowMs - unixSeconds * 1000)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** "Tue 30 Sep", in the viewer's locale; "Today" / "Yesterday" for the last two days. */
export function dayLabel(unixSeconds: number, nowMs = Date.now()): string {
  const d = new Date(unixSeconds * 1000)
  const now = new Date(nowMs)
  const startOf = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

export function clockLabel(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
