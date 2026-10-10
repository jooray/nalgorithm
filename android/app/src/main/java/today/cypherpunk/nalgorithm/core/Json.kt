package today.cypherpunk.nalgorithm.core

import kotlinx.serialization.json.Json

/** One JSON configuration for the whole app: lenient on input, compact on output. */
val AppJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
    coerceInputValues = true
    isLenient = true
}
