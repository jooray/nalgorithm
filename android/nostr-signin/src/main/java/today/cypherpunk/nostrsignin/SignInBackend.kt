package today.cypherpunk.nostrsignin

/**
 * The server side of sign-in, implemented by each app over its own HTTP client.
 * The canonical endpoints (see README.md) are:
 *
 *   POST   /api/v1/auth/challenge     → {challenge, domain}
 *   POST   /api/v1/auth/token         {signed_event, device_name} → {token, user}
 *   POST   /api/v1/auth/nostrconnect  → {session_id, poll_token, uri}
 *   POST   /api/v1/auth/bunker        {bunker_uri} → {session_id, poll_token}
 *   POST   /api/v1/auth/poll          {session_id, poll_token, device_name}
 *                                     → {status: pending|expired|authenticated, auth_url?, token?, user?}
 *   DELETE /api/v1/session            (sign out)
 *
 * [exchangeSignedEvent] and [poll] store the issued device token themselves;
 * the controller only needs to know that it happened. Throw on failure; the
 * app renders its own exceptions from [SignInState.Failed.cause].
 */
interface SignInBackend {
    suspend fun challenge(): Challenge

    suspend fun exchangeSignedEvent(signedEventJson: String)

    suspend fun startNostrConnect(): ConnectSession

    suspend fun startBunker(bunkerUri: String): ConnectSession

    suspend fun poll(session: ConnectSession): PollResult

    /** Errors worth retrying while polling (network blips, 429). */
    fun isTransient(error: Throwable): Boolean = false
}

data class Challenge(val challenge: String, val domain: String)

data class ConnectSession(val sessionId: String, val pollToken: String?, val uri: String?)

sealed interface PollResult {
    data class Pending(val authUrl: String? = null) : PollResult
    data object Expired : PollResult
    data object Authenticated : PollResult
}
