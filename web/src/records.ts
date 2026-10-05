import { storageFrozen } from './storage.js'
/** Async local records, including binary audio. Small preferences stay separate. */
export interface LocalRecord<T = unknown> { key: string; value: T; at: number }
const fallback = new Map<string, LocalRecord>()
let opening: Promise<IDBDatabase | null> | undefined
function open(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open('nalgorithm-local-v1', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('records', { keyPath: 'key' })
      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => { db.close(); opening = undefined }
        // WebKit drops connections of backgrounded pages; the next call reopens.
        db.onclose = () => { opening = undefined }
        resolve(db)
      }
      request.onerror = request.onblocked = () => resolve(null)
    } catch { resolve(null) }
  })
  return opening
}
/**
 * The store in a new transaction, reopening once if the connection was lost
 * (transaction() then throws InvalidStateError). Null means use the fallback.
 */
async function store(mode: IDBTransactionMode): Promise<IDBObjectStore | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = await open()
    if (!db) return null
    try { return db.transaction('records', mode).objectStore('records') } catch { opening = undefined }
  }
  return null
}
export async function getRecord<T>(key: string): Promise<T | null> {
  if (fallback.has(key)) return fallback.get(key)!.value as T
  const records = await store('readonly')
  if (!records) return (fallback.get(key)?.value as T) ?? null
  return new Promise((resolve) => {
    const request = records.get(key)
    request.onsuccess = () => resolve(request.result?.value ?? null)
    request.onerror = () => resolve((fallback.get(key)?.value as T) ?? null)
  })
}
export async function isRecordDurable(key: string): Promise<boolean> { return Boolean(await open()) && !fallback.has(key) }
export async function putRecord<T>(key: string, value: T, at = Date.now()): Promise<boolean> {
  if (storageFrozen()) return false
  const record = { key, value, at }; const records = await store('readwrite')
  // Clear this device may have started while the store was opening.
  if (storageFrozen()) return false
  if (!records) { fallback.set(key, record); return false }
  return new Promise((resolve) => {
    try {
      const tx = records.transaction; records.put(record)
      tx.oncomplete = () => { fallback.delete(key); resolve(true) }
      tx.onerror = tx.onabort = () => { fallback.set(key, record); resolve(false) }
    } catch { fallback.set(key, record); resolve(false) }
  })
}
export async function listRecords<T>(prefix: string): Promise<LocalRecord<T>[]> {
  const records = await store('readonly')
  const memory = [...fallback.values()].filter((r) => r.key.startsWith(prefix)) as LocalRecord<T>[]
  if (!records) return memory
  return new Promise((resolve) => {
    try {
      const request = records.getAll(IDBKeyRange.bound(prefix, prefix + '￿'))
      request.onsuccess = () => resolve([...new Map<string, LocalRecord<T>>([...request.result, ...memory].map((r: LocalRecord<T>) => [r.key, r])).values()])
      request.onerror = () => resolve(memory)
    } catch { resolve(memory) }
  })
}
export async function deleteRecord(key: string): Promise<void> {
  fallback.delete(key); const records = await store('readwrite'); if (!records) return
  await new Promise<void>((resolve) => {
    try {
      const tx = records.transaction; records.delete(key)
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve()
    } catch { resolve() }
  })
}
export async function clearRecords(prefix = ''): Promise<void> {
  for (const record of await listRecords(prefix)) await deleteRecord(record.key)
}
