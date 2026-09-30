import { useWebSocketImplementation } from 'nostr-tools/pool'
import WebSocket from 'ws'

/**
 * A `ws` socket that can never raise an unhandled 'error'.
 *
 * `ws` is an EventEmitter and throws when it emits 'error' with no listener.
 * nostr-tools closes a still-connecting socket from its connection-timeout
 * timer; `ws` reacts by emitting 'error', and if nostr-tools has already
 * dropped or not yet attached its handler, the throw becomes an uncaught
 * exception that kills the whole process. A permanent no-op listener makes the
 * emit harmless; nostr-tools still attaches its own handlers as before.
 */
export class SafeWebSocket extends WebSocket {
  constructor(address: string | URL, protocols?: string | string[]) {
    super(address, protocols)
    this.on('error', () => {})
  }
}

/**
 * Give nostr-tools the `ws` package (through {@link SafeWebSocket}) instead of
 * Node's built-in WebSocket.
 *
 * On Node 22 the built-in one recurses to a stack overflow when a relay
 * connection fails: nostr-tools calls `ws.close()` inside its own `onerror`,
 * undici fires another `error` event from `close()`, and the process dies. A
 * single unreachable relay would then take the whole server down.
 *
 * Must run once at startup, before the first relay connection. It only works if
 * the server and the library resolve the same `nostr-tools` copy, which the
 * packed-library deploy guarantees (one copy under server/node_modules).
 */
export function configureWebSocket(): void {
  useWebSocketImplementation(SafeWebSocket)
}
