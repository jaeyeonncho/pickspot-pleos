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
class SharingViewModelTest {
    @get:Rule val main = PickupViewModelTest.MainDispatcherRule()
    private val stores = mutableListOf<ViewModelStore>()
    private val scheduler get() = main.dispatcher.scheduler
    private fun now() = 1_800_000_000_000L + scheduler.currentTime
    private fun snapshot(status: SharingStatus = SharingStatus.NOT_SHARING, code: String? = "ABCDEF123456", ttl: Long = 30_000) = SharingSnapshot(code,status,now()+900_000,now()+ttl)
    private inner class Repo : SharingRepository {
        override var hasSession = false
        override var ending = false
        var value = snapshot()
        var reads = 0; var creates = 0; var deletes = 0
        var failure: Exception? = null
        var lag = 0L
        override suspend fun create(): SharingSnapshot { creates++; hasSession=true; return value }
        override fun requestEnd() { ending = true }
        override suspend fun refresh(): SharingSnapshot? {
            reads++; val captured = value
            if (lag > 0) withContext(NonCancellable) { delay(lag) }
            failure?.let { throw it }
            if (ending) { deletes++; hasSession=false; ending=false; return null }
            return captured.takeIf { hasSession }
        }
    }
    private fun model(repo: Repo, access: DrivingAccess = DrivingAccess.AVAILABLE) = SharingViewModel(repo,::now, { scheduler.currentTime }).also { it.updateDrivingAccess(access); stores += ViewModelStore().apply { put("share",it) } }
    private fun tick(ms: Long = 0) { scheduler.advanceTimeBy(ms); scheduler.runCurrent() }
    @After fun cleanup() { stores.forEach { it.clear() }; scheduler.runCurrent() }
    @Test fun `opening does not create a meeting and duplicate create is ignored`() {
        val r=Repo(); val vm=model(r); vm.onForeground(); tick()
        assertEquals(SharingPhase.IDLE,vm.state.value.phase); assertEquals(0,r.creates)
        vm.create(); vm.create(); tick()
        assertEquals(1,r.creates); assertEquals("ABCDEF123456",vm.state.value.session?.inviteCode)
    }
    @Test fun `joined ready and withdrawn states follow server without coordinates`() {
        val r=Repo(); val vm=model(r); vm.onForeground(); tick(); vm.create(); tick()
        r.value=snapshot(SharingStatus.NOT_SHARING,null); tick(3000); assertNull(vm.state.value.session?.inviteCode)
        r.value=snapshot(SharingStatus.READY,null); tick(3000); assertEquals(SharingStatus.READY,vm.state.value.session?.status)
        r.value=snapshot(SharingStatus.WITHDRAWN,null); tick(3000); assertEquals(SharingStatus.WITHDRAWN,vm.state.value.session?.status)
    }
    @Test fun `expired ready is hidden even when the next response is slow`() {
        val r=Repo(); r.hasSession=true; r.value=snapshot(SharingStatus.READY,null,1000)
        val vm=model(r); vm.onForeground(); tick(); assertEquals(SharingStatus.READY,vm.state.value.session?.status)
        r.lag=5000; tick(1000); assertEquals(SharingStatus.STALE,vm.state.value.session?.status)
        tick(5000); assertEquals(SharingStatus.STALE,vm.state.value.session?.status)
    }
    @Test fun `offline clears prior status and retry restores the same meeting`() {
        val r=Repo(); r.hasSession=true; r.value=snapshot(SharingStatus.READY,null)
        val vm=model(r); vm.onForeground(); tick(); r.failure=java.io.IOException(); tick(3000)
        assertEquals(SharingPhase.OFFLINE,vm.state.value.phase); assertNull(vm.state.value.session)
        r.failure=null; vm.retry(); tick(); assertEquals(SharingPhase.CURRENT,vm.state.value.phase); assertEquals(0,r.creates)
    }
    @Test fun `end intent survives failure and foreground return before anything else`() {
        val r=Repo(); r.hasSession=true; val vm=model(r); vm.onForeground(); tick()
        r.failure=java.io.IOException(); vm.end(); assertTrue(r.ending); tick()
        assertEquals(SharingPhase.ENDING,vm.state.value.phase); assertNull(vm.state.value.session)
        vm.onBackground(); r.failure=null; vm.onForeground(); tick()
        assertEquals(1,r.deletes); assertFalse(r.hasSession); assertEquals(SharingPhase.ENDED,vm.state.value.phase)
    }
    @Test fun `background clears state stops polling and ignores a delayed response`() {
        val r=Repo(); r.hasSession=true; r.lag=5000; val vm=model(r); vm.onForeground(); tick()
        vm.onBackground(); tick(10000)
        assertEquals(SharingPhase.PAUSED,vm.state.value.phase); assertNull(vm.state.value.session); assertEquals(1,r.reads)
        r.lag=0; vm.onForeground(); tick(); assertEquals(SharingPhase.CURRENT,vm.state.value.phase)
    }
    @Test fun `closed sessions do not automatically create replacements`() {
        val r=Repo(); r.hasSession=true; r.failure=SharingClosedException(); val vm=model(r); vm.onForeground(); tick()
        assertEquals(SharingPhase.ENDED,vm.state.value.phase); tick(60000); assertEquals(0,r.creates); assertEquals(1,r.reads)
    }
    @Test fun `rate limit backs off for a minute`() {
        val r=Repo(); r.hasSession=true; r.failure=SharingRateLimitException(); val vm=model(r); vm.onForeground(); tick()
        tick(59_999); assertEquals(1,r.reads); tick(1); assertEquals(2,r.reads)
    }
    @Test fun `shared candidates disappear at their own deadline during a slow poll`() {
        val r=Repo(); r.hasSession=true
        r.value=snapshot(SharingStatus.READY,null).copy(recommendation=SharedExampleRecommendation(now()+500,
            listOf(SharedExampleCandidate("a",230,240,120))))
        val vm=model(r); vm.onForeground(); tick()
        assertEquals(1,vm.state.value.session?.recommendation?.candidates?.size)
        r.lag=5000; tick(500); assertNull(vm.state.value.session?.recommendation)
        assertEquals(SharingStatus.READY,vm.state.value.session?.status)
        tick(5000); assertNull(vm.state.value.session?.recommendation)
    }
    @Test fun `withdrawn share never displays a leftover recommendation`() {
        val r=Repo(); r.hasSession=true
        r.value=snapshot(SharingStatus.WITHDRAWN,null).copy(recommendation=SharedExampleRecommendation(now()+30000,
            listOf(SharedExampleCandidate("a",230,240,120))))
        val vm=model(r); vm.onForeground(); tick()
        assertEquals(SharingStatus.WITHDRAWN,vm.state.value.session?.status)
        assertNull(vm.state.value.session?.recommendation)
    }
    @Test fun `connection failure removes previously shown shared candidates`() {
        val r=Repo(); r.hasSession=true
        r.value=snapshot(SharingStatus.READY,null).copy(recommendation=SharedExampleRecommendation(now()+30000,
            listOf(SharedExampleCandidate("b",90,120,300))))
        val vm=model(r); vm.onForeground(); tick(); assertNotNull(vm.state.value.session?.recommendation)
        r.failure=java.io.IOException(); tick(3000)
        assertEquals(SharingPhase.OFFLINE,vm.state.value.phase); assertNull(vm.state.value.session)
    }

