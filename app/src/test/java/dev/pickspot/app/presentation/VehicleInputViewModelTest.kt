package dev.pickspot.app.presentation

import androidx.lifecycle.ViewModelStore
import dev.pickspot.app.domain.*
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class VehicleInputViewModelTest {
    @get:Rule val main=PickupViewModelTest.MainDispatcherRule()
    private val scheduler get()=main.dispatcher.scheduler
    private fun wall()=1_800_000_000_000L+scheduler.currentTime
    private fun elapsed()=100_000L+scheduler.currentTime
    private val stores=mutableListOf<ViewModelStore>()
    private class GPS:MeasuredLocationReader {
        var permission=true;var available=true;var starts=0;var stops=0
        var sample:((MeasuredVehicleSample)->Unit)?=null;var unavailable:(()->Unit)?=null
        override fun hasPermission()=permission
        override fun isAvailable()=available
        override fun start(onSample:(MeasuredVehicleSample)->Unit,onUnavailable:()->Unit){starts++;sample=onSample;unavailable=onUnavailable}
        override fun stop(){stops++}
    }
    private class Routes:VehicleRouteReader {
        var callback:((NavigationState)->Unit)?=null;var starts=0;var refreshes=0;var stops=0
        override fun start(onState:(NavigationState)->Unit){starts++;callback=onState}
        override fun refresh(){refreshes++}
        override fun stop(){stops++}
    }
    private inner class Setup {
        val gps=GPS();val routes=Routes()
        val vm=VehicleInputViewModel(gps,routes,::wall,::elapsed).also {stores+=ViewModelStore().apply{put("input",it)}}
        fun open(){vm.onForeground();vm.updateAccess(DrivingAccess.AVAILABLE)}
        fun sample(age:Long=0,accuracy:Float?=12f)=MeasuredVehicleSample(37.484,127.030,wall()-age,elapsed()-age,accuracy)
        fun route()=VehicleRoute(VehiclePlace(GeoPoint(37.5,127.04),"원래 목적지"),emptyList(),"PLEOS_OPTION",wall())
        fun ready(){open();vm.choose(DrivePreference.FREE_FIRST);vm.start();gps.sample!!(sample());routes.callback!!(NavigationState(NavigationPhase.READY,true,route=route()))}
    }
    private fun tick(ms:Long){scheduler.advanceTimeBy(ms);scheduler.runCurrent()}
    @After fun cleanup(){stores.forEach{it.clear()};scheduler.runCurrent()}
    @Test fun `opening alone does not read GPS or navigation`() {val x=Setup();x.open();assertEquals(0,x.gps.starts);assertEquals(0,x.routes.starts)}
    @Test fun `start requires visible unrestricted screen and precise permission`() {
        val x=Setup();x.vm.start();x.vm.onForeground();x.vm.start();assertEquals(0,x.gps.starts)
        x.vm.updateAccess(DrivingAccess.RESTRICTED);x.vm.start();assertEquals(0,x.routes.starts)
        x.vm.updateAccess(DrivingAccess.AVAILABLE);x.gps.permission=false;x.vm.start()
        assertEquals(MeasuredInputPhase.PERMISSION,x.vm.state.value.phase);assertEquals(0,x.routes.starts)
    }
    @Test fun `valid readings prepare local input without automatically choosing an option`() {
        val x=Setup();x.open();x.vm.start();x.gps.sample!!(x.sample());x.routes.callback!!(NavigationState(NavigationPhase.READY,true,route=x.route()))
        assertEquals(TripPreparationIssue.PREFERENCE_REQUIRED,x.vm.state.value.preparation.issue)
        x.vm.choose(DrivePreference.FASTEST);assertNotNull(x.vm.state.value.preparation.draft)
        x.vm.start();assertEquals(1,x.gps.starts);assertEquals(1,x.routes.starts)
        x.vm.choose(null);assertNull(x.vm.state.value.preparation.draft)
    }
    @Test fun `refresh removes the draft immediately until a fresh route returns`() {
        val x=Setup();x.ready();x.vm.refreshRoute()
        assertNull(x.vm.state.value.preparation.draft);assertEquals(1,x.routes.refreshes)
        x.routes.callback!!(NavigationState(NavigationPhase.FAILED,true,issue=NavigationIssue.NO_DESTINATION))
        assertNull(x.vm.state.value.preparation.draft)
        x.routes.callback!!(NavigationState(NavigationPhase.READY,true,route=x.route()))
        assertNotNull(x.vm.state.value.preparation.draft)
    }
    @Test fun `invalid future GPS cannot poison ordering against subsequent valid sample`() {
        val x=Setup();x.ready();x.gps.sample!!(x.sample().copy(measuredElapsedMillis=elapsed()+60000))
        assertNull(x.vm.state.value.preparation.draft);tick(1000);x.gps.sample!!(x.sample())
        assertNotNull(x.vm.state.value.preparation.draft)
    }
    @Test fun `late out of order samples cannot replace the latest measurement`() {
        val x=Setup();x.ready();val current=x.vm.state.value.preparation.draft
        x.gps.sample!!(x.sample(age=1000,accuracy=80f));assertEquals(current,x.vm.state.value.preparation.draft)
    }
    @Test fun `position and route expiry remove usable input without a network request`() {
        val x=Setup();x.ready();tick(30000)
        assertNull(x.vm.state.value.preparation.draft);assertNull(x.vm.state.value.accuracyMeters)
        assertEquals(NavigationIssue.ROUTE_CONTEXT_STALE,x.vm.state.value.navigation.issue)
        x.gps.sample!!(x.sample());assertNull(x.vm.state.value.preparation.draft)
        x.vm.refreshRoute();x.routes.callback!!(NavigationState(NavigationPhase.READY,true,route=x.route()))
        assertNotNull(x.vm.state.value.preparation.draft)
    }
    @Test fun `background and driving restriction clear coordinates and reject late callbacks`() {
        for(background in listOf(true,false)){
            val x=Setup();x.ready();val gps=x.gps.sample!!;val route=x.routes.callback!!
            if(background)x.vm.onBackground() else x.vm.updateAccess(DrivingAccess.RESTRICTED)
            gps(x.sample());route(NavigationState(NavigationPhase.READY,true,route=x.route()))
            assertFalse(x.vm.state.value.running);assertNull(x.vm.state.value.preparation.draft)
            assertNull(x.vm.state.value.accuracyMeters);assertNull(x.vm.state.value.navigation.route)
            x.open();assertEquals(1,x.gps.starts)
        }
    }
    @Test fun `permission revoked midstream stops both readers and clears the draft`() {
        val x=Setup();x.ready();x.gps.permission=false;tick(250)
        assertEquals(MeasuredInputPhase.PERMISSION,x.vm.state.value.phase)
        assertFalse(x.vm.state.value.running);assertNull(x.vm.state.value.preparation.draft)
    }
    @Test fun `no sample times out then receiving may recover until two minute limit`() {
        val x=Setup();x.open();x.vm.start();tick(15000)
        assertEquals(MeasuredInputPhase.TIMEOUT,x.vm.state.value.phase)
        x.gps.sample!!(x.sample());assertEquals(MeasuredInputPhase.FRESH,x.vm.state.value.phase)
        tick(105000);assertEquals(MeasuredInputPhase.FINISHED,x.vm.state.value.phase)
        assertFalse(x.vm.state.value.running);assertNull(x.vm.state.value.preparation.draft)
    }
    @Test fun `provider disabled and stop reject cached readings from previous start`() {
        val x=Setup();x.ready();val old=x.gps.sample!!;x.gps.unavailable!!()
        assertEquals(MeasuredInputPhase.UNAVAILABLE,x.vm.state.value.phase)
        x.vm.start();old(x.sample());assertNull(x.vm.state.value.accuracyMeters)
        x.vm.stop();x.gps.sample!!(x.sample());assertNull(x.vm.state.value.accuracyMeters)
    }
    @Test fun `route change event invalidates ready draft immediately`() {
        val x=Setup();x.ready();x.routes.callback!!(NavigationState(NavigationPhase.FAILED,true,issue=NavigationIssue.ROUTE_CHANGED))
        assertNull(x.vm.state.value.preparation.draft)
    }
}
