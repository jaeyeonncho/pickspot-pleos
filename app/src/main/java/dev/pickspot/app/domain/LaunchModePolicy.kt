package dev.pickspot.app.domain

/** Only known local connection modes persist; diagnostic fixtures are one-launch choices. */
object LaunchModePolicy {
    fun resolve(requested: String?, saved: String?): String? = requested ?: saved?.takeIf { it in setOf("local", "competition") }
}
