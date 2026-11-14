package dev.pickspot.app.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.pickspot.app.domain.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class LiveRoutePhase { UNAVAILABLE, WAITING, AVAILABLE, CONSENT, CALCULATING, READY, STALE, FAILED }
data class LiveRouteState(val phase:LiveRoutePhase=LiveRoutePhase.UNAVAILABLE,val report:LiveRouteReport?=null,
    val issue:LiveRouteFailure?=null,val consentId:Int?=null)

/** One explicit consent confirmation authorizes one calculation. No consent/token persistence.
 * UI adapters must supply current VehicleInputState and end foreground on screen exit. */
class LiveRouteViewModel(private var gateway:LiveRouteGateway?,private val wall:()->Long,private val elapsed:()->Long):ViewModel(){
    private val mutable=MutableStateFlow(LiveRouteState())
    val state=mutable.asStateFlow()
    private var visible=false
    private var access=DrivingAccess.UNKNOWN
    private var input:PreparedVehicleTrip?=null
    private var ids:List<String> = emptyList()
    private var session:LiveRouteSession?=null
    private var inputDeadline=0L
    private var acceptedWall=0L
    private var acceptedElapsed=0L
    private var lastWall=0L
    private var lastElapsed=0L
    private var statusAt=0L
    private var epoch=0
    private var work:Job?=null
    private var monitor:Job?=null
    private var poll:Job?=null
    private var consent:LiveRouteRequest?=null
    private var active:LiveRouteRequest?=null
    private var reportDeadline=0L

