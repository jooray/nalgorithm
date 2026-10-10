import java.io.File
import java.util.Properties
import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Release signing with the publisher's shared key, kept outside the repo.
// Without the properties file the release APK is built unsigned.
val signingProperties = Properties().apply {
    val path = System.getenv("APP_SIGNING_PROPERTIES")
        ?: "${System.getProperty("user.home")}/.apk-signing-keystore/signing.properties"
    File(path).takeIf { it.exists() }?.inputStream()?.use { load(it) }
}

/**
 * The humanizer prompt is the vendored skill in lib/skills/humanizer/SKILL.md
 * (see AGENTS.md). It is packaged as an asset straight from there, so the app
 * never carries a second copy that could drift.
 */
abstract class HumanizerAsset : DefaultTask() {
    @get:InputFile @get:PathSensitive(PathSensitivity.NONE) abstract val skill: RegularFileProperty
    @get:OutputDirectory abstract val outputDir: DirectoryProperty

    @TaskAction fun copy() {
        val out = outputDir.get().asFile
        out.deleteRecursively()
        out.mkdirs()
        skill.get().asFile.copyTo(File(out, "humanizer-skill.md"), overwrite = true)
    }
}

val humanizerAsset = tasks.register<HumanizerAsset>("humanizerAsset") {
    skill.set(rootProject.layout.projectDirectory.file("../lib/skills/humanizer/SKILL.md"))
}

android {
    namespace = "today.cypherpunk.nalgorithm"
    compileSdk = 37

    defaultConfig {
        applicationId = "today.cypherpunk.nalgorithm"
        minSdk = 26
        targetSdk = 37
        // Zapstore and Android refuse an update with an equal or lower code. Bump on every release.
        versionCode = 1
        versionName = "1.0.0"
        buildConfigField("String", "HOSTED_BASE", "\"https://nalgorithm.cypherpunk.today/app/api/\"")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (signingProperties.getProperty("storeFile") != null) {
            create("release") {
                storeFile = file(signingProperties.getProperty("storeFile"))
                storePassword = signingProperties.getProperty("storePassword")
                keyAlias = signingProperties.getProperty("keyAlias")
                keyPassword = signingProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            isReturnDefaultValues = true
        }
    }

    // Reproducibility: no build-time dependency metadata baked into the APK.
    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(humanizerAsset, HumanizerAsset::outputDir)
    }
}

dependencies {
    implementation(project(":nostr-signin"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.datastore.preferences)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons.extended)
    debugImplementation(libs.compose.ui.tooling)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.okhttp.sse)
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)
    implementation(libs.zxing.core)
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.session)
    implementation(libs.media3.ui)
    implementation(libs.secp256k1.jni.android)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.mockwebserver)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.secp256k1.jni.jvm)
}
