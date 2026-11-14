package dev.pickspot.app.data

import dev.pickspot.app.domain.PickupRepository

/** Live API credentials and a backend have not been configured; release also uses demo data. */
object RepositoryFactory {
    fun resolveScenario(@Suppress("UNUSED_PARAMETER") context: android.content.Context,
        @Suppress("UNUSED_PARAMETER") requested: String?): String? = null

    fun create(@Suppress("UNUSED_PARAMETER") scenario: String?, @Suppress("UNUSED_PARAMETER") context: android.content.Context): PickupRepository = DemoPickupRepository()
}