    @Test fun `unknown and restricted states block new create retry and end intents`() {
        val r=Repo(); val vm=model(r,DrivingAccess.UNKNOWN); vm.onForeground(); tick()
        vm.create(); tick(); assertEquals(0,r.creates)
        vm.updateDrivingAccess(DrivingAccess.AVAILABLE); vm.create(); tick(); assertEquals(1,r.creates)
        vm.updateDrivingAccess(DrivingAccess.RESTRICTED); vm.end(); assertFalse(r.ending)
        r.failure=java.io.IOException(); tick(3000); val reads=r.reads
        vm.retry(); tick(); assertEquals(reads,r.reads)
        vm.updateDrivingAccess(DrivingAccess.AVAILABLE); r.failure=null; vm.retry(); tick()
        assertEquals(SharingPhase.CURRENT,vm.state.value.phase); assertTrue(vm.state.value.canInteract)
    }
    @Test fun `restriction survives a delayed refresh and polling still receives closure`() {
        val r=Repo(); r.hasSession=true; r.lag=5000
        val vm=model(r); vm.onForeground(); tick(); vm.updateDrivingAccess(DrivingAccess.RESTRICTED)
        tick(5000); assertEquals(SharingPhase.CURRENT,vm.state.value.phase); assertFalse(vm.state.value.canInteract)
        r.lag=0; r.failure=SharingClosedException(); tick(3000)
        assertEquals(SharingPhase.ENDED,vm.state.value.phase); assertFalse(vm.state.value.canInteract)
    }
    @Test fun `background return requires a fresh driving access callback`() {
        val r=Repo(); val vm=model(r); vm.onForeground(); tick(); vm.onBackground(); vm.onForeground(); tick()
        assertEquals(DrivingAccess.UNKNOWN,vm.state.value.drivingAccess)
        vm.create(); tick(); assertEquals(0,r.creates)
    }

