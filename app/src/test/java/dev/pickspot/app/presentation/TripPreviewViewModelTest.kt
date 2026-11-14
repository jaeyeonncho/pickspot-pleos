package dev.pickspot.app.presentation

import androidx.lifecycle.ViewModelStore
import dev.pickspot.app.domain.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import org.junit.*
import org.junit.Assert.*

@OptIn(ExperimentalCoroutinesApi::class)
class TripPreviewViewModelTest {
    private val dispatcher=UnconfinedTestDispatcher()
    private val stores=mutableListOf<ViewModelStore>()
    private val a=TripPreviewTarget("session","a","A",GeoPoint(37.48,127.03))
    private val b=a.copy(candidateId="b",point=GeoPoint(37.49,127.04))
    private val success=TripPreviewOutcome.Success(TripPreviewMetrics(1200,180))
    private class Fake:TripPreviewGateway {
        var allowed=false;var closed=false;var calls=0
        lateinit var complete:(TripPreviewOutcome)->Unit
        override fun setInteractionAllowed(allowed:Boolean){this.allowed=allowed}
        override fun request(target:TripPreviewTarget,callback:(TripPreviewOutcome)->Unit){calls++;complete=callback}
        override fun close(){closed=true}
    }
    @Before fun start(){Dispatchers.setMain(dispatcher)}
    @After fun stop(){stores.forEach{it.clear()};Dispatchers.resetMain()}
    private fun model(gateway:Fake=Fake())=TripPreviewViewModel(gateway){dispatcher.scheduler.currentTime}.also{
        stores+=ViewModelStore().apply{put("preview",it)}
    }
    @Test fun `request requires visible eligible target and prevents duplicates`() {
        val gateway=Fake();val vm=model(gateway)
        vm.request();vm.update(a,false);vm.request();assertEquals(0,gateway.calls)
        vm.update(a,true);vm.request();vm.request();assertEquals(1,gateway.calls)
        assertEquals(TripPreviewPhase.LOADING,vm.state.value.phase)
    }
    @Test fun `ready result expires at thirty seconds and no query runs automatically`() {
        val gateway=Fake();val vm=model(gateway);vm.update(a,true);vm.request();gateway.complete(success)
        assertEquals(success.metrics,vm.state.value.metrics);assertFalse(vm.state.value.canRequest)
        dispatcher.scheduler.advanceTimeBy(29_000);dispatcher.scheduler.runCurrent()
        assertEquals(29L,vm.state.value.ageSeconds)
        dispatcher.scheduler.advanceTimeBy(1_000);dispatcher.scheduler.runCurrent()
        assertEquals(TripPreviewPhase.STALE,vm.state.value.phase);assertNull(vm.state.value.metrics)
        assertTrue(vm.state.value.canRequest);assertEquals(1,gateway.calls)
    }
    @Test fun `switch away and back cannot attach an old response to the same candidate`() {
        val gateway=Fake();val vm=model(gateway);vm.update(a,true);vm.request()
        vm.update(b,true);assertFalse(vm.state.value.canRequest);vm.update(a,true)
        gateway.complete(success)
        assertNull(vm.state.value.metrics);assertTrue(vm.state.value.canRequest)
    }
    @Test fun `new session coordinate or POI invalidates a displayed estimate`() {
        for(next in listOf(a.copy(sessionId="new"),a.copy(point=b.point),a.copy(poi=PoiReference("p","0","A","")))) {
            val gateway=Fake();val vm=model(gateway);vm.update(a,true);vm.request();gateway.complete(success)
            vm.update(next,true);assertNull(vm.state.value.metrics);assertTrue(vm.state.value.canRequest)
        }
    }
    @Test fun `background or driving restriction removes results and ignores late success`() {
        val gateway=Fake();val vm=model(gateway);vm.update(a,true);vm.request()
        vm.update(null,false);gateway.complete(success)
        assertNull(vm.state.value.metrics);assertFalse(gateway.allowed)
        vm.update(a,true);vm.request();gateway.complete(success);vm.update(a,false)
        assertNull(vm.state.value.metrics);assertFalse(vm.state.value.canRequest)
    }
    @Test fun `timeout of an abandoned request still locks future requests`() {
        val gateway=Fake();val vm=model(gateway);vm.update(a,true);vm.request();vm.update(b,true)
        gateway.complete(TripPreviewOutcome.Failure(TripPreviewIssue.TIMEOUT,true))
        assertTrue(vm.state.value.restartRequired);assertFalse(vm.state.value.canRequest)
        vm.update(a,true);vm.request();assertEquals(1,gateway.calls)
    }
    @Test fun `unchanged context does not discard fresh results and duplicate completion is ignored`() {
        val gateway=Fake();val vm=model(gateway);vm.update(a,true);vm.request();gateway.complete(success)
        vm.update(a.copy(),true);gateway.complete(TripPreviewOutcome.Failure(TripPreviewIssue.SERVICE,true))
        assertEquals(success.metrics,vm.state.value.metrics);assertFalse(vm.state.value.restartRequired)
    }
    @Test fun `clearing the viewmodel releases SDK and prevents callback resurrection`() {
        val gateway=Fake();val vm=model(gateway);vm.update(a,true);vm.request()
        stores.forEach{it.clear()};gateway.complete(success)
        assertTrue(gateway.closed);assertNull(vm.state.value.metrics)
    }
}
