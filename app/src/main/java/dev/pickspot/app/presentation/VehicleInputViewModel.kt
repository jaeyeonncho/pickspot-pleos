package dev.pickspot.app.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.pickspot.app.domain.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class MeasuredInputPhase { IDLE, WAITING, FRESH, INVALID, STALE, TIMEOUT, PERMISSION, UNAVAILABLE, STOPPED, FINISHED }
data class VehicleInputState(val phase: MeasuredInputPhase=MeasuredInputPhase.IDLE, val running: Boolean=false,
    val access: DrivingAccess=DrivingAccess.UNKNOWN, val accuracyMeters: Float?=null,
    val navigation: NavigationState=NavigationState(), val preference: DrivePreference?=null,
    val preparation: VehicleTripPreparation=VehicleTripPreparation(issue=TripPreparationIssue.POSITION_REQUIRED)) {
    val canInteract get()=access==DrivingAccess.AVAILABLE
}
class VehicleInputViewModel(private val location: MeasuredLocationReader, private val routeReader: VehicleRouteReader,
    private val wall:()->Long, private val elapsed:()->Long): ViewModel() {
    private val mutable=MutableStateFlow(VehicleInputState())
    val state=mutable.asStateFlow()
    private var foreground=false
    private var generation=0
    private var watcher: Job?=null
    private var fix: MeasuredVehicleFix?=null
    private var observation: ObservedVehicleRoute?=null
    private var newestElapsed=-1L
    private val policy=MeasuredVehiclePolicy()
    fun onForeground(){foreground=true}
    fun onBackground(){foreground=false;stop();mutable.value=state.value.copy(access=DrivingAccess.UNKNOWN)}
    fun updateAccess(access: DrivingAccess){
        if(access!=DrivingAccess.AVAILABLE&&state.value.running)stop()
        mutable.value=state.value.copy(access=access)
    }
    fun choose(preference: DrivePreference?){
        if(!foreground||!state.value.canInteract)return
        mutable.value=state.value.copy(preference=preference);recompute()
    }
    fun permissionMissing(){if(foreground&&state.value.canInteract)stop(MeasuredInputPhase.PERMISSION)}
    fun start(){
        if(!foreground||!state.value.canInteract||state.value.running)return
        stop()
        if(!location.hasPermission()){stop(MeasuredInputPhase.PERMISSION);return}
        if(!location.isAvailable()){stop(MeasuredInputPhase.UNAVAILABLE);return}
        val epoch=generation;val started=elapsed()
        mutable.value=state.value.copy(phase=MeasuredInputPhase.WAITING,running=true)
        try {
            routeReader.start route@{ nav ->
                if(!current(epoch))return@route
                observation=nav.route?.takeIf { nav.phase==NavigationPhase.READY }?.let {
                    ObservedVehicleRoute(it.copy(waypoints=it.waypoints.toList()),wall(),elapsed())
                }
                mutable.value=state.value.copy(navigation=nav.copy(route=null));recompute()
            }
            location.start(sample@{ sample ->
                if(!current(epoch))return@sample
                // Invalid future readings must not poison the ordering watermark.
                if(sample.measuredElapsedMillis<=newestElapsed)return@sample
                val accepted=policy.validate(sample,wall(),elapsed())
                fix=accepted
                if(accepted!=null)newestElapsed=sample.measuredElapsedMillis
                mutable.value=state.value.copy(phase=if(accepted==null)MeasuredInputPhase.INVALID else MeasuredInputPhase.FRESH,
                    accuracyMeters=accepted?.accuracyMeters)
                recompute()
            },{if(current(epoch))stop(MeasuredInputPhase.UNAVAILABLE)})
            if(!current(epoch))return
            watcher=viewModelScope.launch {
                while(isActive&&current(epoch)) {
                    delay(250)
                    if(!location.hasPermission()){stop(MeasuredInputPhase.PERMISSION);return@launch}
                    if(elapsed()-started>=120_000){stop(MeasuredInputPhase.FINISHED);return@launch}
                    if(fix!=null&&!fix!!.isFresh(wall(),elapsed())){
                        fix=null;mutable.value=state.value.copy(phase=MeasuredInputPhase.STALE,accuracyMeters=null)
                    }
                    if(observation!=null&&observation!!.remainingMillis(wall(),elapsed())<=0){
                        observation=null;mutable.value=state.value.copy(navigation=NavigationState(NavigationPhase.FAILED,issue=NavigationIssue.ROUTE_CONTEXT_STALE))
                    }
                    if(state.value.phase==MeasuredInputPhase.WAITING&&elapsed()-started>=15_000)
                        mutable.value=state.value.copy(phase=MeasuredInputPhase.TIMEOUT)
                    recompute()
                }
            }
        }catch(_:Exception){stop(MeasuredInputPhase.UNAVAILABLE)}
    }
    fun refreshRoute(){
        if(!foreground||!state.value.canInteract||!state.value.running)return
        observation=null
        mutable.value=state.value.copy(navigation=NavigationState(NavigationPhase.READING));recompute()
        try{routeReader.refresh()}catch(_:Exception){mutable.value=state.value.copy(navigation=NavigationState(NavigationPhase.FAILED,issue=NavigationIssue.CONNECTION));recompute()}
    }
    private fun current(epoch:Int)=epoch==generation&&foreground&&state.value.running&&state.value.canInteract
    private fun recompute(){mutable.value=state.value.copy(preparation=VehicleTripPreparer.prepare(fix,observation,state.value.preference,wall(),elapsed()))}
    fun stop(phase:MeasuredInputPhase=MeasuredInputPhase.STOPPED){
        generation++;watcher?.cancel();watcher=null
        location.stop();routeReader.stop();fix=null;observation=null;newestElapsed=-1
        mutable.value=VehicleInputState(phase=phase,access=state.value.access,preference=state.value.preference)
    }
    override fun onCleared(){foreground=false;stop()}
}