    fun connect(next:LiveRouteGateway?){
        if(gateway===next)return
        val resume=visible;onBackground();gateway=next
        mutable.value=LiveRouteState(if(next==null)LiveRoutePhase.UNAVAILABLE else LiveRoutePhase.WAITING)
        if(resume)onForeground()
    }
    fun onForeground(){
        if(visible)return
        visible=true;lastWall=wall();lastElapsed=elapsed()
        val activeGateway=gateway?:return
        mutable.value=LiveRouteState(LiveRoutePhase.WAITING)
        poll=viewModelScope.launch {
            while(isActive&&visible){
                val observationEpoch=epoch
                try{
                    val received=withTimeout(5_000){activeGateway.status()}
                    if(!visible)return@launch
                    // A request started before a new context cannot restore its old state.
                    if(observationEpoch==epoch)acceptSession(received)
                }catch(e:CancellationException){if(!currentCoroutineContext().isActive)throw e;if(observationEpoch==epoch)fail(LiveRouteFailure.CONNECTION)}
                catch(e:Exception){if(observationEpoch==epoch)fail((e as? LiveRouteException)?.issue?:LiveRouteFailure.CONNECTION)}
                delay(3_000)
            }
        }
        monitor=viewModelScope.launch {
            while(isActive&&visible){delay(100);checkExpiry()}
        }
    }
    fun onBackground(){
        visible=false;poll?.cancel();poll=null;monitor?.cancel();monitor=null
        invalidate();input=null;ids=emptyList();session=null;access=DrivingAccess.UNKNOWN
        mutable.value=LiveRouteState(if(gateway==null)LiveRoutePhase.UNAVAILABLE else LiveRoutePhase.WAITING)
    }
    fun updateInput(value:VehicleInputState,candidateIds:List<String>){
        if(!visible)return
        val next=value.preparation.draft?.takeIf{value.running&&value.canInteract}?.let{it.copy(route=it.route.copy(waypoints=it.route.waypoints.toList()))}
        val nextIds=candidateIds.toList()
        access=value.access
        if(input!=next||ids!=nextIds||!value.canInteract){
            invalidate();input=next;ids=nextIds
            acceptedWall=wall();acceptedElapsed=elapsed();inputDeadline=acceptedElapsed+((next?.validUntil?:acceptedWall)-acceptedWall).coerceIn(0,30_000)
            refreshAvailability()
        }
    }
    private fun acceptSession(next:LiveRouteSession){
        if(next.version<=0||next.passengerRevision<0){fail(LiveRouteFailure.INVALID_RESPONSE);return}
        val previous=session
        // A delayed read cannot move a monotonic session backwards.
        if(previous!=null&&(next.version<previous.version||next.passengerRevision<previous.passengerRevision))return
        session=next;statusAt=elapsed()
        val bound=active?:consent
        val report=state.value.report
        val changed=!next.ready(wall())||
            (bound!=null&&(next.passengerRevision!=bound.passengerRevision||
                next.version !in bound.expectedVersion..(bound.expectedVersion+if(active!=null)1 else 0)))||
            (report!=null&&(next.passengerRevision!=report.passengerRevision||next.version!=report.sessionVersion))
        if(changed){invalidate();mutable.value=LiveRouteState(LiveRoutePhase.WAITING);refreshAvailability()}
        else if(state.value.phase !in setOf(LiveRoutePhase.CONSENT,LiveRoutePhase.CALCULATING,LiveRoutePhase.READY))refreshAvailability()
    }
    private fun usable():Boolean {
        val at=wall();val tick=elapsed()
        return visible&&access==DrivingAccess.AVAILABLE&&gateway!=null&&at>=acceptedWall&&tick>=acceptedElapsed&&tick<inputDeadline&&
            input?.sendableAt(at,tick)==true&&session?.ready(at)==true&&tick>=statusAt&&tick-statusAt<5_000&&
            ids.size in 1..3&&ids.distinct().size==ids.size&&ids.all{Regex("[a-zA-Z0-9_-]{1,40}").matches(it)}
    }
    private fun refreshAvailability(){mutable.value=LiveRouteState(when{gateway==null->LiveRoutePhase.UNAVAILABLE;usable()->LiveRoutePhase.AVAILABLE;else->LiveRoutePhase.WAITING})}
    fun requestConsent(){
        checkExpiry();if(!usable()||state.value.phase in setOf(LiveRoutePhase.CALCULATING,LiveRoutePhase.CONSENT))return
        invalidate();val s=session!!
        consent=LiveRouteRequest(input!!,s.version,s.passengerRevision,ids.toList())
        mutable.value=LiveRouteState(LiveRoutePhase.CONSENT,consentId=epoch)
    }
    fun dismissConsent(expectedId:Int?=state.value.consentId){if(consent!=null&&expectedId==state.value.consentId){invalidate();refreshAvailability()}}
    fun confirmConsent(expectedId:Int?=state.value.consentId){
        checkExpiry();if(expectedId==null||expectedId!=state.value.consentId)return
        val request=consent?:return
        if(!usable()||request.trip!=input||request.expectedVersion!=session?.version||request.passengerRevision!=session?.passengerRevision){invalidate();refreshAvailability();return}
        consent=null;active=request;val requestEpoch=epoch
        mutable.value=LiveRouteState(LiveRoutePhase.CALCULATING)
        work=viewModelScope.launch {
            try{
                val result=withTimeout(20_000){gateway!!.compare(request)}
                if(!visible||epoch!=requestEpoch)return@launch
                checkExpiry();if(epoch!=requestEpoch)return@launch
                if(!usable()||result.sessionVersion!=request.expectedVersion+1||result.passengerRevision!=request.passengerRevision||
                    result.preference!=request.trip.preference||result.originalWaypointCount!=request.trip.route.waypoints.size||
                    result.validUntil<=wall()||result.validUntil>request.trip.validUntil||
                    result.candidates.size>ids.size||result.candidates.map{it.id}.distinct().size!=result.candidates.size||
                    result.candidates.any{it.id !in ids||it.walkMeters<0||it.walkSeconds<0||it.detourSeconds<0})throw LiveRouteException(LiveRouteFailure.INVALID_RESPONSE)
                val current=session!!
                session=current.copy(version=result.sessionVersion)
                val until=minOf(result.validUntil,current.expiresAt,current.locationValidUntil?:0,request.trip.validUntil)
                reportDeadline=elapsed()+(until-wall()).coerceIn(0,30_000)
                active=null;mutable.value=LiveRouteState(LiveRoutePhase.READY,result.copy(validUntil=until))
            }catch(e:CancellationException){if(!currentCoroutineContext().isActive&&e !is TimeoutCancellationException)throw e;if(epoch==requestEpoch)fail(LiveRouteFailure.CONNECTION)}
            catch(e:Exception){if(epoch==requestEpoch)fail((e as? LiveRouteException)?.issue?:LiveRouteFailure.CONNECTION)}
            finally{if(epoch==requestEpoch){work=null;active=null}}
        }
    }
    fun cancel(){invalidate();refreshAvailability()}
    private fun checkExpiry(){
        val at=wall();val tick=elapsed()
        if(at<lastWall||tick<lastElapsed){invalidate();input=null;session=null;mutable.value=LiveRouteState(LiveRoutePhase.STALE)}
        else if(state.value.phase in setOf(LiveRoutePhase.CONSENT,LiveRoutePhase.CALCULATING,LiveRoutePhase.READY)&&
            (!usable()||(state.value.report?.let{it.validUntil<=at||tick>=reportDeadline}==true))){
            invalidate();mutable.value=LiveRouteState(LiveRoutePhase.STALE)
        }
        lastWall=at;lastElapsed=tick
    }
    private fun fail(issue:LiveRouteFailure){invalidate();session=null;mutable.value=LiveRouteState(LiveRoutePhase.FAILED,issue=issue)}
    private fun invalidate(){epoch++;work?.cancel();work=null;consent=null;active=null;reportDeadline=0;mutable.value=state.value.copy(report=null,consentId=null)}
    override fun onCleared(){onBackground()}
}
