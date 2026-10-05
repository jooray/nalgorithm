/**
 * Nalgorithm Web — digests in bring-your-own-key mode
 *
 * There is no server, so the digest is written in the browser from the posts
 * on screen, kept in a local history (newest first, at most 30) together with
 * the notes it was composed from, and played through the same player as a
 * hosted digest, using the browser's speech engine.
 */

import { generateDigest, synthesizeSpeech, type ProfileData, type ScoredPost } from 'nalgorithm'
import type { AppSettings } from './settings.js'
import { loadSettings } from './settings.js'
import { addDigestToHistory, identityKey, loadDigestHistory } from './local-data.js'
import { makeLocalDigest, readDigest, wordCount, type DigestRecord } from './digest-model.js'
import { addDigest, setDigests, showGenerating, type DigestBackend } from './digest-view.js'
import { snapshotOf } from './profiles.js'
import { clientRenderOptions } from './render.js'

/** The digests written in this browser for one identity, newest first. */
export function loadLocalDigests(identity: string): Promise<DigestRecord[]> {
  return loadDigestHistory('byok', identity, readDigest)
}

/**
 * Write a digest from these posts and put it in front of the reader.
 *
 * Reasoning models buffer before emitting anything, so the status runs on its
 * own clock and shows elapsed seconds: during the quiet stretch that is the
 * only signal separating "thinking" from "hung".
 */
export async function writeDigest(
  posts: ScoredPost[],
  profiles: Map<string, ProfileData>,
  settings: AppSettings
): Promise<string> {
  if (posts.length === 0) throw new Error('Nothing to summarize yet. Refresh your feed first.')

  const model = settings.digestModel.trim() || settings.model
  let streamed = ''
  const startedAt = Date.now()
  const paint = (): void => {
    const seconds = Math.round((Date.now() - startedAt) / 1000)
    const progress = streamed ? `${seconds}s, ${wordCount(streamed)} words` : `${seconds}s, thinking`
    showGenerating(true, `Writing your digest with ${model} (${progress})…`, streamed)
  }
  paint()
  const tick = window.setInterval(paint, 500)

  let text = ''
  let failure = ''
  try {
    text = await generateDigest(
      { apiBaseUrl: settings.apiBaseUrl, apiKey: settings.apiKey, model },
      {
        posts,
        profiles,
        userPrompt: settings.userPrompt,
        learnedPrompt: settings.learnedPrompt || undefined,
        topN: settings.digestTopN,
        forSpeech: settings.digestForSpeech,
        onDelta: (piece) => {
          streamed += piece
        },
      }
    )
  } catch (err) {
    failure = (err as Error).message
    // Whatever streamed in before the failure is real text; it is kept.
    text = streamed
  } finally {
    clearInterval(tick)
    showGenerating(false)
  }

  if (!text.trim()) throw new Error(`Digest failed: ${failure || 'the model returned nothing'}`)

  const record = makeLocalDigest({
    text,
    posts,
    topN: settings.digestTopN,
    profiles: snapshotOf(profiles),
  })
  const kept = await addDigestToHistory('byok', settings.npub, readDigest, record)
  // Written for the identity that asked; if Tune names another one now, it waits in that history.
  if (identityKey(loadSettings().npub) === identityKey(settings.npub)) addDigest(record)
  const unsaved = kept ? '' : ' This device could not save it, so it stays only until you close the page.'
  const summary = `${record.notes?.length ?? 0} notes, ${wordCount(record.text)} words, ${model}.${unsaved}`
  return failure
    ? `Digest failed part-way (${failure}). Kept the ${wordCount(record.text)} words that arrived.`
    : `Digest ready: ${summary}`
}

/** The Digests tab's view of bring-your-own-key mode. */
export function byokBackend(deps: {
  /** Posts currently ranked on screen, and their profiles; loads the feed first when there are none. */
  ensureFeed: () => Promise<{ posts: ScoredPost[]; profiles: Map<string, ProfileData> }>
  readSettings: () => AppSettings
  setStatus: (text: string, isError?: boolean) => void
}): DigestBackend {
  return {
    mode: 'byok',
    makeLabel: 'Write a digest',
    makeAnotherLabel: 'Write another digest',
    emptyText:
      'I write a spoken digest from the notes your feed ranks highest, and read it to you. Nothing plays until you press play.',
    async make() {
      const settings = deps.readSettings()
      const { posts, profiles } = await deps.ensureFeed()
      deps.setStatus('Writing…')
      const message = await writeDigest(posts, profiles, settings)
      deps.setStatus(message)
    },
    canMakeAudio: () => loadSettings().ttsModel.trim().length > 0,
    async makeAudio(d) {
      const s = loadSettings()
      const audio = await synthesizeSpeech(
        {
          apiBaseUrl: s.apiBaseUrl,
          apiKey: s.apiKey,
          model: s.ttsModel.trim(),
          voice: s.ttsVoice.trim() || undefined,
          format: 'mp3',
        },
        d.text
      )
      const blob = new Blob([audio as BlobPart], { type: 'audio/mpeg' })
      return {
        url: URL.createObjectURL(blob),
        filename: `nalgorithm-digest-${new Date(d.createdAt * 1000).toISOString().slice(0, 10)}.mp3`,
      }
    },
    renderOptions(profiles) {
      const s = loadSettings()
      return { profiles, ...clientRenderOptions(s, s.relays) }
    },
    relays: () => loadSettings().relays,
  }
}

export { setDigests }
