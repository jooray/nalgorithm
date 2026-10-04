import 'fake-indexeddb/auto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import vm from 'node:vm'

const compiled = await build({entryPoints:['src/offline-audio.ts'],absWorkingDir:new URL('..',import.meta.url).pathname,bundle:true,write:false,platform:'node',format:'cjs'})
const module={exports:{}}
vm.runInNewContext(compiled.outputFiles[0].text,{module,exports:module.exports,indexedDB,IDBKeyRange,Blob,Map,URL,AbortSignal,fetch,setTimeout,clearTimeout,console})
const {saveOfflineAudio,readOfflineAudio,clearOfflineAudio,offlineAudioBytes,AUDIO_ITEM_MAX_BYTES}=module.exports
test('offline audio retains newest three, restores blobs and isolates readers',async()=>{
  await clearOfflineAudio()
  for(let n=1;n<=4;n++)await saveOfflineAudio('reader-a',String(n),n,new Blob(['audio'+n],{type:'audio/mpeg'}))
  assert.equal(await readOfflineAudio('reader-a','1'),null)
  assert.equal(await (await readOfflineAudio('reader-a','4')).text(),'audio4')
  assert.equal(await readOfflineAudio('reader-b','4'),null)
  await saveOfflineAudio('reader-b','b',5,new Blob(['new-reader']))
  assert.equal(await readOfflineAudio('reader-a','4'),null)
  await clearOfflineAudio();assert.equal(await offlineAudioBytes(),0)
})
test('oversized audio is refused before it can exceed the cache budget',async()=>{
  await assert.rejects(saveOfflineAudio('reader','large',1,new Blob([new Uint8Array(AUDIO_ITEM_MAX_BYTES+1)])),/too large/)
})
