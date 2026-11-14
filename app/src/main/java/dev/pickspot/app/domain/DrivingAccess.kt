package dev.pickspot.app.domain

/** App interaction policy, not an inferred vehicle speed or gear. */
enum class DrivingAccess {
    UNKNOWN, RESTRICTED, AVAILABLE;

    companion object {
        // No distraction-optimized declaration: allow only unrestricted baseline UX.
        fun fromPlatform(requiresOptimization: Boolean, restrictions: Int): DrivingAccess = when {
            restrictions < 0 -> UNKNOWN
            requiresOptimization || restrictions != 0 -> RESTRICTED
            else -> AVAILABLE
        }
    }
}