    @Test fun `restriction before queued create reaches transport prevents creation`() {
        Dispatchers.setMain(StandardTestDispatcher(scheduler))
        val r=Repo(); val vm=model(r); vm.onForeground(); tick()
        vm.create(); vm.updateDrivingAccess(DrivingAccess.RESTRICTED); tick()
        assertEquals(0,r.creates); assertEquals(SharingPhase.IDLE,vm.state.value.phase)
        assertFalse(vm.state.value.canInteract)
    }


    @Test fun `slow refresh keeps valid status and candidates with elapsed confirmation age`() {
        val r=Repo(); r.hasSession=true
        r.value=snapshot(SharingStatus.READY,null).copy(recommendation=SharedExampleRecommendation(now()+30000,
            listOf(SharedExampleCandidate("a",230,240,120))))
        val vm=model(r); vm.onForeground(); tick(); val original=vm.state.value.session
        r.lag=5000; tick(3000)
        assertEquals(SharingPhase.CURRENT,vm.state.value.phase); assertTrue(vm.state.value.refreshing)
        assertEquals(original,vm.state.value.session); assertEquals(3L,vm.state.value.checkedSecondsAgo)
        tick(5000); assertFalse(vm.state.value.refreshing); assertEquals(0L,vm.state.value.checkedSecondsAgo)
    }
    @Test fun `ready expires independently while an already running request is delayed`() {
        val r=Repo(); r.hasSession=true; r.value=snapshot(SharingStatus.READY,null,4500)
        val vm=model(r); vm.onForeground(); tick(); r.lag=10000
        tick(4499); assertEquals(SharingStatus.READY,vm.state.value.session?.status)
        tick(1); assertEquals(SharingStatus.STALE,vm.state.value.session?.status)
        assertTrue(vm.state.value.refreshing)
    }
    @Test fun `session deadline removes invitation during slow transport`() {
        val r=Repo(); r.hasSession=true; r.value=snapshot().copy(expiresAt=now()+4500)
        val vm=model(r); vm.onForeground(); tick(); r.lag=10000
        tick(4500); assertEquals(SharingPhase.ENDED,vm.state.value.phase); assertNull(vm.state.value.session)
        tick(8500); assertEquals(SharingPhase.ENDED,vm.state.value.phase)
    }
    @Test fun `unresponsive transport cannot display confirmed status past thirty seconds`() {
        val r=Repo(); r.hasSession=true; r.value=snapshot(SharingStatus.READY,null,90000)
        val vm=model(r); vm.onForeground(); tick(); r.lag=60000
        tick(29999); assertEquals(SharingPhase.CURRENT,vm.state.value.phase)
        tick(1); assertEquals(SharingPhase.OFFLINE,vm.state.value.phase)
        assertNull(vm.state.value.session); assertNull(vm.state.value.checkedSecondsAgo)
    }
    @Test fun `ending immediately removes retained content and the age ticker`() {
        val r=Repo(); r.hasSession=true; r.value=snapshot(SharingStatus.READY,null)
        val vm=model(r); vm.onForeground(); tick(); r.lag=5000; tick(3000); vm.end()
        assertEquals(SharingPhase.ENDING,vm.state.value.phase); assertNull(vm.state.value.session)
        tick(1000); assertEquals(SharingPhase.ENDING,vm.state.value.phase); assertNull(vm.state.value.checkedSecondsAgo)
    }
    @Test fun `background removes retained content and freshness cannot restore it`() {
        val r=Repo(); r.hasSession=true; r.value=snapshot(SharingStatus.READY,null)
        val vm=model(r); vm.onForeground(); tick(); r.lag=5000; tick(3000); vm.onBackground()
        tick(6000); assertEquals(SharingPhase.PAUSED,vm.state.value.phase)
        assertNull(vm.state.value.session); assertNull(vm.state.value.checkedSecondsAgo)
    }
    @Test fun `wall clock rollback cannot prolong freshness`() {
        val r=Repo(); r.hasSession=true; r.value=snapshot(SharingStatus.READY,null,4500)
        var offset=0L
        val vm=SharingViewModel(r,{now()+offset},{scheduler.currentTime})
        stores += ViewModelStore().apply { put("rollback",vm) }
        vm.onForeground(); tick(); r.lag=10000; offset=-60000
        tick(4500); assertEquals(SharingStatus.STALE,vm.state.value.session?.status)
    }
    @Test fun `wall clock forward expires content on the next clock tick`() {
        val r=Repo(); r.hasSession=true; r.value=snapshot(SharingStatus.READY,null)
        var offset=0L
        val vm=SharingViewModel(r,{now()+offset},{scheduler.currentTime})
        stores += ViewModelStore().apply { put("forward",vm) }
        vm.onForeground(); tick(); offset=60000
        tick(1000); assertEquals(SharingStatus.STALE,vm.state.value.session?.status)
    }

