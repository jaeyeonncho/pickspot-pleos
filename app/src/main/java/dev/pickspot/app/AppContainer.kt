package dev.pickspot.app

import android.content.Context
import androidx.lifecycle.SavedStateHandle
import dev.pickspot.app.data.RepositoryFactory
import dev.pickspot.app.domain.PickupRecommender
import dev.pickspot.app.navigation.PleosNavigator
import dev.pickspot.app.presentation.PickupViewModel
import dev.pickspot.app.presentation.VehicleLocationViewModel
import dev.pickspot.app.location.PleosVehicleLocation
import android.os.SystemClock

/** The only place that chooses demo/live implementations. Never retain an Activity here. */
class AppContainer(context: Context, private val scenario: String? = null) {
    private val appContext = context.applicationContext
    fun tripPreviewViewModel() = dev.pickspot.app.presentation.TripPreviewViewModel(
        dev.pickspot.app.navigation.PleosTripPreview(appContext), SystemClock::elapsedRealtime)
    fun vehicleLocationViewModel() = VehicleLocationViewModel(
        PleosVehicleLocation(appContext), System::currentTimeMillis, SystemClock::elapsedRealtime
    )
    fun pickupViewModel(handle: SavedStateHandle) = PickupViewModel(
        handle, RepositoryFactory.create(scenario, appContext), PickupRecommender(), PleosNavigator(appContext)
    )
}
