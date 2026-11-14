package dev.pickspot.app.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.pickspot.app.domain.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class VehiclePairingPhase { UNAVAILABLE, IDLE, CREATING, WAITING, CONNECTED, EXPIRED, FAILED }
data class VehiclePairingState(val phase:VehiclePairingPhase=VehiclePairingPhase.UNAVAILABLE,val code:String?=null,val seconds:Int=0)

/** Credentials never enter UI state, saved state, preferences, Intents or logs. */
class VehiclePairingViewModel(private val gateway:VehiclePairingGateway?,private val wall:()->Long,private val elapsed:()->Long):ViewModel(){
    private val mutable=MutableStateFlow(VehiclePairingState(if(gateway==null)VehiclePairingPhase.UNAVAILABLE else VehiclePairingPhase.IDLE))
    val state=mutable.asStateFlow()
    private var visible=false
    private var access=DrivingAccess.UNKNOWN
    private var epoch=0
    private var task:Job?=null
    private var monitor:Job?=null
    private var ticket:VehiclePairingTicket?=null
    private var grant:VehiclePairingGrant?=null
    private var deadline=0L
    private var expiresAt=0L
    private var lastWall=0L
    private var lastTick=0L
    fun connection():VehiclePairingGrant?=grant.takeIf{visible&&access==DrivingAccess.AVAILABLE&&validClock()}
    fun onForeground(){visible=true;lastWall=wall();lastTick=elapsed()}
    fun updateAccess(next:DrivingAccess){access=next;if(next!=DrivingAccess.AVAILABLE)clear()}
    fun onBackground(){visible=false;access=DrivingAccess.UNKNOWN;clear()}
    fun start(){
        if(!visible||access!=DrivingAccess.AVAILABLE||gateway==null||state.value.phase in setOf(VehiclePairingPhase.CREATING,VehiclePairingPhase.WAITING,VehiclePairingPhase.CONNECTED))return
        clear();val revision=epoch
        mutable.value=VehiclePairingState(VehiclePairingPhase.CREATING)
        val requestedAt=wall();val requestedTick=elapsed()
        task=viewModelScope.launch {
            try {
                val created=withTimeout(8_000){gateway.create()}
                if(epoch!=revision||!visible){cleanup(created);return@launch}
                ticket=created
                require(created.expiresAt>wall()&&created.expiresAt<=wall()+120_000)
                require(wall()>=requestedAt&&elapsed()>=requestedTick)
                expiresAt=created.expiresAt;deadline=requestedTick+minOf(120_000,expiresAt-requestedAt)
                lastWall=wall();lastTick=elapsed()
                mutable.value=VehiclePairingState(VehiclePairingPhase.WAITING,created.code,remaining())
                monitor=viewModelScope.launch {
                    while(isActive){delay(200);if(!validClock()){clear(VehiclePairingPhase.EXPIRED);return@launch}
                        if(state.value.phase==VehiclePairingPhase.WAITING)mutable.value=state.value.copy(seconds=remaining())}
                }
                while(isActive&&epoch==revision){
                    delay(3_000)
                    if(!validClock()){clear(VehiclePairingPhase.EXPIRED);return@launch}
                    val received=withTimeout(8_000){gateway.claim(created)}?:continue
                    if(epoch!=revision||!visible)return@launch
                    require(validClock()&&received.expiresAt>wall()&&received.expiresAt<=wall()+900_000)
                    grant=received;ticket=null;expiresAt=received.expiresAt
                    deadline=elapsed()+(expiresAt-wall());mutable.value=VehiclePairingState(VehiclePairingPhase.CONNECTED)
                    return@launch
                }
            }catch(e:CancellationException){if(!currentCoroutineContext().isActive)throw e;if(epoch==revision)clear(VehiclePairingPhase.FAILED)}
            catch(_:Exception){if(epoch==revision)clear(VehiclePairingPhase.FAILED)}
        }
    }
    /** Drops local access. Operator revocation is a separate explicit server action. */
    fun clear(phase:VehiclePairingPhase=if(gateway==null)VehiclePairingPhase.UNAVAILABLE else VehiclePairingPhase.IDLE){
        epoch++;task?.cancel();task=null;monitor?.cancel();monitor=null
        val pending=ticket;ticket=null;grant=null;deadline=0;expiresAt=0
        mutable.value=VehiclePairingState(phase)
        if(pending!=null)cleanup(pending)
    }
    private fun cleanup(value:VehiclePairingTicket){viewModelScope.launch {try{withTimeout(3_000){gateway?.cancel(value)}}catch(_:Exception){/* Code expires independently on server. */}}}
    private fun remaining()=((minOf(expiresAt-wall(),deadline-elapsed()).coerceAtLeast(0)+999)/1000).toInt()
    private fun validClock():Boolean {
        val at=wall();val tick=elapsed();val valid=at>=lastWall&&tick>=lastTick&&at<expiresAt&&tick<deadline
        lastWall=at;lastTick=tick;return valid
    }
    override fun onCleared(){onBackground()}
}
