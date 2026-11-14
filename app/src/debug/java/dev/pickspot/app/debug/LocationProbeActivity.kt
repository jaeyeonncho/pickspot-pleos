package dev.pickspot.app.debug

import android.Manifest
import android.os.Bundle
import android.os.SystemClock
import android.widget.Button
import androidx.activity.ComponentActivity
import androidx.activity.viewModels
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.pickspot.app.R
import dev.pickspot.app.driving.PleosDrivingAccess
import dev.pickspot.app.location.AndroidMeasuredLocation
import dev.pickspot.app.location.PleosVehicleRouteReader
import dev.pickspot.app.presentation.VehicleInputViewModel
import dev.pickspot.app.presentation.LiveRouteViewModel
import dev.pickspot.app.presentation.VehiclePairingViewModel
import dev.pickspot.app.domain.VehiclePairingGrant
import dev.pickspot.app.domain.LiveRouteFailure
import dev.pickspot.app.presentation.VehiclePairingPhase
import dev.pickspot.app.routing.*
import kotlinx.coroutines.launch

/** Vehicle input and comparison UI. The trusted pairing endpoint is currently unconfigured. */
class LocationProbeActivity:ComponentActivity(){
    private var connection:LiveRouteConnection?=null
    private var connectedGrant:VehiclePairingGrant?=null
    private val pairing:VehiclePairingViewModel by viewModels {viewModelFactory {initializer {
        VehiclePairingViewModel(VehiclePairingConfiguration.origin()?.let{HttpsVehiclePairingGateway(it)},System::currentTimeMillis,SystemClock::elapsedRealtime)
    }}}
    private var consentDialog:LiveRouteConsentDialog?=null
    private val comparison:LiveRouteViewModel by viewModels {viewModelFactory {initializer {
        LiveRouteViewModel(null,System::currentTimeMillis,SystemClock::elapsedRealtime)
    }}}
    private val reader by lazy { AndroidMeasuredLocation(applicationContext) }
    private val driving by lazy { PleosDrivingAccess(this) }
    private val model:VehicleInputViewModel by viewModels {viewModelFactory {initializer {
        VehicleInputViewModel(reader,PleosVehicleRouteReader(applicationContext),System::currentTimeMillis,SystemClock::elapsedRealtime)
    }}}
    private val permissions=registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()){
        if(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)&&model.state.value.canInteract){
            if(reader.hasPermission())model.start() else model.permissionMissing()
        }
    }
    override fun onCreate(savedInstanceState:Bundle?){
        super.onCreate(savedInstanceState);setContentView(R.layout.activity_location_probe)
        val root=findViewById<android.view.View>(android.R.id.content)
        val pairingPanel=VehiclePairingPanel(this,root,pairing::start,{pairing.clear();applyConnection(null)})
        val screen=VehicleInputScreen(this,root,model::choose)
        val routePanel=LiveRoutePanel(this,root,{
            synchronizeInput();comparison.requestConsent()
        },comparison::cancel)
        findViewById<Button>(R.id.probe_start).setOnClickListener {
            if(model.state.value.canInteract){
                if(reader.hasPermission())model.start() else permissions.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION,Manifest.permission.ACCESS_COARSE_LOCATION))
            }
        }
        findViewById<Button>(R.id.probe_stop).setOnClickListener {model.stop()}
        findViewById<Button>(R.id.probe_route_refresh).setOnClickListener {model.refreshRoute()}
        findViewById<Button>(R.id.probe_back).setOnClickListener {finish()}
        lifecycleScope.launch {repeatOnLifecycle(Lifecycle.State.STARTED){
            launch {model.state.collect{input->
                screen.render(input);pairing.updateAccess(input.access);applyConnection(pairing.connection());synchronizeInput()
                pairingPanel.render(pairing.state.value,input.canInteract)
                routePanel.render(comparison.state.value,input.canInteract)
                consentDialog?.render(comparison.state.value,input.canInteract)
            }}
            launch {pairing.state.collect{state->
                applyConnection(pairing.connection());pairingPanel.render(state,model.state.value.canInteract)
            }}
            launch {comparison.state.collect{state->
                if(state.issue==LiveRouteFailure.ACCESS){pairing.clear(VehiclePairingPhase.FAILED);applyConnection(null)}
                routePanel.render(state,model.state.value.canInteract)
                consentDialog?.render(state,model.state.value.canInteract)
            }}
        }}
    }
    private fun applyConnection(next:VehiclePairingGrant?){
        if(connectedGrant===next)return
        consentDialog?.close();consentDialog=null;connectedGrant=next
        connection=next?.let{LiveRouteConnection.configured(it.origin,it.processingRegion,it.sessionId,it.vehicleToken,it.candidateIds)}
        comparison.connect(connection?.gateway)
        connection?.let{live->consentDialog=LiveRouteConsentDialog(this,live.disclosure,{id->
            synchronizeInput();comparison.confirmConsent(id)
        },{id->comparison.dismissConsent(id)})}
        synchronizeInput()
    }
    private fun synchronizeInput(){
        if(model.state.value.running&&!reader.hasPermission())model.permissionMissing()
        comparison.updateInput(model.state.value,connection?.candidateIds.orEmpty())
    }
    override fun onStart(){
        super.onStart();model.onForeground();comparison.onForeground();pairing.onForeground()
        driving.start{access->pairing.updateAccess(access);applyConnection(pairing.connection());model.updateAccess(access);synchronizeInput()}
    }
    override fun onStop(){
        consentDialog?.close();pairing.onBackground();comparison.onBackground();applyConnection(null);driving.stop();model.onBackground();super.onStop()
    }
    override fun onDestroy(){consentDialog?.close();consentDialog=null;driving.stop();super.onDestroy()}
}
