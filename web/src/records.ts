/** Async local records, including binary audio. Small preferences stay separate. */
export interface LocalRecord<T = unknown> { key: string; value: T; at: number }
const fallback = new Map<string, LocalRecord>()
let opening: Promise<IDBDatabase | null> | undefined
function open(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open('nalgorithm-local-v1', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('records', { keyPath: 'key' })
      request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); opening = undefined }; resolve(request.result) }
      request.onerror = request.onblocked = () => resolve(null)
    } catch { resolve(null) }
  })
  return opening
}
export async function getRecord<T>(key: string): Promise<T | null> {
  if (fallback.has(key)) return fallback.get(key)!.value as T
  const db = await open()
  if (!db) return (fallback.get(key)?.value as T) ?? null
  return new Promise((resolve) => {
    const request = db.transaction('records', 'readonly').objectStore('records').get(key)
    request.onsuccess = () => resolve(request.result?.value ?? null)
    request.onerror = () => resolve((fallback.get(key)?.value as T) ?? null)
  })
}
export async function isRecordDurable(key: string): Promise<boolean> { return Boolean(await open()) && !fallback.has(key) }
export async function putRecord<T>(key: string, value: T, at = Date.now()): Promise<boolean> {
  const record = { key, value, at }; const db = await open()
  if (!db) { fallback.set(key, record); return false }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put(record)
      tx.oncomplete = () => { fallback.delete(key); resolve(true) }
      tx.onerror = tx.onabort = () => { fallback.set(key, record); resolve(false) }
    } catch { fallback.set(key, record); resolve(false) }
  })
}
export async function listRecords<T>(prefix: string): Promise<LocalRecord<T>[]> {
  const db = await open()
  const memory = [...fallback.values()].filter((r) => r.key.startsWith(prefix)) as LocalRecord<T>[]
  if (!db) return memory
  return new Promise((resolve) => {
    const request = db.transaction('records', 'readonly').objectStore('records').getAll(IDBKeyRange.bound(prefix, prefix + '\uffff'))
    request.onsuccess = () => resolve([...new Map<string, LocalRecord<T>>([...request.result, ...memory].map((r: LocalRecord<T>) => [r.key, r])).values()])
    request.onerror = () => resolve(memory)
  })
}
export async function deleteRecord(key: string): Promise<void> {
  fallback.delete(key); const db = await open(); if (!db) return
  await new Promise<void>((resolve) => {
    const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').delete(key)
    tx.oncomplete = tx.onerror = tx.onabort = () => resolve()
  })
}
export async function clearRecords(prefix = ''): Promise<void> {
  for (const record of await listRecords(prefix)) await deleteRecord(record.key)
}
