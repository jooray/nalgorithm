import { createHash } from 'node:crypto'
import { finalizeEvent } from 'nostr-tools/pure'
import type { PipelineLogger } from 'nalgorithm'

export interface BlossomOptions {
  /** Base URLs, tried in order until one accepts the upload. */
  servers: string[]
  secretKey: Uint8Array
  log: PipelineLogger
  fetch?: typeof fetch
  now?: () => number
}

export interface UploadedAudio {
  /** A plain https URL ending in `.mp3` that plays in any browser. */
  url: string
  server: string
  sha256: string
  /** Content-Type the server serves the URL with, if it could be checked. */
  servedAs?: string
}

/** Kind 24242 upload authorisation (BUD-02): bound to the file hash and short-lived. */
function authHeader(secretKey: Uint8Array, sha256: string, nowSec: number): string {
  const event = finalizeEvent(
    {
      kind: 24242,
      created_at: nowSec,
      tags: [
        ['t', 'upload'],
        ['x', sha256],
        ['expiration', String(nowSec + 300)],
      ],
      content: 'Upload nalgorithm digest',
    },
    secretKey,
  )
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
}

const withMp3 = (url: string): string => (/\.[a-z0-9]{2,4}$/i.test(new URL(url).pathname) ? url : `${url}.mp3`)

/**
 * Upload audio to the first Blossom server that accepts it.
 *
 * The returned URL always carries an `.mp3` extension because Nostr clients and
 * browsers decide inline playback by extension and content type, and many
 * servers hand back a bare `/<sha256>` URL. Blossom resolves by hash and ignores
 * the extension, so appending it is safe; the result is checked with a HEAD
 * request and the bare URL is used if the extension variant does not resolve.
 */
export async function uploadAudio(opts: BlossomOptions, data: Uint8Array, contentType = 'audio/mpeg'): Promise<UploadedAudio> {
  const doFetch = opts.fetch ?? fetch
  const nowSec = opts.now ? opts.now() : Math.floor(Date.now() / 1000)
  const sha256 = createHash('sha256').update(data).digest('hex')
  const failures: string[] = []

  for (const server of opts.servers) {
    const base = server.replace(/\/+$/, '')
    try {
      const res = await doFetch(`${base}/upload`, {
        method: 'PUT',
        body: data,
        headers: { 'Content-Type': contentType, 'X-SHA-256': sha256, Authorization: authHeader(opts.secretKey, sha256, nowSec) },
        signal: AbortSignal.timeout(60_000),
      })
      if (res.status !== 200 && res.status !== 201) {
        throw new Error(`answered ${res.status}${res.headers.get('x-reason') ? ` (${res.headers.get('x-reason')})` : ''}`)
      }
      const descriptor = (await res.json()) as { url?: unknown }
      if (typeof descriptor.url !== 'string') throw new Error('response has no url')
      const bare = descriptor.url
      new URL(bare) // reject a malformed url before using it

      const candidate = withMp3(bare)
      const check = async (u: string): Promise<string | null> => {
        try {
          const head = await doFetch(u, { method: 'HEAD', signal: AbortSignal.timeout(15_000) })
          return head.ok ? (head.headers.get('content-type') ?? '') : null
        } catch {
          return null
        }
      }
      let url = candidate
      let servedAs = await check(candidate)
      if (servedAs === null && candidate !== bare) {
        servedAs = await check(bare)
        if (servedAs !== null) url = bare
      }
      if (servedAs !== null && !servedAs.startsWith('audio/')) {
        opts.log.warn(`${base} serves the upload as "${servedAs}", not audio: it may download instead of playing`)
      }
      return { url, server: base, sha256, ...(servedAs ? { servedAs } : {}) }
    } catch (err) {
      failures.push(`${base}: ${(err as Error).message}`)
      opts.log.warn(`blossom upload to ${base} failed: ${(err as Error).message}`)
    }
  }
  throw new Error(`no Blossom server accepted the upload (${failures.join('; ')})`)
}
