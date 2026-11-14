plugins {
    id("com.android.application") version "8.8.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.0" apply false
}

// Keep generated files outside the Documents workspace (which may be cloud-synced).
// Override with -Ppickspot.buildRoot=/path on CI or another workstation.
val cacheBase = if (System.getProperty("os.name").startsWith("Mac")) "Library/Caches" else ".cache"
val localBuildRoot = providers.gradleProperty("pickspot.buildRoot").getOrElse(
    File(System.getProperty("user.home"), "$cacheBase/Pickspot/${rootDir.absolutePath.hashCode().toUInt().toString(16)}").path
)
layout.buildDirectory.set(file("$localBuildRoot/root"))
subprojects { layout.buildDirectory.set(file("$localBuildRoot/${project.name}")) }

tasks.register<Copy>("exportDebugApk") {
    dependsOn(":app:assembleDebug")
    from(project(":app").layout.buildDirectory.file("outputs/apk/debug/app-debug.apk"))
    into(layout.projectDirectory.dir("artifacts"))
    rename { "pickspot-demo.apk" }
}

tasks.register<Copy>("exportTripProbeApk") {
    dependsOn(":app:assembleDebugAndroidTest")
    from(project(":app").layout.buildDirectory.file("outputs/apk/androidTest/debug/app-debug-androidTest.apk"))
    into(layout.projectDirectory.dir("artifacts"))
    rename { "pickspot-trip-probe.apk" }
}
