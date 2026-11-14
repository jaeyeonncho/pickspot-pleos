package dev.pickspot.app.data

import dev.pickspot.app.domain.PickupRepository
import kotlinx.coroutines.delay
import java.io.IOException

/** Emulator fixtures only; this implementation is not packaged in a release build. */
object RepositoryFactory {
    fun resolveScenario(context: android.content.Context, requested: String?): String? {
        val settings = context.applicationContext.getSharedPreferences("launch_mode", android.content.Context.MODE_PRIVATE)
        val resolved = dev.pickspot.app.domain.LaunchModePolicy.resolve(requested, settings.getString("mode", null))
        if (requested != null) settings.edit().apply {
            if (resolved in setOf("local", "competition")) putString("mode", resolved) else remove("mode")
        }.apply()
        return resolved
    }

    fun create(scenario: String?, context: android.content.Context): PickupRepository = when(scenario) {
        "local" -> LocalSessionRepository(context)
        "competition" -> LocalSessionRepository(context,LocalSessionMode.COMPETITION)
        else -> fixture(scenario)
    }
    private fun fixture(scenario:String?):PickupRepository = object : PickupRepository {
        private var attempts = 0
        override suspend fun loadSession() = run {
            attempts++
            when (scenario) {
                "slow" -> delay(5_000)
                "timeout" -> delay(20_000)
                "retry" -> if (attempts == 1) throw IOException("Demo fixture")
            }
            val session = DemoPickupRepository.sampleSession()
            when (scenario) {
                "empty" -> session.copy(candidates = emptyList())
                "expired" -> session.copy(expiresAtEpochMillis = System.currentTimeMillis() - 1)
                "expires_soon" -> session.copy(expiresAtEpochMillis = System.currentTimeMillis() + 10_000)
                else -> session
            }
        }
    }
}
