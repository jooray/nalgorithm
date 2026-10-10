// Nostr sign-in for Android apps: NIP-55 (a signer app on this phone, e.g. Amber)
// and NIP-46 (nostrconnect:// and bunker://) against a server that issues device
// tokens. Source of truth: ~/projects/nostr-signin-android. Apps vendor this
// directory with that repo's sync.sh; do not edit a vendored copy.
//
// Uses the host project's version catalog (`libs`), so versions follow the app.
plugins {
    id("com.android.library")
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "today.cypherpunk.nostrsignin"
    compileSdk = 37

    defaultConfig {
        minSdk = 26
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }
}

dependencies {
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.zxing.core)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
