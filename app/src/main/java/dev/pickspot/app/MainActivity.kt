package dev.pickspot.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.viewModels
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.pickspot.app.presentation.PickupViewModel
import dev.pickspot.app.presentation.tripPreviewTarget
import dev.pickspot.app.presentation.TripPreviewViewModel
import dev.pickspot.app.ui.TripPreviewPanel
import dev.pickspot.app.ui.PickupScreen
import kotlinx.coroutines.launch
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import androidx.activity.result.contract.ActivityResultContracts
import dev.pickspot.app.location.PleosVehicleLocation
import dev.pickspot.app.presentation.VehicleLocationViewModel
import dev.pickspot.app.ui.VehicleLocationPanel
import dev.pickspot.app.domain.DrivingAccess
import dev.pickspot.app.driving.PleosDrivingAccess

class MainActivity : ComponentActivity() {
    private val launchScenario by lazy {
        dev.pickspot.app.data.RepositoryFactory.resolveScenario(applicationContext,
            if (BuildConfig.DEBUG) intent.getStringExtra("demo_scenario") else null)
    }
    private val viewModel: PickupViewModel by viewModels {
        viewModelFactory {
            initializer { AppContainer(applicationContext, launchScenario).pickupViewModel(createSavedStateHandle()) }
        }
    }
    private lateinit var screen: PickupScreen
    private val locationModel: VehicleLocationViewModel by viewModels {
        viewModelFactory { initializer { AppContainer(applicationContext).vehicleLocationViewModel() } }
    }
    private val tripPreviewModel: TripPreviewViewModel by viewModels {
        viewModelFactory { initializer { AppContainer(applicationContext).tripPreviewViewModel() } }
    }
    private lateinit var tripPreviewPanel: TripPreviewPanel
    private fun syncTripPreview() {
        val current = viewModel.state.value
        val allowed = current.canSelect && !current.endConfirmation &&
            lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
        tripPreviewModel.update(if(allowed) current.tripPreviewTarget() else null, allowed)
    }
    private lateinit var locationPanel: VehicleLocationPanel
    private val drivingAccess by lazy { PleosDrivingAccess(this) }
    private val locationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (viewModel.state.value.canInteract && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) locationModel.start(granted)
    }
    private fun hasLocationPermission() = ContextCompat.checkSelfPermission(this, PleosVehicleLocation.PERMISSION) == PackageManager.PERMISSION_GRANTED

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        screen = PickupScreen(this, viewModel::dispatch,
            competitionDemo = BuildConfig.DEBUG && launchScenario == "competition")
        setContentView(screen.view)
        tripPreviewPanel = TripPreviewPanel(this, screen.view) {
            viewModel.dispatch(dev.pickspot.app.presentation.PickupAction.CheckExpiry)
            syncTripPreview(); tripPreviewModel.request()
        }
        if (BuildConfig.DEBUG && launchScenario != "competition") {
            screen.view.findViewById<android.widget.Button>(R.id.vehicle_sharing_check).apply {
                visibility = android.view.View.VISIBLE
                setOnClickListener {
                    if (viewModel.state.value.canInteract) startActivity(android.content.Intent().setClassName(packageName, "$packageName.sharing.SharingActivity"))
                }
            }
            screen.view.findViewById<android.widget.Button>(R.id.vehicle_location_accuracy_check).apply {
                visibility = android.view.View.VISIBLE
                setOnClickListener {
                    if (viewModel.state.value.canInteract) startActivity(android.content.Intent().setClassName(packageName, "$packageName.debug.LocationProbeActivity"))
                }
            }
        }
        locationPanel = VehicleLocationPanel(this, screen.view, onStart = {
            if (viewModel.state.value.canInteract && locationModel.checkSupported()) {
                if (hasLocationPermission()) locationModel.start(true)
                else locationPermission.launch(PleosVehicleLocation.PERMISSION)
            }
        }, onStop = locationModel::stop)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                viewModel.dispatch(dev.pickspot.app.presentation.PickupAction.CheckExpiry)
                launch { viewModel.state.collect { screen.render(it); syncTripPreview() } }
                launch { tripPreviewModel.state.collect(tripPreviewPanel::render) }
                launch { locationModel.state.collect { locationPanel.render(it); viewModel.updateVehicleLocation(it) } }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        drivingAccess.start { access ->
            viewModel.updateDrivingAccess(access)
            syncTripPreview()
            if (access != DrivingAccess.AVAILABLE) locationModel.stop()
        }
        locationModel.onForeground(hasLocationPermission())
    }
    override fun onStop() {
        drivingAccess.stop()
        tripPreviewModel.update(null, false)
        viewModel.updateDrivingAccess(DrivingAccess.UNKNOWN)
        locationModel.onBackground()
        viewModel.updateVehicleLocation(dev.pickspot.app.domain.VehicleLocationState())
        super.onStop()
    }

    override fun onDestroy() {
        drivingAccess.stop()
        screen.dispose()
        super.onDestroy()
    }
}
