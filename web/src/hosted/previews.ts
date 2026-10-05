/**
 * Link cards under posts (hosted mode). A card is added for the first URLs of a
 * post, fetched from the server only when it nears the screen. If the server
 * has nothing to show, or fails, the plain link in the text is all there is.
 *
 * Markup is a link containing an optional image and three text lines; class
 * names start with `link-preview`. All server text goes in through textContent,
 * and the image source can only be the server's own image path.
 */

import { getPreview, previewImageSrc } from './api.js'
import { extractPreviewUrls, readLinkCard, type LinkCard } from './previews-logic.js'
import { onDispose } from '../lifecycle.js'

const MAX_PARALLEL = 2
const answers = new Map<string, Promise<LinkCard | null>>()
let running = 0
const waiting: Array<() => void> = []

async function limited<T>(job: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r))
  else running++
  try {
    return await job()
  } finally {
    const next = waiting.shift()
    if (next) next()
    else running--
  }
}

function load(url: string): Promise<LinkCard | null> {
  if (answers.size >= 256) answers.delete(answers.keys().next().value!)
  let p = answers.get(url)
  if (!p) {
    p = limited(() => getPreview(url)).then(readLinkCard)
    // A failure (offline, rate limited) is not remembered, so a later render can retry.
    p.catch(() => answers.delete(url))
    answers.set(url, p)
  }
  return p
}

function line(className: string, text: string): HTMLElement {
  const span = document.createElement('span')
  span.className = className
  span.textContent = text
  return span
}

function buildCard(url: string, card: LinkCard): HTMLAnchorElement {
  const a = document.createElement('a')
  a.className = 'link-preview'
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  if (card.image) {
    const img = document.createElement('img')
    img.className = 'link-preview-image'
    img.src = previewImageSrc(card.image)
    img.alt = ''
    img.loading = 'lazy'
    img.onerror = () => img.remove()
    a.appendChild(img)
  }
  const body = document.createElement('span')
  body.className = 'link-preview-body'
  if (card.siteName) body.appendChild(line('link-preview-site', card.siteName))
  if (card.title) body.appendChild(line('link-preview-title', card.title))
  if (card.description) body.appendChild(line('link-preview-desc', card.description))
  a.appendChild(body)
  return a
}

let observer: IntersectionObserver | null = null
const pending = new WeakMap<Element, () => void>()

function whenNear(el: Element, run: () => void): void {
  if (typeof IntersectionObserver === 'undefined') return run()
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        observer?.unobserve(e.target)
        pending.get(e.target)?.()
        pending.delete(e.target)
      }
    },
    { rootMargin: '300px' },
  )
  pending.set(el, run)
  observer.observe(el)
  onDispose(el, () => { observer?.unobserve(el); pending.delete(el) })
}

/** The `linkPreviews` hook for the renderer: adds cards for the URLs in `content` to `post`. */
export function attachLinkPreviews(content: string, post: HTMLElement): void {
  const urls = extractPreviewUrls(content, location.host)
  if (urls.length === 0) return
  const list = document.createElement('div')
  list.className = 'link-previews'
  for (const url of urls) {
    const slot = document.createElement('div')
    slot.className = 'link-preview link-preview-loading'
    slot.setAttribute('aria-hidden', 'true')
    list.appendChild(slot)
    whenNear(slot, () => {
      if (!slot.isConnected) return
      load(url).then(
        (card) => {
          if (!slot.isConnected) return
          if (card) slot.replaceWith(buildCard(url, card))
          else slot.remove()
        },
        () => slot.remove(),
      )
    })
  }
  post.appendChild(list)
}