    @Test fun `clock restoration cannot revive an already expired position`() {
        val r=Repo(); r.hasSession=true; r.value=snapshot(SharingStatus.READY,null)
        var offset=0L
        val vm=SharingViewModel(r,{now()+offset},{scheduler.currentTime})
        stores += ViewModelStore().apply { put("restored",vm) }
        vm.onForeground(); tick(); offset=60000; tick(1000)
        assertEquals(SharingStatus.STALE,vm.state.value.session?.status)
        offset=0; tick(5000)
        assertEquals(SharingStatus.STALE,vm.state.value.session?.status)
    }
    @Test fun `late closure from an old generation cannot cancel the replacement expiry clock`() {
        var reads=0
        val r=object: SharingRepository {
            override val hasSession=true
            override val ending=false
            override suspend fun create()=snapshot()
            override fun requestEnd() {}
            override suspend fun refresh(): SharingSnapshot {
                reads++
                if(reads==1) {
                    withContext(NonCancellable) { delay(500) }
                    throw SharingClosedException()
                }
                if(reads>2)withContext(NonCancellable) { delay(10000) }
                return SharingSnapshot(null,SharingStatus.READY,1_800_000_900_000L,1_800_000_004_500L)
            }
        }
        val vm=SharingViewModel(r,::now,{scheduler.currentTime})
        stores += ViewModelStore().apply { put("late-closure",vm) }
        vm.onForeground(); tick(); vm.onBackground(); vm.onForeground(); tick()
        tick(500); assertEquals(SharingStatus.READY,vm.state.value.session?.status)
        tick(4000); assertEquals(SharingStatus.STALE,vm.state.value.session?.status)
    }
}
