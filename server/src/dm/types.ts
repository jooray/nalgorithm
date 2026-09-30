/** Logger shape shared by the DM modules; structurally compatible with the server's PipelineLogger. */
export interface DmLogger {
  info(msg: string): void
  warn(msg: string): void
}

export const silentLogger: DmLogger = { info() {}, warn() {} }

export type DmProtocol = 'nip17' | 'nip04'

export interface IncomingDm {
  /** Verified sender: the seal signer for NIP-17, the event author for NIP-04. */
  senderPubkey: string
  content: string
  protocol: DmProtocol
  /** Rumor id for NIP-17, event id for NIP-04. */
  rumorId: string
  /** Unix seconds from the rumor/event, clamped to at most now + 15 minutes. */
  createdAt: number
  /** Unix seconds. */
  receivedAt: number
  /** Relay the first copy arrived on. Later copies from other relays are dropped as duplicates. */
  relay?: string
}

export type PublishStatus = 'ok' | 'rejected' | 'timeout' | 'error'

export interface RelayOutcome {
  status: PublishStatus
  reason?: string
}
