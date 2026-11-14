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
class VehiclePairingViewModelTest {
    @get:Rule val main=PickupViewModelTest.MainDispatcherRule()
    private val scheduler get()=main.dispatcher.scheduler
    private val base=1_800_000_000_000L
    private var offset=0L
    private var frozen:Long?=null
    private fun wall()=frozen?:(base+scheduler.currentTime+offset)
    private fun elapsed()=100_000+scheduler.currentTime
    private val stores=mutableListOf<ViewModelStore>()
    private val id="00000000-0000-0000-0000-000000000001"
    private inner class Fake:VehiclePairingGateway {
        var creates=0;var claims=0;var cancels=0;var approved=false;var fail=false;var wait=0L
        var held:CompletableDeferred<VehiclePairingGrant?>?=null
        override suspend fun create():VehiclePairingTicket {creates++;delay(wait);return VehiclePairingTicket(id,"ABCDEF123456","d".repeat(43),wall()+120000)}
        override suspend fun claim(ticket:VehiclePairingTicket):VehiclePairingGrant? {
            claims++;if(fail)throw IllegalStateException("secret")
            held?.let{return withContext(NonCancellable){it.await()}}
            return if(approved)grant() else null
        }
        override suspend fun cancel(ticket:VehiclePairingTicket){cancels++}
    }
    private fun grant()=VehiclePairingGrant("https://example.test",id,"v".repeat(43),wall()+900000,"검사",listOf("a"))
    private fun setup(fake:Fake?=Fake()):VehiclePairingViewModel=VehiclePairingViewModel(fake,::wall,::elapsed).also{
        stores+=ViewModelStore().apply{put("pair",it)};it.onForeground();it.updateAccess(DrivingAccess.AVAILABLE)
    }
    private fun tick(ms:Long){scheduler.advanceTimeBy(ms);scheduler.runCurrent()}
    @After fun cleanup(){stores.forEach{it.clear()};scheduler.runCurrent()}
    @Test fun `missing configuration and driving restriction never create a code`() {
        val off=setup(null);off.start();scheduler.runCurrent();assertEquals(VehiclePairingPhase.UNAVAILABLE,off.state.value.phase)
        val f=Fake();val vm=setup(f);vm.updateAccess(DrivingAccess.RESTRICTED);vm.start();scheduler.runCurrent();assertEquals(0,f.creates)
    }
    @Test fun `one explicit request creates one code and polls only after interval`() {
        val f=Fake();val vm=setup(f);vm.start();vm.start();scheduler.runCurrent();assertEquals(1,f.creates);assertEquals(0,f.claims)
        assertEquals("ABCDEF123456",vm.state.value.code);assertEquals(120,vm.state.value.seconds)
        tick(3000);assertEquals(1,f.claims);assertEquals(VehiclePairingPhase.WAITING,vm.state.value.phase)
    }
    @Test fun `network setup delay permits normal server expiry without extending local deadline`() {
        val f=Fake();f.wait=1000;val vm=setup(f);vm.start();scheduler.runCurrent();tick(1000)
        assertEquals(VehiclePairingPhase.WAITING,vm.state.value.phase);assertEquals(119,vm.state.value.seconds)
        tick(119000);assertEquals(VehiclePairingPhase.EXPIRED,vm.state.value.phase)
    }
    @Test fun `approval replaces code with memory only grant and stops polling`() {
        val f=Fake();val vm=setup(f);vm.start();scheduler.runCurrent();f.approved=true;tick(3000)
        assertEquals(VehiclePairingPhase.CONNECTED,vm.state.value.phase);assertNull(vm.state.value.code);assertNotNull(vm.connection())
        assertFalse(vm.state.value.toString().contains("v".repeat(43)));tick(10000);assertEquals(1,f.claims)
        vm.onBackground();assertNull(vm.connection());assertEquals(VehiclePairingPhase.IDLE,vm.state.value.phase)
    }
    @Test fun `background cancels pending approval and cannot resume the code`() {
        val f=Fake();val vm=setup(f);vm.start();scheduler.runCurrent();vm.onBackground();scheduler.runCurrent()
        assertEquals(1,f.cancels);assertNull(vm.state.value.code);tick(3000);assertEquals(0,f.claims)
        vm.onForeground();vm.updateAccess(DrivingAccess.AVAILABLE);tick(3000);assertEquals(1,f.creates)
    }
    @Test fun `late claimed credential cannot reconnect after screen exit`() {
        val f=Fake();val vm=setup(f);val hold=CompletableDeferred<VehiclePairingGrant?>();f.held=hold
        vm.start();scheduler.runCurrent();tick(3000);vm.onBackground();hold.complete(grant());scheduler.runCurrent()
        assertNull(vm.connection());assertEquals(VehiclePairingPhase.IDLE,vm.state.value.phase)
    }
    @Test fun `error is sanitized and never automatically retries claim`() {
        val f=Fake();val vm=setup(f);f.fail=true;vm.start();scheduler.runCurrent();tick(3000);tick(20000)
        assertEquals(VehiclePairingPhase.FAILED,vm.state.value.phase);assertEquals(1,f.claims);assertNull(vm.state.value.code)
        assertFalse(vm.state.value.toString().contains("secret"))
    }
    @Test fun `frozen wall clock cannot extend a code lifetime`() {
        val f=Fake();val vm=setup(f);vm.start();scheduler.runCurrent();frozen=wall();tick(120000)
        assertEquals(VehiclePairingPhase.EXPIRED,vm.state.value.phase);assertNull(vm.connection());assertNull(vm.state.value.code)
    }
    @Test fun `wall clock rollback expires code and revokes local grant`() {
        for(approved in listOf(false,true)){
            val f=Fake();val vm=setup(f);vm.start();scheduler.runCurrent();f.approved=approved;tick(3000)
            offset-=1000;tick(200);assertEquals(VehiclePairingPhase.EXPIRED,vm.state.value.phase);assertNull(vm.connection())
        }
    }
    @Test fun `driving restriction drops approved connection without location transmission`() {
        val f=Fake();val vm=setup(f);vm.start();scheduler.runCurrent();f.approved=true;tick(3000)
        assertNotNull(vm.connection());vm.updateAccess(DrivingAccess.RESTRICTED);assertNull(vm.connection());assertNull(vm.state.value.code)
    }
    @Test fun `connection expires with session even after approval`() {
        val f=Fake();val vm=setup(f);vm.start();scheduler.runCurrent();f.approved=true;tick(3000);tick(900000)
        assertEquals(VehiclePairingPhase.EXPIRED,vm.state.value.phase);assertNull(vm.connection())
    }
    @Test fun `credentials redact themselves and reject malformed configuration`() {
        assertEquals("VehiclePairingGrant(redacted)",grant().toString())
        assertEquals("VehiclePairingTicket(redacted)",VehiclePairingTicket(id,"ABCDEF123456","d".repeat(43),base).toString())
        for(origin in listOf("http://example.test","https://example.test/path","https://user@example.test","https://example.test#code","https://example.test:99999")){
            assertThrows(IllegalArgumentException::class.java){VehiclePairingGrant(origin,id,"v".repeat(43),base,"검사",listOf("a"))}
        }
    }
}
