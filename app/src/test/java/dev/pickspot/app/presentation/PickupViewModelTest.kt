package dev.pickspot.app.presentation

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import dev.pickspot.app.data.DemoPickupRepository
import dev.pickspot.app.domain.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.After
import org.junit.Rule
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*

@OptIn(ExperimentalCoroutinesApi::class)
class PickupViewModelTest {
    class MainDispatcherRule : TestWatcher() {
        val dispatcher = UnconfinedTestDispatcher()
        override fun starting(description: Description) { Dispatchers.setMain(dispatcher) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule val main = MainDispatcherRule()
    private val stores = mutableListOf<ViewModelStore>()
    private val epoch = 1_800_000_000_000L
    private fun now() = epoch + main.dispatcher.scheduler.currentTime
    @After fun dispose() { stores.forEach { it.clear() } }

    private class FakeNavigation : NavigationGateway {
        override var onState: ((NavigationState) -> Unit)? = null
        val requests = mutableListOf<PickupCandidate>()
        var clock: () -> Long = { 1_800_000_000_000L }
        var routeAvailable = true
        var waypointAvailable = true
        val original get() = VehicleRoute(VehiclePlace(GeoPoint(37.5,127.05), "원래 목적지"), emptyList(), "RECOMMENDED", clock())
        var connections = 0
        var closed = false
        override fun connect() { connections++; emit(NavigationState(NavigationPhase.READY, true)) }
        override fun request(candidate: PickupCandidate, expectedRoute: VehicleRoute) { requests += candidate }
        override fun refreshRoute() { emit(NavigationState(NavigationPhase.READY,true)) }
        override fun setInteractionAllowed(allowed: Boolean) {}
        override fun close() { closed = true }
        fun emit(state: NavigationState) {
            val next=if(routeAvailable && state.route==null) state.copy(route=original) else state
            onState?.invoke(next.copy(waypointDispatchAvailable=waypointAvailable))
        }
    }
    private fun model(nav: FakeNavigation, handle: SavedStateHandle = SavedStateHandle(),
        repository: PickupRepository = DemoPickupRepository(::now),
        access: DrivingAccess = DrivingAccess.AVAILABLE): PickupViewModel =
        PickupViewModel(handle, repository, PickupRecommender(), nav.also { it.clock=::now }, ::now).also {
            it.updateDrivingAccess(access)
            stores += ViewModelStore().apply { put("pickup", it) }
        }

    private fun routed(phase: RouteCalculationPhase = RouteCalculationPhase.READY, validFor: Long = 120_000) =
        DemoPickupRepository.sampleSession(now()).copy(canEndRemotely = true,
            routeCalculation = RouteCalculation(phase, "예제 목적지", now(), now() + validFor, now(), 4))

    @Test fun `candidate preview requires explicit confirmation and blocks duplicate submissions`() {
        val nav=FakeNavigation().apply{waypointAvailable=false};var choices=0
        val repository=object:PickupRepository {
            override val sharesMeetingChoice=true
            override suspend fun loadSession()=routed()
            override suspend fun shareMeetingChoice(session:PickupSession,candidate:PickupCandidate):PickupSession {
                choices++;delay(100)
                return session.copy(version=session.version+1,selectedCandidateId=candidate.id,navigationPending=false)
            }
        }
        val vm=model(nav,repository=repository)
        vm.dispatch(PickupAction.SelectCandidate("b"))
        assertEquals(0, choices);assertFalse(vm.state.value.managing);assertNull(vm.state.value.confirmedMeeting)
        vm.dispatch(PickupAction.ConfirmMeetingPoint)
        assertTrue(vm.state.value.confirmingMeeting);assertTrue(vm.state.value.managing);assertTrue(vm.state.value.recommendations.isNotEmpty())
        vm.dispatch(PickupAction.ConfirmMeetingPoint);assertEquals(1,choices)
        vm.dispatch(PickupAction.SelectCandidate("c"));assertEquals(1,choices)
        main.dispatcher.scheduler.advanceTimeBy(101)
        assertFalse(vm.state.value.managing);assertEquals("b",vm.state.value.session?.selectedCandidateId)
        assertEquals("b",vm.state.value.selectedId);assertTrue(nav.requests.isEmpty())
        assertEquals("b",vm.state.value.confirmedMeeting?.id);assertFalse(vm.state.value.canConfirmMeeting)
        vm.dispatch(PickupAction.ConfirmMeetingPoint);assertEquals(1,choices)
        vm.dispatch(PickupAction.SelectCandidate("c"))
        assertEquals("b",vm.state.value.confirmedMeeting?.id);assertTrue(vm.state.value.canConfirmMeeting);assertEquals(1,choices)
        vm.dispatch(PickupAction.ChangePreference(PickupPreference.LESS_WALK));assertEquals(1,choices)
        vm.dispatch(PickupAction.SelectCandidate("a"));assertTrue(vm.state.value.canConfirmMeeting)
        vm.dispatch(PickupAction.ConfirmMeetingPoint);assertEquals(2,choices);assertTrue(vm.state.value.managing)
        main.dispatcher.scheduler.advanceTimeBy(101)
        main.dispatcher.scheduler.runCurrent()
        assertEquals("a",vm.state.value.confirmedMeeting?.id);assertEquals(2,choices);assertTrue(nav.requests.isEmpty())
    }

    @Test fun `failed competition choice never looks like successful shared selection`() {
        val nav=FakeNavigation();val repository=object:PickupRepository {
            override val sharesMeetingChoice=true
            override suspend fun loadSession()=routed()
            override suspend fun shareMeetingChoice(session:PickupSession,candidate:PickupCandidate):PickupSession {throw java.io.IOException()}
        }
        val vm=model(nav,repository=repository);vm.dispatch(PickupAction.SelectCandidate("b"))
        vm.dispatch(PickupAction.ConfirmMeetingPoint)
        assertNull(vm.state.value.confirmedMeeting);assertFalse(vm.state.value.canConfirmMeeting)
        assertEquals(SessionPhase.ERROR,vm.state.value.sessionPhase);assertNull(vm.state.value.session)
        assertTrue(nav.requests.isEmpty())
    }

    @Test fun `confirmed point survives preview polling and a fresh model uses server acknowledgement`() {
        var server=routed().copy(selectedCandidateId="a")
        val repository=object:PickupRepository {
            override val sharesMeetingChoice=true
            override val pollingIntervalMillis=500L
            override suspend fun loadSession()=server
            override suspend fun shareMeetingChoice(session:PickupSession,candidate:PickupCandidate):PickupSession {
                server=session.copy(version=session.version+1,selectedCandidateId=candidate.id);return server
            }
        }
        val vm=model(FakeNavigation(),repository=repository)
        vm.dispatch(PickupAction.SelectCandidate("b"))
        main.dispatcher.scheduler.advanceTimeBy(501)
        assertEquals("b",vm.state.value.selectedId);assertEquals("a",vm.state.value.confirmedMeeting?.id)
        vm.dispatch(PickupAction.ConfirmMeetingPoint)
        val restored=model(FakeNavigation(),repository=repository)
        assertEquals("b",restored.state.value.confirmedMeeting?.id)
        assertFalse(restored.state.value.canConfirmMeeting)
    }

    @Test fun `expired routes and restricted driving cannot confirm a preview`() {
        var calls=0
        val repository=object:PickupRepository {
            override val sharesMeetingChoice=true
            override suspend fun loadSession()=routed(validFor=1000)
            override suspend fun shareMeetingChoice(session:PickupSession,candidate:PickupCandidate):PickupSession {calls++;return session}
        }
        val vm=model(FakeNavigation(),repository=repository)
        vm.updateDrivingAccess(DrivingAccess.RESTRICTED);vm.dispatch(PickupAction.ConfirmMeetingPoint)
        assertEquals(0,calls);assertFalse(vm.state.value.canConfirmMeeting)
        vm.updateDrivingAccess(DrivingAccess.AVAILABLE)
        main.dispatcher.scheduler.advanceTimeBy(1001)
        vm.dispatch(PickupAction.ConfirmMeetingPoint)
        assertEquals(0,calls);assertFalse(vm.state.value.canConfirmMeeting);assertNull(vm.state.value.confirmedMeeting)
    }

    @Test fun `changing ranking preserves confirmed point even outside the top three`() {
        val vm=model(FakeNavigation(),repository=object:PickupRepository {
            override val sharesMeetingChoice=true
            override suspend fun loadSession()=routed().copy(selectedCandidateId="c")
        })
        vm.dispatch(PickupAction.ChangePreference(PickupPreference.LESS_WALK))
        assertFalse(vm.state.value.recommendations.any{it.candidate.id=="c"})
        assertEquals("c",vm.state.value.confirmedMeeting?.id);assertTrue(vm.state.value.canConfirmMeeting)
    }

    @Test fun `repository without meeting choice capability never sends a confirmation`() {
        var calls=0
        val vm=model(FakeNavigation(),repository=object:PickupRepository {
            override suspend fun loadSession()=routed()
            override suspend fun shareMeetingChoice(session:PickupSession,candidate:PickupCandidate):PickupSession {calls++;return session}
        })
        vm.dispatch(PickupAction.ConfirmMeetingPoint)
        assertFalse(vm.state.value.canConfirmMeeting);assertEquals(0,calls)
    }

    @Test fun `calculating and failed routes never expose old candidates or navigation`() {
        for (phase in listOf(RouteCalculationPhase.CALCULATING, RouteCalculationPhase.FAILED, RouteCalculationPhase.STALE)) {
            val nav = FakeNavigation()
            val vm = model(nav, repository = object : PickupRepository { override suspend fun loadSession() = routed(phase) })
            assertTrue(vm.state.value.recommendations.isEmpty()); assertFalse(vm.state.value.canRequest)
            vm.dispatch(PickupAction.OpenConfirmation); assertNull(vm.state.value.confirmation)
        }
    }
    @Test fun `route metrics expire locally even without polling and dismiss open confirmation`() {
        val vm = model(FakeNavigation(), repository = object : PickupRepository { override suspend fun loadSession() = routed(validFor = 1_000) })
        vm.dispatch(PickupAction.OpenConfirmation); assertNotNull(vm.state.value.confirmation)
        main.dispatcher.scheduler.advanceTimeBy(1_000); main.dispatcher.scheduler.runCurrent()
        assertEquals(SessionPhase.ROUTE_FAILED, vm.state.value.sessionPhase)
        assertTrue(vm.state.value.recommendations.isEmpty()); assertNull(vm.state.value.confirmation)
        assertTrue(vm.state.value.canRecalculate)
    }
    @Test fun `recalculation clears candidates blocks duplicate taps and reloads returned state`() {
        val gate = CompletableDeferred<PickupSession>(); var calls = 0
        val vm = model(FakeNavigation(), repository = object : PickupRepository {
            override suspend fun loadSession() = routed()
            override suspend fun recalculateRoutes(session: PickupSession): PickupSession { calls++; return gate.await() }
        })
        vm.dispatch(PickupAction.RecalculateRoutes); vm.dispatch(PickupAction.RecalculateRoutes)
        assertEquals(1, calls); assertTrue(vm.state.value.managing); assertTrue(vm.state.value.recommendations.isEmpty())
        assertFalse(vm.state.value.canRequest)
        gate.complete(routed(RouteCalculationPhase.CALCULATING))
        assertEquals(SessionPhase.CALCULATING, vm.state.value.sessionPhase); assertFalse(vm.state.value.managing)
    }
    @Test fun `recalculation cooldown and depleted budget disable action`() {
        var calls = 0
        val vm = model(FakeNavigation(), repository = object : PickupRepository {
            override suspend fun loadSession() = routed().let { it.copy(routeCalculation = it.routeCalculation!!.copy(retryAtEpochMillis = now() + 10_000)) }
            override suspend fun recalculateRoutes(session: PickupSession): PickupSession { calls++; return routed().let { it.copy(routeCalculation = it.routeCalculation!!.copy(attemptsRemaining = 0)) } }
        })
        vm.dispatch(PickupAction.RecalculateRoutes); assertEquals(0, calls)
        main.dispatcher.scheduler.advanceTimeBy(10_000); main.dispatcher.scheduler.runCurrent()
        assertTrue(vm.state.value.canRecalculate); vm.dispatch(PickupAction.RecalculateRoutes)
        assertFalse(vm.state.value.canRecalculate); vm.dispatch(PickupAction.RecalculateRoutes); assertEquals(1, calls)
    }
    @Test fun `driver ending requires confirmation and removes session only after server acknowledgment`() {
        val gate = CompletableDeferred<Unit>(); var calls = 0
        val vm = model(FakeNavigation(), repository = object : PickupRepository {
            override suspend fun loadSession() = routed()
            override suspend fun endSession(session: PickupSession) { calls++; gate.await() }
        })
        vm.dispatch(PickupAction.ConfirmEnd); assertEquals(0, calls)
        vm.dispatch(PickupAction.OpenEndConfirmation); assertFalse(vm.state.value.canRequest)
        vm.dispatch(PickupAction.DismissEndConfirmation); assertTrue(vm.state.value.canRequest)
        vm.dispatch(PickupAction.OpenEndConfirmation); vm.dispatch(PickupAction.ConfirmEnd); vm.dispatch(PickupAction.ConfirmEnd)
        assertEquals(1, calls); assertTrue(vm.state.value.managing); assertNotNull(vm.state.value.session)
        gate.complete(Unit); assertEquals(SessionPhase.ENDED, vm.state.value.sessionPhase)
        assertNull(vm.state.value.session); assertFalse(vm.state.value.managing)
    }
    @Test fun `end failure never falsely claims session deletion`() {
        val vm = model(FakeNavigation(), repository = object : PickupRepository {
            override suspend fun loadSession() = routed()
            override suspend fun endSession(session: PickupSession) { throw IllegalStateException() }
        })
        vm.dispatch(PickupAction.OpenEndConfirmation); vm.dispatch(PickupAction.ConfirmEnd)
        assertEquals(SessionPhase.ERROR, vm.state.value.sessionPhase); assertTrue(vm.state.value.canReload)
        vm.dispatch(PickupAction.ReloadSession); assertTrue(vm.state.value.canEnd)
    }
    @Test fun `session expiry cancels management and cannot be resurrected by delayed result`() {
        val gate = CompletableDeferred<PickupSession>()
        val vm = model(FakeNavigation(), repository = object : PickupRepository {
            override suspend fun loadSession() = routed().copy(expiresAtEpochMillis = now() + 1000)
            override suspend fun recalculateRoutes(session: PickupSession) = withContext(NonCancellable) { gate.await() }
        })
        vm.dispatch(PickupAction.RecalculateRoutes)
        main.dispatcher.scheduler.advanceTimeBy(1000); main.dispatcher.scheduler.runCurrent()
        assertEquals(SessionPhase.EXPIRED, vm.state.value.sessionPhase)
        gate.complete(routed()); assertEquals(SessionPhase.EXPIRED, vm.state.value.sessionPhase); assertNull(vm.state.value.session)
    }
    @Test fun `server rate limit produces recoverable error without old candidates`() {
        val vm = model(FakeNavigation(), repository = object : PickupRepository {
            override suspend fun loadSession() = routed()
            override suspend fun recalculateRoutes(session: PickupSession): PickupSession = throw SessionRateLimitException()
        })
        vm.dispatch(PickupAction.RecalculateRoutes)
        assertEquals(SessionIssue.RATE_LIMIT, vm.state.value.sessionIssue); assertTrue(vm.state.value.recommendations.isEmpty())
    }
    @Test fun `navigation pending on server disables recalculation`() {
        val vm = model(FakeNavigation(), repository = object : PickupRepository { override suspend fun loadSession() = routed().copy(navigationPending = true) })
        assertFalse(vm.state.value.canRecalculate); assertTrue(vm.state.value.canEnd)
    }

    @Test fun `delayed selection response cannot navigate with expired route metrics`() {
        val nav = FakeNavigation(); val gate = CompletableDeferred<PickupSession>()
        val initial = routed(validFor = 1000)
        val vm = model(nav, repository = object : PickupRepository {
            override suspend fun loadSession() = initial
            override suspend fun selectCandidate(session: PickupSession, candidate: PickupCandidate) = gate.await()
        })
        vm.dispatch(PickupAction.OpenConfirmation); vm.dispatch(PickupAction.ConfirmRoute)
        main.dispatcher.scheduler.advanceTimeBy(1000); main.dispatcher.scheduler.runCurrent()
        gate.complete(initial)
        assertTrue(nav.requests.isEmpty()); assertEquals(SessionIssue.CONFLICT, vm.state.value.sessionIssue)
    }

    @Test fun `confirm is required and double taps send only once`() {
        val nav = FakeNavigation(); val vm = model(nav)
        vm.dispatch(PickupAction.ConfirmRoute)
        assertTrue(nav.requests.isEmpty())
        vm.dispatch(PickupAction.OpenConfirmation)
        vm.dispatch(PickupAction.ConfirmRoute)
        vm.dispatch(PickupAction.OpenConfirmation)
        vm.dispatch(PickupAction.ConfirmRoute)
        assertEquals(listOf("a"), nav.requests.map { it.id })
        assertTrue(vm.state.value.navigation.busy)
    }
    @Test fun `selection cannot change underneath a confirmation or pending request`() {
        val nav = FakeNavigation(); val vm = model(nav)
        vm.dispatch(PickupAction.OpenConfirmation)
        vm.dispatch(PickupAction.SelectCandidate("b"))
        assertEquals("a", vm.state.value.confirmation?.id)
        vm.dispatch(PickupAction.ConfirmRoute)
        vm.dispatch(PickupAction.ChangePreference(PickupPreference.LESS_WALK))
        assertEquals("a", vm.state.value.selectedId)
    }
    @Test fun `cancelled dialog sends nothing and allows selecting again`() {
        val nav = FakeNavigation(); val vm = model(nav)
        vm.dispatch(PickupAction.OpenConfirmation)
        vm.dispatch(PickupAction.DismissConfirmation)
        vm.dispatch(PickupAction.SelectCandidate("b"))
        assertEquals("b", vm.state.value.selectedId)
        assertTrue(nav.requests.isEmpty())
    }
    @Test fun `saved selection survives recreation without replaying a route`() {
        val handle = SavedStateHandle(); val first = model(FakeNavigation(), handle)
        first.dispatch(PickupAction.ChangePreference(PickupPreference.LESS_WALK))
        first.dispatch(PickupAction.SelectCandidate("d"))
        first.dispatch(PickupAction.OpenConfirmation)
        val freshNav = FakeNavigation(); val restored = model(freshNav, handle)
        assertEquals("d", restored.state.value.selectedId)
        assertEquals(PickupPreference.LESS_WALK, restored.state.value.preference)
        assertNull(restored.state.value.confirmation)
        assertTrue(freshNav.requests.isEmpty())
    }
    @Test fun `empty results have no selection and cannot request navigation`() {
        val nav = FakeNavigation()
        val empty = object : PickupRepository {
            override suspend fun loadSession() = DemoPickupRepository.sampleSession(now()).copy(candidates = emptyList())
        }
        val vm = model(nav, repository = empty)
        assertNull(vm.state.value.selected)
        assertFalse(vm.state.value.canRequest)
        vm.dispatch(PickupAction.OpenConfirmation)
        vm.dispatch(PickupAction.ConfirmRoute)
        assertTrue(nav.requests.isEmpty())
    }
    @Test fun `stale selection is replaced by valid result and excluded id is rejected`() {
        val vm = model(FakeNavigation(), SavedStateHandle(mapOf("selected" to "gone")))
        assertEquals("a", vm.state.value.selectedId)
        vm.dispatch(PickupAction.SelectCandidate("e"))
        assertEquals("a", vm.state.value.selectedId)
    }
    @Test fun `failure unlocks retry and retains selected destination`() {
        val nav = FakeNavigation(); val vm = model(nav)
        vm.dispatch(PickupAction.OpenConfirmation); vm.dispatch(PickupAction.ConfirmRoute)
        nav.emit(NavigationState(NavigationPhase.FAILED, true, NavigationIssue.ROUTE_SEARCH))
        assertTrue(vm.state.value.canRequest)
        assertEquals("a", vm.state.value.selectedId)
        vm.dispatch(PickupAction.OpenConfirmation); vm.dispatch(PickupAction.ConfirmRoute)
        assertEquals(2, nav.requests.size)
    }
    @Test fun `view model store retains in flight state until owner is finished`() {
        val nav = FakeNavigation(); val vm = model(nav)
        val store = ViewModelStore(); store.put("pickup", vm)
        vm.dispatch(PickupAction.OpenConfirmation); vm.dispatch(PickupAction.ConfirmRoute)
        assertSame(vm, store["pickup"])
        assertTrue((store["pickup"] as PickupViewModel).state.value.navigation.busy)
        assertEquals(1, nav.connections)
        store.clear()
        assertTrue(nav.closed)
        assertNull(nav.onState)
    }
    @Test fun `loading does not expose old candidates and duplicate refresh is ignored`() {
        val gate = CompletableDeferred<PickupSession>()
        var calls = 0
        val repo = object : PickupRepository {
            override suspend fun loadSession(): PickupSession { calls++; return gate.await() }
        }
        val vm = model(FakeNavigation(), repository = repo)
        assertEquals(SessionPhase.LOADING, vm.state.value.sessionPhase)
        assertNull(vm.state.value.session)
        assertFalse(vm.state.value.canRequest)
        vm.dispatch(PickupAction.ReloadSession)
        assertEquals(1, calls)
        gate.complete(DemoPickupRepository.sampleSession(now()))
        assertEquals(SessionPhase.READY, vm.state.value.sessionPhase)
        assertEquals("a", vm.state.value.selectedId)
    }
    @Test fun `load failure supports retry without sending any route`() {
        var attempts = 0
        val repo = object : PickupRepository {
            override suspend fun loadSession(): PickupSession {
                if (++attempts == 1) throw java.io.IOException("private server details")
                return DemoPickupRepository.sampleSession(now())
            }
        }
        val nav = FakeNavigation(); val vm = model(nav, repository = repo)
        assertEquals(SessionIssue.UNAVAILABLE, vm.state.value.sessionIssue)
        assertNull(vm.state.value.session)
        vm.dispatch(PickupAction.ReloadSession)
        assertEquals(SessionPhase.READY, vm.state.value.sessionPhase)
        assertTrue(nav.requests.isEmpty())
    }
    @Test fun `slow repository times out and cancels its work`() {
        var cancelled = false
        val repo = object : PickupRepository {
            override suspend fun loadSession(): PickupSession {
                try { delay(20_000); return DemoPickupRepository.sampleSession(now()) }
                finally { cancelled = true }
            }
        }
        val vm = model(FakeNavigation(), repository = repo)
        main.dispatcher.scheduler.advanceTimeBy(15_000)
        main.dispatcher.scheduler.runCurrent()
        assertEquals(SessionIssue.TIMEOUT, vm.state.value.sessionIssue)
        assertTrue(cancelled)
        assertFalse(vm.state.value.canRequest)
    }
    @Test fun `already expired response is never displayed`() {
        val repo = object : PickupRepository {
            override suspend fun loadSession() = DemoPickupRepository.sampleSession(now()).copy(expiresAtEpochMillis = now())
        }
        val vm = model(FakeNavigation(), repository = repo)
        assertEquals(SessionPhase.EXPIRED, vm.state.value.sessionPhase)
        assertNull(vm.state.value.session)
        assertTrue(vm.state.value.recommendations.isEmpty())
    }
    @Test fun `expiry clears visible locations and closes confirmation before sending`() {
        val nav = FakeNavigation(); val vm = model(nav)
        vm.dispatch(PickupAction.OpenConfirmation)
        main.dispatcher.scheduler.advanceTimeBy(15 * 60_000)
        main.dispatcher.scheduler.runCurrent()
        vm.dispatch(PickupAction.ConfirmRoute)
        assertEquals(SessionPhase.EXPIRED, vm.state.value.sessionPhase)
        assertNull(vm.state.value.session)
        assertNull(vm.state.value.confirmation)
        assertTrue(vm.state.value.recommendations.isEmpty())
        assertTrue(nav.requests.isEmpty())
    }
    @Test fun `refresh failure cannot leave previous coordinates actionable`() {
        var attempts = 0
        val repo = object : PickupRepository {
            override suspend fun loadSession(): PickupSession {
                if (++attempts > 1) throw java.io.IOException()
                return DemoPickupRepository.sampleSession(now())
            }
        }
        val vm = model(FakeNavigation(), repository = repo)
        assertNotNull(vm.state.value.selected)
        vm.dispatch(PickupAction.ReloadSession)
        assertNull(vm.state.value.session)
        assertNull(vm.state.value.selected)
        assertFalse(vm.state.value.canRequest)
    }
    @Test fun `refresh cannot replace a destination during navigation request`() {
        var calls = 0
        val repo = object : PickupRepository {
            override suspend fun loadSession() = DemoPickupRepository.sampleSession(now()).also { calls++ }
        }
        val nav = FakeNavigation(); val vm = model(nav, repository = repo)
        vm.dispatch(PickupAction.OpenConfirmation)
        vm.dispatch(PickupAction.ConfirmRoute)
        vm.dispatch(PickupAction.ReloadSession)
        assertEquals(1, calls)
        assertEquals("a", vm.state.value.selectedId)
        assertEquals(1, nav.requests.size)
    }
    @Test fun `view model disposal cancels pending load rather than showing an error`() {
        var cancelled = false
        val repo = object : PickupRepository {
            override suspend fun loadSession(): PickupSession {
                try { awaitCancellation() } finally { cancelled = true }
            }
        }
        val nav = FakeNavigation(); val vm = model(nav, repository = repo)
        stores.last().clear()
        assertTrue(cancelled)
        assertTrue(nav.closed)
        assertNull(vm.state.value.sessionIssue)
    }
    @Test fun `duplicate candidate ids are rejected as invalid data`() {
        val repo = object : PickupRepository {
            override suspend fun loadSession(): PickupSession {
                val sample = DemoPickupRepository.sampleSession(now())
                return sample.copy(candidates = listOf(sample.candidates.first(), sample.candidates.first()))
            }
        }
        val vm = model(FakeNavigation(), repository = repo)
        assertEquals(SessionIssue.INVALID_DATA, vm.state.value.sessionIssue)
        assertFalse(vm.state.value.canRequest)
    }
    @Test fun `expired demo can load a new session without replaying navigation`() {
        val nav = FakeNavigation(); val vm = model(nav)
        main.dispatcher.scheduler.advanceTimeBy(15 * 60_000)
        main.dispatcher.scheduler.runCurrent()
        vm.dispatch(PickupAction.ReloadSession)
        assertEquals(SessionPhase.READY, vm.state.value.sessionPhase)
        assertFalse(vm.state.value.session!!.isExpired(now()))
        assertTrue(nav.requests.isEmpty())
    }

    @Test fun `confirmation rechecks wall clock even before expiry timer runs`() {
        var clock = epoch
        val nav = FakeNavigation()
        val vm = PickupViewModel(SavedStateHandle(), DemoPickupRepository { clock }, PickupRecommender(), nav) { clock }
        stores += ViewModelStore().apply { put("pickup", vm) }
        vm.updateDrivingAccess(DrivingAccess.AVAILABLE)
        vm.dispatch(PickupAction.OpenConfirmation)
        clock += 15 * 60_000
        vm.dispatch(PickupAction.ConfirmRoute)
        assertEquals(SessionPhase.EXPIRED, vm.state.value.sessionPhase)
        assertTrue(nav.requests.isEmpty())
    }

    @Test fun `waiting session becomes ready after passenger shares without automatic navigation`() {
        var active = false
        val repo = object : PickupRepository {
            override val pollingIntervalMillis = 3_000L
            override suspend fun loadSession() = DemoPickupRepository.sampleSession(now()).let {
                if (active) it else it.copy(passengerPoint = null, candidates = emptyList(), availability = SessionAvailability.WAITING, inviteCode = "ABCDEF123456")
            }
        }
        val nav = FakeNavigation(); val vm = model(nav, repository = repo)
        assertEquals(SessionPhase.WAITING, vm.state.value.sessionPhase)
        assertFalse(vm.state.value.canRequest)
        active = true
        main.dispatcher.scheduler.advanceTimeBy(3_000); main.dispatcher.scheduler.runCurrent()
        assertEquals(SessionPhase.READY, vm.state.value.sessionPhase)
        assertTrue(nav.requests.isEmpty())
    }
    @Test fun `server selection conflict prevents navigation and clears stale candidates`() {
        val repo = object : PickupRepository {
            override suspend fun loadSession() = DemoPickupRepository.sampleSession(now())
            override suspend fun selectCandidate(session: PickupSession, candidate: PickupCandidate): PickupSession = throw SessionConflictException()
        }
        val nav = FakeNavigation(); val vm = model(nav, repository = repo)
        vm.dispatch(PickupAction.OpenConfirmation); vm.dispatch(PickupAction.ConfirmRoute)
        assertTrue(nav.requests.isEmpty())
        assertEquals(SessionIssue.CONFLICT, vm.state.value.sessionIssue)
        assertNull(vm.state.value.session)
        assertTrue(vm.state.value.canReload)
    }
    @Test fun `server withdrawal immediately before confirmation prevents navigation`() {
        val repo = object : PickupRepository {
            override suspend fun loadSession() = DemoPickupRepository.sampleSession(now())
            override suspend fun selectCandidate(session: PickupSession, candidate: PickupCandidate): PickupSession = throw SessionClosedException(false)
        }
        val nav = FakeNavigation(); val vm = model(nav, repository = repo)
        vm.dispatch(PickupAction.OpenConfirmation); vm.dispatch(PickupAction.ConfirmRoute)
        assertTrue(nav.requests.isEmpty()); assertEquals(SessionPhase.ENDED, vm.state.value.sessionPhase)
        assertNull(vm.state.value.session)
    }
    @Test fun `navigation report waits for actual confirmation and retry does not resend route`() {
        var reportCalls = 0; val reports = mutableListOf<Boolean>()
        val repo = object : PickupRepository {
            override suspend fun loadSession() = DemoPickupRepository.sampleSession(now())
            override suspend fun reportNavigation(session: PickupSession, confirmed: Boolean) {
                reportCalls++; if (reportCalls == 1) throw java.io.IOException()
                reports += confirmed
            }
        }
        val nav = FakeNavigation(); val vm = model(nav, repository = repo)
        vm.dispatch(PickupAction.OpenConfirmation); vm.dispatch(PickupAction.ConfirmRoute)
        assertEquals(0, reportCalls)
        nav.emit(NavigationState(NavigationPhase.CONFIRMED, true, confirmedId = "a"))
        assertTrue(vm.state.value.shareFailed)
        vm.dispatch(PickupAction.RetryShare)
        assertFalse(vm.state.value.shareFailed); assertEquals(listOf(true), reports)
        assertEquals(1, nav.requests.size)
    }
    @Test fun `navigation failure is reported as failure not success`() {
        val reports = mutableListOf<Boolean>()
        val repo = object : PickupRepository {
            override suspend fun loadSession() = DemoPickupRepository.sampleSession(now())
            override suspend fun reportNavigation(session: PickupSession, confirmed: Boolean) { reports += confirmed }
        }
        val nav = FakeNavigation(); val vm = model(nav, repository = repo)
        vm.dispatch(PickupAction.OpenConfirmation); vm.dispatch(PickupAction.ConfirmRoute)
        nav.emit(NavigationState(NavigationPhase.FAILED, true, NavigationIssue.TIMEOUT))
        assertEquals(listOf(false), reports)
    }
    @Test fun `expiry during server selection wait never sends route and unlocks new session`() {
        val gate = CompletableDeferred<PickupSession>()
        val sample = DemoPickupRepository.sampleSession(now()).copy(expiresAtEpochMillis = now() + 5_000)
        val repo = object : PickupRepository {
            override suspend fun loadSession() = sample
            override suspend fun selectCandidate(session: PickupSession, candidate: PickupCandidate) = gate.await()
        }
        val nav = FakeNavigation(); val vm = model(nav, repository = repo)
        vm.dispatch(PickupAction.OpenConfirmation); vm.dispatch(PickupAction.ConfirmRoute)
        main.dispatcher.scheduler.advanceTimeBy(6_000); main.dispatcher.scheduler.runCurrent()
        assertEquals(SessionPhase.EXPIRED, vm.state.value.sessionPhase)
        assertTrue(vm.state.value.canReload)
        gate.complete(sample)
        main.dispatcher.scheduler.advanceTimeBy(15_000); main.dispatcher.scheduler.runCurrent()
        assertEquals(SessionPhase.EXPIRED, vm.state.value.sessionPhase)
        assertTrue(nav.requests.isEmpty()); assertTrue(vm.state.value.canReload)
    }
    @Test fun `polling observes remote end and removes location`() {
        var ended = false
        val repo = object : PickupRepository {
            override val pollingIntervalMillis = 3_000L
            override suspend fun loadSession(): PickupSession {
                if (ended) throw SessionClosedException(false)
                return DemoPickupRepository.sampleSession(now())
            }
        }
        val vm = model(FakeNavigation(), repository = repo)
        ended = true; main.dispatcher.scheduler.advanceTimeBy(3_000); main.dispatcher.scheduler.runCurrent()
        assertEquals(SessionPhase.ENDED, vm.state.value.sessionPhase); assertNull(vm.state.value.session)
    }
    @Test fun `new session explicitly resets expired remote credentials`() {
        var reset = false
        val repo = object : PickupRepository {
            override suspend fun loadSession(): PickupSession {
                if (!reset) throw SessionClosedException(true)
                return DemoPickupRepository.sampleSession(now())
            }
            override fun resetSession() { reset = true }
        }
        val nav = FakeNavigation(); val vm = model(nav, repository = repo)
        vm.dispatch(PickupAction.NewSession)
        assertTrue(reset); assertEquals(SessionPhase.READY, vm.state.value.sessionPhase)
        assertTrue(nav.requests.isEmpty())
    }


    @Test fun `transient connection failure automatically recovers without resending navigation`() {
        var calls = 0
        val nav = FakeNavigation()
        val vm = model(nav, repository = object : PickupRepository {
            override val pollingIntervalMillis = 3_000L
            override suspend fun loadSession(): PickupSession {
                if (++calls < 3) throw java.io.IOException()
                return routed()
            }
        })
        assertTrue(vm.state.value.recovering)
        main.dispatcher.scheduler.advanceTimeBy(3_000); main.dispatcher.scheduler.runCurrent()
        assertEquals(2, calls); assertTrue(vm.state.value.recommendations.isEmpty())
        main.dispatcher.scheduler.advanceTimeBy(3_000); main.dispatcher.scheduler.runCurrent(); assertEquals(2, calls)
        main.dispatcher.scheduler.advanceTimeBy(3_000); main.dispatcher.scheduler.runCurrent()
        assertEquals(SessionPhase.READY, vm.state.value.sessionPhase); assertFalse(vm.state.value.recovering)
        assertTrue(nav.requests.isEmpty())
    }
    @Test fun `closed session stops recovery instead of silently creating another`() {
        var calls = 0
        val vm = model(FakeNavigation(), repository = object : PickupRepository {
            override val pollingIntervalMillis = 3_000L
            override suspend fun loadSession(): PickupSession {
                if (++calls == 1) throw java.io.IOException()
                throw SessionClosedException(false)
            }
        })
        main.dispatcher.scheduler.advanceTimeBy(30_000); main.dispatcher.scheduler.runCurrent()
        assertEquals(2, calls); assertEquals(SessionPhase.ENDED, vm.state.value.sessionPhase)
        assertFalse(vm.state.value.recovering)
    }
    @Test fun `invalid data does not enter automatic retry loop`() {
        var calls = 0
        val vm = model(FakeNavigation(), repository = object : PickupRepository {
            override val pollingIntervalMillis = 3_000L
            override suspend fun loadSession(): PickupSession { calls++; throw IllegalArgumentException() }
        })
        main.dispatcher.scheduler.advanceTimeBy(30_000); main.dispatcher.scheduler.runCurrent()
        assertEquals(1, calls); assertFalse(vm.state.value.recovering)
    }
    @Test fun `destination change hides old candidates until acknowledged and blocks unknown choices`() {
        var calls = 0; val gate = CompletableDeferred<PickupSession>()
        val initial = routed().copy(destinationId = "maebong", destinationOptions = listOf(
            DestinationOption("maebong", "매봉"), DestinationOption("yangjae", "양재")))
        val vm = model(FakeNavigation(), repository = object : PickupRepository {
            override suspend fun loadSession() = initial
            override suspend fun changeDestination(session: PickupSession, destinationId: String): PickupSession { calls++; return gate.await() }
        })
        vm.dispatch(PickupAction.ChangeDestination("unknown")); vm.dispatch(PickupAction.ChangeDestination("maebong")); assertEquals(0, calls)
        vm.dispatch(PickupAction.ChangeDestination("yangjae")); vm.dispatch(PickupAction.ChangeDestination("yangjae"))
        assertEquals(1, calls); assertTrue(vm.state.value.recommendations.isEmpty()); assertFalse(vm.state.value.canRequest)
        gate.complete(initial.copy(destinationId = "yangjae", routeCalculation = initial.routeCalculation!!.copy(phase = RouteCalculationPhase.CALCULATING)))
        assertEquals(SessionPhase.CALCULATING, vm.state.value.sessionPhase); assertEquals("yangjae", vm.state.value.session?.destinationId)
    }
    @Test fun `destination change is unavailable during confirmation and pending navigation`() {
        val initial = routed().copy(destinationId = "maebong", destinationOptions = listOf(DestinationOption("yangjae", "양재")))
        val vm = model(FakeNavigation(), repository = object : PickupRepository { override suspend fun loadSession() = initial })
        assertTrue(vm.state.value.canChangeDestination); vm.dispatch(PickupAction.OpenConfirmation)
        assertFalse(vm.state.value.canChangeDestination)
        val pending = model(FakeNavigation(), repository = object : PickupRepository { override suspend fun loadSession() = initial.copy(navigationPending = true) })
        assertFalse(pending.state.value.canChangeDestination)
    }
    @Test fun `unknown vehicle UX state blocks all interactive setup until baseline arrives`() {
        val nav = FakeNavigation(); val vm = model(nav, access = DrivingAccess.UNKNOWN)
        assertFalse(vm.state.value.canInteract); assertFalse(vm.state.value.canSelect)
        assertFalse(vm.state.value.canRequest); assertFalse(vm.state.value.canReload)
        vm.dispatch(PickupAction.ChangePreference(PickupPreference.LESS_WALK))
        vm.dispatch(PickupAction.OpenConfirmation); vm.dispatch(PickupAction.ConfirmRoute)
        assertEquals(PickupPreference.BALANCED, vm.state.value.preference)
        assertNull(vm.state.value.confirmation); assertTrue(nav.requests.isEmpty())
        vm.updateDrivingAccess(DrivingAccess.AVAILABLE)
        assertTrue(vm.state.value.canRequest); assertTrue(nav.requests.isEmpty())
    }

    @Test fun `restriction closes confirmations and returning baseline does not replay them`() {
        val vm = model(FakeNavigation(), repository = object : PickupRepository {
            override suspend fun loadSession() = routed()
        })
        vm.dispatch(PickupAction.OpenConfirmation); assertNotNull(vm.state.value.confirmation)
        vm.updateDrivingAccess(DrivingAccess.RESTRICTED)
        assertNull(vm.state.value.confirmation); assertFalse(vm.state.value.canRecalculate)
        assertFalse(vm.state.value.canChangeDestination); assertFalse(vm.state.value.canEnd)
        vm.updateDrivingAccess(DrivingAccess.AVAILABLE)
        vm.dispatch(PickupAction.OpenEndConfirmation); assertTrue(vm.state.value.endConfirmation)
        vm.updateDrivingAccess(DrivingAccess.UNKNOWN); assertFalse(vm.state.value.endConfirmation)
        vm.updateDrivingAccess(DrivingAccess.AVAILABLE)
        assertNull(vm.state.value.confirmation); assertFalse(vm.state.value.endConfirmation)
    }

    @Test fun `restriction during server selection prevents late navigation even after unblocking`() {
        val gate = CompletableDeferred<PickupSession>(); val reports = mutableListOf<Boolean>()
        val nav = FakeNavigation()
        val vm = model(nav, repository = object : PickupRepository {
            override suspend fun loadSession() = routed()
            override suspend fun selectCandidate(session: PickupSession, candidate: PickupCandidate) = gate.await()
            override suspend fun reportNavigation(session: PickupSession, confirmed: Boolean) { reports += confirmed }
        })
        vm.dispatch(PickupAction.OpenConfirmation); vm.dispatch(PickupAction.ConfirmRoute)
        vm.updateDrivingAccess(DrivingAccess.RESTRICTED); vm.updateDrivingAccess(DrivingAccess.AVAILABLE)
        gate.complete(routed())
        assertTrue(nav.requests.isEmpty()); assertEquals(listOf(false), reports)
        assertFalse(vm.state.value.navigation.busy); assertNull(vm.state.value.confirmation)
    }

    @Test fun `restriction preserves already dispatched navigation without sending another request`() {
        val nav = FakeNavigation(); val vm = model(nav)
        vm.dispatch(PickupAction.OpenConfirmation); vm.dispatch(PickupAction.ConfirmRoute)
        assertEquals(1, nav.requests.size)
        nav.emit(NavigationState(NavigationPhase.ROUTING, true))
        vm.updateDrivingAccess(DrivingAccess.RESTRICTED)
        vm.dispatch(PickupAction.ConfirmRoute)
        assertEquals(1, nav.requests.size); assertFalse(nav.closed)
        assertEquals(NavigationPhase.ROUTING, vm.state.value.navigation.phase)
    }

    @Test fun `session termination continues to arrive while interactive controls are blocked`() {
        var ended = false
        val vm = model(FakeNavigation(), repository = object : PickupRepository {
            override val pollingIntervalMillis = 3_000L
            override suspend fun loadSession(): PickupSession {
                if (ended) throw SessionClosedException(false)
                return routed()
            }
        })
        vm.updateDrivingAccess(DrivingAccess.RESTRICTED); ended = true
        main.dispatcher.scheduler.advanceTimeBy(3_000); main.dispatcher.scheduler.runCurrent()
        assertEquals(SessionPhase.ENDED, vm.state.value.sessionPhase)
        assertFalse(vm.state.value.canInteract); assertNull(vm.state.value.session)
    }


    @Test fun `missing vehicle destination blocks confirmation until route refresh`() {
        val nav=FakeNavigation().apply { routeAvailable=false };val vm=model(nav)
        assertFalse(vm.state.value.canRequest);vm.dispatch(PickupAction.OpenConfirmation);assertNull(vm.state.value.confirmation)
        nav.routeAvailable=true;vm.dispatch(PickupAction.RefreshVehicleRoute)
        assertTrue(vm.state.value.canRequest)
    }
    @Test fun `a changed original itinerary dismisses the pending user confirmation`() {
        val nav=FakeNavigation();val vm=model(nav)
        vm.dispatch(PickupAction.OpenConfirmation);assertNotNull(vm.state.value.confirmation)
        nav.emit(NavigationState(NavigationPhase.READY,true,route=nav.original.copy(routeOption="FREE")))
        assertNull(vm.state.value.confirmation);vm.dispatch(PickupAction.ConfirmRoute);assertTrue(nav.requests.isEmpty())
    }
    @Test fun `fresh vehicle input is only available while location and original route are both fresh`() {
        val vm=model(FakeNavigation());val fix=VehicleFix(GeoPoint(37.4,127.0),now(),1f,0,0)
        vm.updateVehicleLocation(VehicleLocationState(VehicleLocationPhase.FRESH,fix,0,true))
        assertNotNull(vm.state.value.vehicleTripInput)
        vm.updateVehicleLocation(VehicleLocationState(VehicleLocationPhase.PAUSED))
        assertNull(vm.state.value.vehicleTripInput)
    }
    @Test fun `unverified vehicle waypoint support blocks confirmation and server selection`() {
        val nav=FakeNavigation().apply { waypointAvailable=false };val vm=model(nav)
        assertNotNull(vm.state.value.navigation.route)
        assertFalse(vm.state.value.canRequest)
        vm.dispatch(PickupAction.OpenConfirmation);vm.dispatch(PickupAction.ConfirmRoute)
        assertNull(vm.state.value.confirmation);assertTrue(nav.requests.isEmpty())
        nav.waypointAvailable=true;nav.refreshRoute();vm.dispatch(PickupAction.OpenConfirmation)
        assertNotNull(vm.state.value.confirmation)
        nav.waypointAvailable=false;nav.refreshRoute()
        assertNull(vm.state.value.confirmation);assertNull(vm.state.value.confirmationRoute)
    }

}
