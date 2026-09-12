plugins {
    id("com.android.application")
}

android {
    namespace = "app.sloi.map"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.sloi.map"
        minSdk = 26
        targetSdk = 36
        versionCode = 6
        versionName = "0.5.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.16.0")
    implementation("org.locationtech.jts:jts-core:1.20.0")
    testImplementation("junit:junit:4.13.2")
}
