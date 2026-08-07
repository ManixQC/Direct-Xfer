plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ca.manix123.directxfer"
    compileSdk = 36

    defaultConfig {
        applicationId = "ca.manix123.directxfer"
        minSdk = 26
        targetSdk = 36
        versionCode = 10300
        versionName = "1.3.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables.useSupportLibrary = true
        resourceConfigurations += listOf("fr", "en", "es")
    }

    buildFeatures {
        // Item 1: expose BuildConfig.VERSION_NAME to show the version in the UI.
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity-ktx:1.11.0")
    implementation("androidx.fragment:fragment-ktx:1.8.9")
    // Item 24: refreshed to the newest biometric line (adds device-credential fixes).
    implementation("androidx.biometric:biometric:1.2.0-alpha05")
    implementation("androidx.work:work-runtime-ktx:2.11.2")
    implementation("androidx.exifinterface:exifinterface:1.4.1")
    // Item 21: bounded-concurrency gate uses kotlinx coroutines' suspending Semaphore.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    // Item 17: local QR rendering for the transfer detail sheet (pure-Java, no AWT).
    implementation("com.google.zxing:core:3.5.3")

    testImplementation("junit:junit:4.13.2")
}
