package dev.pickspot.app.presentation

import androidx.lifecycle.ViewModelStore
import dev.pickspot.app.domain.*
import kotlinx.coroutines.test.*
import kotlinx.coroutines.ExperimentalCoroutinesApi
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class VehicleLocationViewModelTest {
    @get:Rule val main = PickupViewModelTest.MainDispatcherRule()
    private val stores = mutableListOf<ViewModelStore>()
    private val epoch = 1_800_000_000_000L
    private var wallShift = 0L
    private fun elapsed() = main.dispatcher.scheduler.currentTime
    private fun wall() = epoch + elapsed() + wallShift
    private fun sample(time: Long = wall()) = VehicleLocationSample(37.484,127.030,time,0.8f)
    private fun advance(ms: Long) { main.dispatcher.scheduler.advanceTimeBy(ms); main.dispatcher.scheduler.runCurrent() }
    @After fun dispose() { stores.forEach { it.clear() } }
    private class Gateway(var supported: Boolean = true) : VehicleLocationGateway {
        var starts = 0; var stops = 0
        lateinit var sample: (VehicleLocationSample?) -> Unit
        lateinit var error: () -> Unit
        override fun isSupported() = supported
        override fun start(onSample: (VehicleLocationSample?) -> Unit, onError: () -> Unit) {
            starts++; sample = onSample; error = onError
        }
        override fun stop() { stops++ }
    }
    private fun model(gateway: Gateway) = VehicleLocationViewModel(gateway,::wall,::elapsed).also {
        stores += ViewModelStore().apply { put("location",it) }; it.onForeground(true)
    }
    @Test fun `foreground alone never starts collecting and denied permission prevents start`() {
        val g=Gateway(); val vm=model(g)
        assertEquals(0,g.starts); vm.start(false)
        assertEquals(VehicleLocationPhase.PERMISSION_REQUIRED,vm.state.value.phase)
        assertEquals(0,g.starts); assertNull(vm.state.value.freshFix)
    }
    @Test fun `unsupported service is checked before starting`() {
        val g=Gateway(false); val vm=model(g); vm.start(true)
        assertEquals(VehicleLocationPhase.UNSUPPORTED,vm.state.value.phase); assertEquals(0,g.starts)
    }
    @Test fun `valid fix ages using monotonic time even if wall clock moves backwards`() {
        val g=Gateway(); val vm=model(g); vm.start(true); g.sample(sample())
        assertEquals(VehicleLocationPhase.FRESH,vm.state.value.phase)
        wallShift = -60_000; advance(30_000)
        assertEquals(VehicleLocationPhase.STALE,vm.state.value.phase)
        assertNull(vm.state.value.fix); assertNull(vm.state.value.freshFix)
    }
    @Test fun `old cached fix is not made fresh by receiving it now`() {
        val g=Gateway(); val vm=model(g); vm.start(true); g.sample(sample(wall()-60_000))
        assertEquals(VehicleLocationPhase.STALE,vm.state.value.phase); assertNull(vm.state.value.fix)
    }
    @Test fun `duplicate and out of order callbacks cannot refresh age`() {
        val g=Gateway(); val vm=model(g); vm.start(true); val original=sample(); g.sample(original)
        advance(29_000); g.sample(original); g.sample(sample(original.observedAtEpochMillis-1_000))
        advance(1_000); assertEquals(VehicleLocationPhase.STALE,vm.state.value.phase)
        g.sample(sample()); assertEquals(VehicleLocationPhase.FRESH,vm.state.value.phase)
    }
    @Test fun `no fix times out but new live fix recovers without restarting`() {
        val g=Gateway(); val vm=model(g); vm.start(true); g.sample(null); advance(15_000)
        assertEquals(VehicleLocationPhase.TIMEOUT,vm.state.value.phase)
        g.sample(sample()); assertNotNull(vm.state.value.freshFix)
        g.sample(null); assertNotNull(vm.state.value.freshFix)
    }
    @Test fun `invalid coordinates future time and invalid confidence clear previous fix`() {
        val bad = listOf(sample().copy(latitude=Double.NaN),sample().copy(longitude=181.0),
            sample(0),sample(wall()+6_000),sample().copy(confidence=Float.NaN))
        for (value in bad) {
            val g=Gateway(); val vm=model(g); vm.start(true); g.sample(sample()); g.sample(value)
            assertEquals(VehicleLocationPhase.INVALID,vm.state.value.phase); assertNull(vm.state.value.freshFix)
        }
    }
    @Test fun `background stops and clears location and ignores late old callback`() {
        val g=Gateway(); val vm=model(g); vm.start(true); g.sample(sample()); val old=g.sample
        val before=g.stops; vm.onBackground()
        assertTrue(g.stops>before); assertNull(vm.state.value.fix)
        old(sample()); assertEquals(VehicleLocationPhase.PAUSED,vm.state.value.phase)
        vm.onForeground(true); assertEquals(2,g.starts)
        old(sample()); assertEquals(VehicleLocationPhase.WAITING,vm.state.value.phase)
        g.sample(sample()); assertNotNull(vm.state.value.freshFix)
    }
    @Test fun `revoked permission on return blocks automatic collection`() {
        val g=Gateway(); val vm=model(g); vm.start(true); vm.onBackground(); vm.onForeground(false)
        assertEquals(VehicleLocationPhase.PERMISSION_REQUIRED,vm.state.value.phase)
        assertEquals(1,g.starts); assertFalse(vm.state.value.enabled)
    }
    @Test fun `manual stop does not resume on next foreground and ignores late errors`() {
        val g=Gateway(); val vm=model(g); vm.start(true); val oldError=g.error
        vm.stop(); oldError(); vm.onBackground(); vm.onForeground(true)
        assertEquals(VehicleLocationPhase.OFF,vm.state.value.phase); assertEquals(1,g.starts)
    }
    @Test fun `service error clears usable coordinates and newer sample recovers`() {
        val g=Gateway(); val vm=model(g); vm.start(true); g.sample(sample()); g.error()
        assertEquals(VehicleLocationPhase.ERROR,vm.state.value.phase); assertNull(vm.state.value.fix)
        advance(1_000); g.sample(sample()); assertNotNull(vm.state.value.freshFix)
    }
    @Test fun `clearing view model releases collection and invalidates callbacks`() {
        val g=Gateway(); val vm=model(g); vm.start(true); val old=g.sample; val before=g.stops
        stores.last().clear(); assertTrue(g.stops>before)
        old(sample()); assertNull(vm.state.value.fix)
    }
}
