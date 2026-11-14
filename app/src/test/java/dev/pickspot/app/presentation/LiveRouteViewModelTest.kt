package dev.pickspot.app.presentation

import androidx.lifecycle.ViewModelStore
import dev.pickspot.app.domain.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class LiveRouteViewModelTest {
    @get:Rule val main=PickupViewModelTest.MainDispatcherRule()
    private val scheduler get()=main.dispatcher.scheduler
    private var wallOffset=0L
    private var frozenWall:Long?=null
    private fun wall()=frozenWall?: (1_800_000_000_000L+scheduler.currentTime+wallOffset)
    private fun elapsed()=100_000L+scheduler.currentTime
    private val stores=mutableListOf<ViewModelStore>()
    private val base=1_800_000_000_000L
    private fun trip()=PreparedVehicleTrip(MeasuredVehicleFix(GeoPoint(37.484,127.030),wall(),12f,wall(),elapsed(),0),
        VehicleRoute(VehiclePlace(GeoPoint(37.5,127.04),"검사 목적지"),emptyList(),"PLEOS",wall()),DrivePreference.RECOMMENDED,wall()+30_000)
    private inner class Fake:LiveRouteGateway {
        var session=LiveRouteSession(5,3,base+900_000,base+30_000,true)
        var calls=0;var reads=0;var cancelled=false;var pause=0L;var failure:LiveRouteFailure?=null
        var hold:CompletableDeferred<LiveRouteReport>?=null
        var mutate:(LiveRouteReport)->LiveRouteReport={it}
        override suspend fun status():LiveRouteSession{reads++;failure?.let{throw LiveRouteException(it)};return session}
        override suspend fun compare(request:LiveRouteRequest):LiveRouteReport {
            calls++;session=session.copy(version=request.expectedVersion+1)
            val report=LiveRouteReport(session.version,session.passengerRevision,request.trip.validUntil,request.trip.preference,0,
                listOf(LiveRouteCandidate("a",120,60,30,RouteEvidence("검사","검사 조건",listOf("https://example.test")))))
            try {delay(pause);return hold?.let{withContext(NonCancellable){it.await()}}?:mutate(report)}
            finally{cancelled=!currentCoroutineContext().isActive}
        }
    }
    private inner class Setup(enabled:Boolean=true){
        val fake=Fake();val vm=LiveRouteViewModel(if(enabled)fake else null,::wall,::elapsed).also{stores+=ViewModelStore().apply{put("route",it)}}
        var draft=trip()
        fun input(access:DrivingAccess=DrivingAccess.AVAILABLE)=VehicleInputState(MeasuredInputPhase.FRESH,true,access,12f,
            preparation=VehicleTripPreparation(draft=draft))
        fun open(){vm.onForeground();scheduler.runCurrent();vm.updateInput(input(),listOf("a"))}
        fun send(){vm.requestConsent();vm.confirmConsent();scheduler.runCurrent()}
    }
    private fun tick(ms:Long){scheduler.advanceTimeBy(ms);scheduler.runCurrent()}
    @After fun cleanup(){stores.forEach{it.clear()};scheduler.runCurrent()}
    @Test fun `unconfigured gateway cannot collect consent or dispatch`() {
        val x=Setup(false);x.open();x.send();assertEquals(LiveRoutePhase.UNAVAILABLE,x.vm.state.value.phase);assertEquals(0,x.fake.calls);assertEquals(0,x.fake.reads)
    }
    @Test fun `opening and consent dialog do not send position and dismissal clears intent`() {
        val x=Setup();x.open();assertEquals(LiveRoutePhase.AVAILABLE,x.vm.state.value.phase)
        x.vm.confirmConsent();assertEquals(0,x.fake.calls)
        x.vm.requestConsent();assertEquals(LiveRoutePhase.CONSENT,x.vm.state.value.phase);assertEquals(0,x.fake.calls)
        x.vm.dismissConsent();x.vm.confirmConsent();assertEquals(0,x.fake.calls)
    }
    @Test fun `explicit confirmation sends once and no automatic repeat follows`() {
        val x=Setup();x.open();x.send();assertEquals(LiveRoutePhase.READY,x.vm.state.value.phase)
        x.vm.confirmConsent();tick(4000);assertEquals(1,x.fake.calls);assertNotNull(x.vm.state.value.report)
    }
    @Test fun `missing passenger routing consent or missing candidate selection blocks request`() {
        val x=Setup();x.fake.session=x.fake.session.copy(routingAllowed=false);x.open();x.send();assertEquals(0,x.fake.calls)
        x.fake.session=x.fake.session.copy(routingAllowed=true);tick(3000);x.vm.updateInput(x.input(),emptyList());x.send();assertEquals(0,x.fake.calls)
    }
    @Test fun `changed route preference or new GPS sample revokes pending consent`() {
        for(change in listOf("route","preference","position")){
            val x=Setup();x.open();x.vm.requestConsent()
            x.draft=when(change){"route"->x.draft.copy(route=x.draft.route.copy(destination=VehiclePlace(GeoPoint(37.51,127.04),"새 목적지")))
                "preference"->x.draft.copy(preference=DrivePreference.FASTEST)
                else->x.draft.copy(vehicle=x.draft.vehicle.copy(point=GeoPoint(37.485,127.03)))}
            x.vm.updateInput(x.input(),listOf("a"));x.vm.confirmConsent();assertEquals(0,x.fake.calls)
        }
    }
    @Test fun `background clears result and ignores late noncancellable response`() {
        val x=Setup();x.open();x.fake.hold=CompletableDeferred();x.send();x.vm.onBackground()
        x.fake.hold!!.complete(LiveRouteReport(6,3,base+30000,DrivePreference.RECOMMENDED,0,emptyList()));scheduler.runCurrent()
        assertNull(x.vm.state.value.report);x.vm.updateInput(x.input(),listOf("a"));x.vm.onForeground();scheduler.runCurrent();x.send();assertEquals(1,x.fake.calls)
    }
    @Test fun `driving restriction cancels calculation and erases result`() {
        val x=Setup();x.open();x.fake.pause=10000;x.send();x.vm.updateInput(x.input(DrivingAccess.RESTRICTED),listOf("a"));scheduler.runCurrent()
        assertTrue(x.fake.cancelled);assertNull(x.vm.state.value.report);x.send();assertEquals(1,x.fake.calls)
    }
    @Test fun `own server version increment during slow work does not cancel it`() {
        val x=Setup();x.open();x.fake.pause=7000;x.send();tick(7000)
        assertEquals(LiveRoutePhase.READY,x.vm.state.value.phase);assertEquals(1,x.fake.calls)
    }
    @Test fun `new passenger position and withdrawal discard a completed result`() {
        for(withdraw in listOf(false,true)){
            val x=Setup();x.open();x.send()
            x.fake.session=x.fake.session.copy(version=7,passengerRevision=4,routingAllowed=!withdraw)
            tick(3000);assertNull(x.vm.state.value.report)
        }
    }
    @Test fun `status failure clears pending work and reports only classified issue`() {
        val x=Setup();x.open();x.fake.pause=10000;x.send();x.fake.failure=LiveRouteFailure.CONNECTION;tick(3000)
        assertTrue(x.fake.cancelled);assertNull(x.vm.state.value.report);assertEquals(LiveRouteFailure.CONNECTION,x.vm.state.value.issue)
    }
    @Test fun `result expires on monotonic time even when wall clock stops`() {
        val x=Setup();x.open();x.fake.mutate={it.copy(validUntil=wall()+4000)};x.send();frozenWall=wall();tick(4000)
        assertNull(x.vm.state.value.report);assertEquals(LiveRoutePhase.STALE,x.vm.state.value.phase)
    }
    @Test fun `clock rollback invalidates consent and prepared input`() {
        val x=Setup();x.open();x.vm.requestConsent();wallOffset=-1000;tick(100);x.vm.confirmConsent()
        assertEquals(0,x.fake.calls);assertNull(x.vm.state.value.report)
    }
    @Test fun `mismatched report revision preference or candidate cannot be displayed`() {
        for(change in listOf("revision","preference","candidate","expiry")){
            val x=Setup();x.open();x.fake.mutate={when(change){
                "revision"->it.copy(passengerRevision=99);"preference"->it.copy(preference=DrivePreference.FASTEST)
                "candidate"->it.copy(candidates=it.candidates.map{row->row.copy(id="other")});else->it.copy(validUntil=base+60000)}}
            x.send();assertEquals(LiveRouteFailure.INVALID_RESPONSE,x.vm.state.value.issue);assertNull(x.vm.state.value.report)
        }
    }
    @Test fun `request timeout and viewmodel disposal cancel gateway work`() {
        val x=Setup();x.open();x.fake.pause=25000;x.send();tick(20000)
        assertTrue(x.fake.cancelled);assertNull(x.vm.state.value.report);assertEquals(1,x.fake.calls)
        val y=Setup();y.open();y.fake.pause=10000;y.send();stores.last().clear();scheduler.runCurrent();assertTrue(y.fake.cancelled)
    }
    @Test fun `old consent window cannot confirm or dismiss a newer consent`() {
        val x=Setup();x.open();x.vm.requestConsent();val first=x.vm.state.value.consentId!!
        x.vm.dismissConsent(first);x.vm.requestConsent();val second=x.vm.state.value.consentId!!
        assertNotEquals(first,second)
        x.vm.confirmConsent(first);x.vm.dismissConsent(first);scheduler.runCurrent()
        assertEquals(second,x.vm.state.value.consentId);assertEquals(0,x.fake.calls)
        x.vm.confirmConsent(second);scheduler.runCurrent();assertEquals(1,x.fake.calls)
    }
    @Test fun `input invalidation and background remove consent identity immediately`() {
        val x=Setup();x.open();x.vm.requestConsent();val first=x.vm.state.value.consentId!!
        x.draft=x.draft.copy(preference=DrivePreference.FREE_FIRST)
        x.vm.updateInput(x.input(),listOf("a"));assertNull(x.vm.state.value.consentId)
        x.vm.confirmConsent(first);assertEquals(0,x.fake.calls)
        x.vm.requestConsent();assertNotNull(x.vm.state.value.consentId)
        x.vm.onBackground();assertNull(x.vm.state.value.consentId)
    }

    @Test fun `changing vehicle connection discards pending consent and old session`() {
        val x=Setup();x.open();x.vm.requestConsent();val stale=x.vm.state.value.consentId
        val next=Fake();x.vm.connect(next);scheduler.runCurrent();x.vm.confirmConsent(stale)
        assertEquals(0,x.fake.calls);assertEquals(0,next.calls);assertNull(x.vm.state.value.consentId)
        assertEquals(LiveRoutePhase.WAITING,x.vm.state.value.phase)
        x.vm.updateInput(x.input(),listOf("a"));x.send();assertEquals(1,next.calls)
        x.vm.connect(null);assertEquals(LiveRoutePhase.UNAVAILABLE,x.vm.state.value.phase);assertNull(x.vm.state.value.report)
    }
}
