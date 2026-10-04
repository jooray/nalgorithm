import { pubkeyToHex } from 'nalgorithm'
export interface SetupFields {
  npub: string; relays: string[]; apiBaseUrl: string; apiKey: string; model: string
  userPrompt: string; hoursBack: number; digestTopN: number; batchSize: number; concurrency: number
  scorer: string; decisionModel: string
}
export interface FieldProblem { field: string; message: string }
export function setupProblem(s: SetupFields): FieldProblem | null {
  const bad = (field: string, message: string): FieldProblem => ({ field, message })
  try { pubkeyToHex(s.npub.trim()) } catch { return bad('input-npub', 'Enter a valid public npub, nprofile or 64-character public key. Never paste a private key.') }
  let url: URL
  try {
    url = new URL(s.apiBaseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error()
  } catch { return bad('input-api-base', 'Use an HTTPS model API URL, or HTTP localhost for a local model.') }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !s.apiKey.trim()) return bad('input-api-key', 'Add the API key for this provider. Local models need no key.')
  if (!s.model.trim()) return bad('input-model', 'Choose a chat model for scoring, digest writing and learning.')
  if (!s.userPrompt.trim() || s.userPrompt.length > 2000) return bad('input-user-prompt', 'Describe your interests in 1–2,000 characters.')
  if (!s.relays.length || s.relays.some((r) => { try { const u = new URL(r); return u.protocol !== 'wss:' && !(u.protocol === 'ws:' && ['localhost', '127.0.0.1'].includes(u.hostname)) } catch { return true } })) return bad('input-relays', 'Enter at least one valid wss:// relay address.')
  for (const [field, value, min, max] of [
    ['input-hours-back', s.hoursBack, 1, 168], ['input-digest-topn', s.digestTopN, 3, 50],
    ['input-batch-size', s.batchSize, 5, 50], ['input-concurrency', s.concurrency, 1, 10],
  ] as const) if (!Number.isInteger(value) || value < min || value > max) return bad(field, `Use a whole number from ${min} to ${max}.`)
  if (s.scorer === 'decision' && (!s.decisionModel.trim() || url.hostname !== 'api.venice.ai')) return bad('select-scorer', 'Decision scoring requires Venice and a decision model. Choose Chat for other providers.')
  return null
}
