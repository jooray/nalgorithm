import { build } from 'esbuild'
import { parseHTML } from 'linkedom'
import { webcrypto } from 'node:crypto'
import vm from 'node:vm'

/** DOM unit fixture only: not a substitute for browser layout/device testing. */
export async function domModule(entry, html = '<html><body><section id="view-feed"><div id="feed-list"></div></section></body></html>') {
  const compiled = await build({ entryPoints: [entry], absWorkingDir: new URL('..', import.meta.url).pathname, bundle: true, write: false, platform: 'browser', format: 'cjs', logLevel: 'silent' })
  const { window, document } = parseHTML(html)
  window.scrollY = 0
  window.scrollTo = () => {}
  window.scrollBy = () => {}
  window.getSelection = () => ({ toString: () => '' })
  window.matchMedia = () => ({ matches: false, addEventListener() {} })
  const module = { exports: {} }
  const context = { module, exports: module.exports, document, window, location: { hash: '#feed', href: 'https://example.test/app/', host: 'example.test', origin: 'https://example.test' },
    navigator: { onLine: true }, crypto: webcrypto, URL, URLSearchParams, Map, Set, WeakMap, TextEncoder, TextDecoder, Blob, AbortSignal, console,
    HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, HTMLSelectElement: window.HTMLSelectElement,
    Event: window.Event, CustomEvent: window.CustomEvent, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    fetch: () => { throw Error('Unexpected network call in DOM fixture') },
  }
  vm.runInNewContext(compiled.outputFiles[0].text, context)
  return { exports: module.exports, document, window, context }
}
