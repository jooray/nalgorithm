/** Guarded small preferences. Large records/audio use IndexedDB. */
const memory = new Map<string, string>()
const volatile = new Set<string>()
let failed = false
function persistent(): Storage | null {
  try { return globalThis.localStorage } catch { failed = true; return null }
}
export const deviceStorage: Storage = {
  get length() { return keys().length },
  key(index) { return keys()[index] ?? null },
  getItem(key) {
    if (volatile.has(key)) return memory.get(key) ?? null
    try { return persistent()?.getItem(key) ?? memory.get(key) ?? null } catch { failed = true; return memory.get(key) ?? null }
  },
  setItem(key, value) {
    memory.set(key, String(value))
    try {
      const store = persistent()
      if (!store) throw new Error('Storage unavailable')
      store.setItem(key, String(value)); volatile.delete(key)
    } catch { failed = true; volatile.add(key) }
  },
  removeItem(key) {
    memory.delete(key); volatile.add(key)
    try { persistent()?.removeItem(key) } catch { failed = true }
  },
  clear() { for (const key of keys()) if (key.startsWith('nalgorithm_')) deviceStorage.removeItem(key) },
}
function keys(): string[] {
  const all = new Set(memory.keys())
  try {
    const store = persistent()
    if (store) for (let i = 0; i < store.length; i++) { const key = store.key(i); if (key) all.add(key) }
  } catch { failed = true }
  return [...all].filter((key) => deviceStorage.getItem(key) !== null)
}
export function storageNotice(): string {
  return failed ? 'Working for this session. This device could not save all settings; keep this page open.' : ''
}
