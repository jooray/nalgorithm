import { getRecord, putRecord, listRecords, deleteRecord, clearRecords, isRecordDurable } from './records.js'

export const AUDIO_COUNT = 3
export const AUDIO_MAX_BYTES = 30 * 1024 * 1024
export const AUDIO_ITEM_MAX_BYTES = 15 * 1024 * 1024
interface SavedAudio { blob: Blob; createdAt: number; owner: string; id: string }
const keyOf = (owner: string, id: string): string => `audio:${owner}:${id}`
const pending = new Map<string, Promise<Blob>>()
export async function readOfflineAudio(owner: string, id: string): Promise<Blob | null> {
  if (!await isRecordDurable(keyOf(owner, id))) return null
  return (await getRecord<SavedAudio>(keyOf(owner, id)))?.blob ?? null
}
export async function saveOfflineAudio(owner: string, id: string, createdAt: number, blob: Blob): Promise<boolean> {
  if (blob.size > AUDIO_ITEM_MAX_BYTES) throw new Error('Audio is too large for the offline cache. Download the MP3 instead.')
  const persisted = await putRecord(keyOf(owner,id), { blob, createdAt, owner, id })
  const records = (await listRecords<SavedAudio>('audio:')).sort((a,b)=>b.value.createdAt-a.value.createdAt)
  let count=0,bytes=0
  for (const record of records) {
    if (record.value.owner !== owner || count >= AUDIO_COUNT || bytes + record.value.blob.size > AUDIO_MAX_BYTES) await deleteRecord(record.key)
    else { count++; bytes += record.value.blob.size }
  }
  return persisted
}
export function fetchAudioBlob(owner: string, id: string, url: string, maxBytes = AUDIO_ITEM_MAX_BYTES): Promise<Blob> {
  const key=keyOf(owner,id); const existing=pending.get(key); if(existing)return existing
  const work=(async()=>{
    const saved=await readOfflineAudio(owner,id);if(saved)return saved
    const parsed=new URL(url, globalThis.location?.href)
    if(!['https:','http:','blob:'].includes(parsed.protocol))throw new Error('Unsafe audio address.')
    const response=await fetch(parsed.toString(), { credentials: parsed.origin===globalThis.location?.origin?'same-origin':'omit', referrerPolicy:'no-referrer', signal:AbortSignal.timeout(60000) })
    if(!response.ok||!response.body)throw new Error('Audio download failed. Check your connection.')
    if(Number(response.headers.get('content-length'))>maxBytes){await response.body.cancel();throw new Error('Audio is too large for this download.')}
    const reader=response.body.getReader();const parts:Uint8Array[]=[];let bytes=0
    for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>maxBytes){await reader.cancel();throw new Error('Audio exceeded the download size limit.')}parts.push(part.value)}
    return new Blob(parts as BlobPart[],{type:'audio/mpeg'})
  })().finally(()=>pending.delete(key))
  pending.set(key,work);return work
}
export async function offlineAudioBytes(): Promise<number> { return (await listRecords<SavedAudio>('audio:')).reduce((n,r)=>n+r.value.blob.size,0) }
export const clearOfflineAudio=():Promise<void>=>clearRecords('audio:')
