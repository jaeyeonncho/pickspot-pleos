package dev.pickspot.app.presentation

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.pickspot.app.domain.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class SessionPhase { LOADING, WAITING, CALCULATING, ROUTE_FAILED, READY, ERROR, EXPIRED, ENDED }
enum class SessionIssue { UNAVAILABLE, TIMEOUT, INVALID_DATA, CONFLICT, RATE_LIMIT }

data class PickupUiState(
    val session: PickupSession? = null,
    val preference: PickupPreference = PickupPreference.BALANCED,
    val recommendations: List<RankedPickup> = emptyList(),
    val selectedId: String? = null,
    val meetingChoiceAvailable: Boolean = false,
    val sessionPhase: SessionPhase = SessionPhase.LOADING,
    val sessionIssue: SessionIssue? = null,
    val navigation: NavigationState = NavigationState(),
    val confirmation: PickupCandidate? = null,
    val confirmationRoute: VehicleRoute? = null,
    val vehicleLocation: VehicleLocationState = VehicleLocationState(),
    val shareFailed: Boolean = false,
    val endConfirmation: Boolean = false,
    val managing: Boolean = false,
    val recovering: Boolean = false,
    val checkedAtEpochMillis: Long = 0,
    val drivingAccess: DrivingAccess = DrivingAccess.UNKNOWN
) {
    val canInteract get() = drivingAccess == DrivingAccess.AVAILABLE
    val selected get() = recommendations.firstOrNull { it.candidate.id == selectedId }?.candidate
    // A preview is local. Only a current server acknowledgement is a confirmed meeting.
    val confirmedMeeting get() = if (meetingChoiceAvailable && sessionPhase == SessionPhase.READY && !recovering)
        session?.candidates?.firstOrNull { it.id == session.selectedCandidateId && it.curbStatus != CurbStatus.RESTRICTED } else null
    val canConfirmMeeting get() = meetingChoiceAvailable && canSelect && !recovering && selected != null && selectedId != confirmedMeeting?.id
    val confirmingMeeting get() = meetingChoiceAvailable && managing && selected != null
    val vehicleTripInput get() = vehicleLocation.freshFix?.let { fix -> navigation.route?.takeIf { it.isFresh(checkedAtEpochMillis) }?.let { VehicleTripInput(fix, it) } }
    val canRequest get() = navigation.waypointDispatchAvailable && navigation.route?.let { it.isFresh(checkedAtEpochMillis) && it.waypoints.size < 2 } == true && canInteract && sessionPhase == SessionPhase.READY && selected != null && navigation.connected && !navigation.busy && confirmation == null && !endConfirmation && !managing
    val canSelect get() = canInteract && sessionPhase == SessionPhase.READY && !navigation.busy && confirmation == null && !endConfirmation && !managing
    val canReload get() = canInteract && canRefreshSession
    val canRefreshSession get() = sessionPhase != SessionPhase.LOADING && confirmation == null && !endConfirmation && !managing &&
        navigation.phase !in setOf(NavigationPhase.REQUESTING, NavigationPhase.ROUTING, NavigationPhase.VERIFYING)
    val canRecalculate get() = canReload && sessionPhase in setOf(SessionPhase.READY, SessionPhase.ROUTE_FAILED) &&
        session?.navigationPending != true && session?.routeCalculation?.let {
            it.attemptsRemaining > 0 && checkedAtEpochMillis >= it.retryAtEpochMillis
        } == true
    val canChangeDestination get() = canReload && session?.destinationOptions?.isNotEmpty() == true &&
        !navigation.busy && session?.navigationPending != true && (sessionPhase == SessionPhase.WAITING || canRecalculate)
    val canEnd get() = canInteract && session?.canEndRemotely == true && !navigation.busy && !managing && confirmation == null && !endConfirmation
    val excludedCount get() = session?.candidates?.count { it.curbStatus == CurbStatus.RESTRICTED } ?: 0
}

sealed interface PickupAction {
    data class ChangePreference(val value: PickupPreference) : PickupAction
    data class SelectCandidate(val id: String) : PickupAction
    data object ConfirmMeetingPoint : PickupAction
    data object OpenConfirmation : PickupAction
    data object DismissConfirmation : PickupAction
    data object ConfirmRoute : PickupAction
    data object RefreshVehicleRoute : PickupAction
    data object Reconnect : PickupAction
    data object ReloadSession : PickupAction
    data object NewSession : PickupAction
    data object RetryShare : PickupAction
    data object CheckExpiry : PickupAction
    data class ChangeDestination(val id: String) : PickupAction
    data object RecalculateRoutes : PickupAction
    data object OpenEndConfirmation : PickupAction
    data object DismissEndConfirmation : PickupAction
    data object ConfirmEnd : PickupAction
}

class PickupViewModel(
    private val savedState: SavedStateHandle,
    private val repository: PickupRepository,
    private val recommender: PickupRecommender,
    private val navigator: NavigationGateway,
    private val now: () -> Long = System::currentTimeMillis
) : ViewModel() {
    private val initialPreference = PickupPreference.entries.firstOrNull {
        it.name == savedState.get<String>("preference")
    } ?: PickupPreference.BALANCED
    private val mutableState = MutableStateFlow(PickupUiState(preference = initialPreference, meetingChoiceAvailable = repository.sharesMeetingChoice))
    val state = mutableState.asStateFlow()
    private var loading: Job? = null
    private var expiry: Job? = null
    private var polling: Job? = null
    private var submitting: Job? = null
    private var sharing: Job? = null
    private var managing: Job? = null
    private var revision = 0
    private var interactionRevision = 0
    private var failures = 0
    private var retryAt = 0L
    private var routeSession: PickupSession? = null
    private var receipt: Pair<PickupSession, Boolean>? = null

    init {
        navigator.onState = { navigation ->
            val current = mutableState.value
            val confirmedRoute = current.confirmationRoute
            val changed = confirmedRoute != null && (!navigation.waypointDispatchAvailable || navigation.route == null || !confirmedRoute.sameItinerary(navigation.route))
            mutableState.value = current.copy(navigation = navigation,
                confirmation = if(changed) null else current.confirmation, confirmationRoute = if(changed) null else confirmedRoute)
            val sent = routeSession
            if (sent != null && navigation.phase in setOf(NavigationPhase.CONFIRMED, NavigationPhase.FAILED)) {
                routeSession = null
                receipt = sent to (navigation.phase == NavigationPhase.CONFIRMED)
                shareResult()
            }
        }
        navigator.connect()
        loadSession()
        repository.pollingIntervalMillis?.let { interval ->
            polling = viewModelScope.launch {
                while (isActive) {
                    delay(interval)
                    val current = mutableState.value
                    if ((current.sessionPhase in setOf(SessionPhase.WAITING, SessionPhase.CALCULATING, SessionPhase.ROUTE_FAILED, SessionPhase.READY) ||
                        (current.recovering && now() >= retryAt)) && current.canRefreshSession)
                        loadSession(background = true)
                }
            }
        }
    }

    fun updateVehicleLocation(location: VehicleLocationState) {
        mutableState.value = mutableState.value.copy(vehicleLocation = location)
    }

    fun updateDrivingAccess(access: DrivingAccess) {
        navigator.setInteractionAllowed(access == DrivingAccess.AVAILABLE)
        val current = mutableState.value
        if (access != DrivingAccess.AVAILABLE) {
            interactionRevision++
            mutableState.value = current.copy(drivingAccess = access, confirmation = null, confirmationRoute = null, endConfirmation = false)
        } else mutableState.value = current.copy(drivingAccess = access)
    }

    fun dispatch(action: PickupAction) {
        checkExpiry()
        val current = mutableState.value
        if (!current.canInteract && action !in setOf(PickupAction.CheckExpiry,
                PickupAction.DismissConfirmation, PickupAction.DismissEndConfirmation)) return
        when (action) {
            is PickupAction.ChangePreference -> if (current.canSelect) {
                val ranked = recommender.rank(current.session!!.candidates, action.value)
                updateSelection(current.copy(preference = action.value, recommendations = ranked,
                    selectedId = ranked.firstOrNull()?.candidate?.id))
            }
            is PickupAction.SelectCandidate -> if (current.canSelect && current.recommendations.any { it.candidate.id == action.id }) {
                updateSelection(current.copy(selectedId = action.id))
            }
            PickupAction.ConfirmMeetingPoint -> if (current.canConfirmMeeting) manageSession(current, end = false, choice = current.selected)
            PickupAction.OpenConfirmation -> if (current.canRequest) mutableState.value = current.copy(confirmation = current.selected, confirmationRoute = current.navigation.route)
            PickupAction.DismissConfirmation -> mutableState.value = current.copy(confirmation = null, confirmationRoute = null)
            PickupAction.ConfirmRoute -> confirmRoute(current)
            PickupAction.RefreshVehicleRoute -> if (!current.navigation.busy) { if(current.navigation.connected) navigator.refreshRoute() else navigator.connect() }
            PickupAction.Reconnect -> if (!current.navigation.busy && !current.navigation.connected) navigator.connect()
            PickupAction.ReloadSession -> if (current.canReload) loadSession()
            PickupAction.NewSession -> if (current.canReload && current.sessionPhase in setOf(SessionPhase.ENDED,SessionPhase.EXPIRED)) {
                repository.resetSession(); receipt = null; routeSession = null
                mutableState.value = current.copy(shareFailed = false)
                loadSession()
            }
            PickupAction.RetryShare -> if (current.shareFailed && !current.navigation.busy) shareResult()
            PickupAction.CheckExpiry -> Unit
            is PickupAction.ChangeDestination -> if (current.canChangeDestination && action.id != current.session?.destinationId &&
                current.session?.destinationOptions?.any { it.id == action.id } == true) manageSession(current, end = false, destinationId = action.id)
            PickupAction.RecalculateRoutes -> if (current.canRecalculate) manageSession(current, end = false)
            PickupAction.OpenEndConfirmation -> if (current.canEnd) mutableState.value = current.copy(endConfirmation = true)
            PickupAction.DismissEndConfirmation -> mutableState.value = current.copy(endConfirmation = false)
            PickupAction.ConfirmEnd -> if (current.endConfirmation && !current.managing) manageSession(current, end = true)
        }
    }

    private fun manageSession(current: PickupUiState, end: Boolean, destinationId: String? = null,choice:PickupCandidate?=null) {
        val session = current.session ?: return
        loading?.cancel(); loading = null
        val epoch = ++revision
        mutableState.value = current.copy(managing = true, endConfirmation = false, confirmation = null, confirmationRoute = null,
            recommendations = if(choice!=null)current.recommendations else emptyList(), selectedId = choice?.id)
        managing = viewModelScope.launch {
            try {
                if (end) {
                    withTimeout(15_000) { repository.endSession(session) }
                    ensureActive()
                    if (epoch == revision) { sharing?.cancel(); routeSession = null; closeSession(false) }
                } else {
                    val updated = withTimeout(15_000) { when {
                        choice!=null->repository.shareMeetingChoice(session,choice)
                        destinationId!=null->repository.changeDestination(session,destinationId)
                        else->repository.recalculateRoutes(session)
                    } }
                    ensureActive()
                    if (epoch == revision) {
                        mutableState.value = mutableState.value.copy(managing = false)
                        if (updated.isExpired(now())) closeSession(true) else applySession(updated)
                    }
                }
            } catch (_: TimeoutCancellationException) { if (epoch == revision) loadFailed(SessionIssue.TIMEOUT) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (closed: SessionClosedException) { if (epoch == revision) closeSession(closed.expired) }
            catch (_: SessionConflictException) { if (epoch == revision) loadFailed(SessionIssue.CONFLICT) }
            catch (_: SessionRateLimitException) { if (epoch == revision) loadFailed(SessionIssue.RATE_LIMIT) }
            catch (_: Exception) { if (epoch == revision) loadFailed(SessionIssue.UNAVAILABLE) }
        }
    }

    private fun confirmRoute(current: PickupUiState) {
        if (!current.canInteract) return
        val permissionRevision = interactionRevision
        if (!current.navigation.waypointDispatchAvailable) return
        val target = current.confirmation ?: return
        val originalRoute = current.confirmationRoute ?: return
        if (!originalRoute.isFresh(now())) { mutableState.value = current.copy(confirmation=null, confirmationRoute=null); navigator.refreshRoute(); return }
        val session = current.session ?: return
        if (current.sessionPhase != SessionPhase.READY || !current.navigation.connected || current.navigation.busy) return
        loading?.cancel(); sharing?.cancel(); receipt = null
        val epoch = ++revision
        mutableState.value = current.copy(confirmation = null, shareFailed = false,
            navigation = current.navigation.copy(phase=NavigationPhase.REQUESTING, issue=null), confirmationRoute = null)
        submitting = viewModelScope.launch {
            try {
                val selected = withTimeout(15_000) { repository.selectCandidate(session, target) }
                ensureActive()
                if (epoch != revision) { unlockRequest(); return@launch }
                if (selected.isExpired(now())) { unlockRequest(); closeSession(true); return@launch }
                val calculation = selected.routeCalculation
                if (calculation != null && (calculation.phase != RouteCalculationPhase.READY ||
                    calculation.validUntilEpochMillis?.let { now() >= it } != false)) throw SessionConflictException()
                val validated = selected.candidates.firstOrNull { it.id == target.id }
                if (validated?.point != target.point || validated.curbStatus == CurbStatus.RESTRICTED) throw SessionConflictException()
                mutableState.value = mutableState.value.copy(session = selected)
                // Selection is a server transaction. If access changed while awaiting it,
                // clear the server pending state without dispatching a new navigation request.
                if (!mutableState.value.canInteract || permissionRevision != interactionRevision) {
                    receipt = selected to false
                    unlockRequest()
                    shareResult()
                    return@launch
                }
                routeSession = selected
                navigator.request(target, originalRoute)
            } catch (_: TimeoutCancellationException) { if (epoch == revision) { unlockRequest(); loadFailed(SessionIssue.TIMEOUT) } }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (closed: SessionClosedException) { if (epoch == revision) { unlockRequest(); closeSession(closed.expired) } }
            catch (_: SessionConflictException) { if (epoch == revision) { unlockRequest(); loadFailed(SessionIssue.CONFLICT) } }
            catch (_: Exception) { if (epoch == revision) { unlockRequest(); loadFailed(SessionIssue.UNAVAILABLE) } }
        }
    }
    private fun unlockRequest() {
        mutableState.value = mutableState.value.copy(navigation = mutableState.value.navigation.copy(phase=NavigationPhase.READY, issue=null))
    }
    private fun shareResult() {
        if (sharing?.isActive == true) return
        val pending = receipt ?: return
        sharing = viewModelScope.launch {
            try {
                withTimeout(15_000) { repository.reportNavigation(pending.first, pending.second) }
                if (receipt === pending) { receipt = null; mutableState.value = mutableState.value.copy(shareFailed = false) }
            } catch (_: TimeoutCancellationException) { if (receipt === pending) mutableState.value = mutableState.value.copy(shareFailed = true) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (closed: SessionClosedException) { if (receipt === pending) { receipt = null; closeSession(closed.expired) } }
            catch (_: Exception) { if (receipt === pending) mutableState.value = mutableState.value.copy(shareFailed = true) }
        }
    }
    private fun loadSession(background: Boolean = false) {
        if (loading?.isActive == true) return
        val epoch = ++revision
        if (!background) {
            expiry?.cancel()
            mutableState.value = mutableState.value.copy(session = null, recommendations = emptyList(),
                selectedId = null, confirmation = null, confirmationRoute = null, sessionPhase = SessionPhase.LOADING, sessionIssue = null)
        }
        loading = viewModelScope.launch {
            try {
                val session = withTimeout(15_000) { repository.loadSession() }
                ensureActive()
                if (epoch != revision) return@launch
                if (session.isExpired(now())) closeSession(true) else applySession(session)
            } catch (_: TimeoutCancellationException) { if (epoch == revision) loadFailed(SessionIssue.TIMEOUT) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (closed: SessionClosedException) { if (epoch == revision) closeSession(closed.expired) }
            catch (_: IllegalArgumentException) { if (epoch == revision) loadFailed(SessionIssue.INVALID_DATA) }
            catch (_: Exception) { if (epoch == revision) loadFailed(SessionIssue.UNAVAILABLE) }
        }
    }
    private fun applySession(session: PickupSession) {
        failures = 0; retryAt = 0
        val current = mutableState.value
        val calculation = session.routeCalculation
        val stale = calculation?.phase == RouteCalculationPhase.READY && calculation.validUntilEpochMillis?.let { now() >= it } == true
        val phase = when {
            session.availability == SessionAvailability.WAITING -> SessionPhase.WAITING
            calculation?.phase == RouteCalculationPhase.CALCULATING -> SessionPhase.CALCULATING
            stale || calculation?.phase in setOf(RouteCalculationPhase.STALE, RouteCalculationPhase.FAILED) -> SessionPhase.ROUTE_FAILED
            else -> SessionPhase.READY
        }
        val ranked = if (phase == SessionPhase.READY) recommender.rank(session.candidates, current.preference) else emptyList()
        val savedId = savedState.get<String>("selected")?.takeIf { savedState.get<String>("sessionId") == session.id }
        val selected = listOfNotNull(current.selectedId, savedId, session.selectedCandidateId)
            .firstOrNull { id -> ranked.any { it.candidate.id == id } } ?: ranked.firstOrNull()?.candidate?.id
        savedState["sessionId"] = session.id
        updateSelection(current.copy(session = session, recommendations = ranked, selectedId = selected,
            recovering = false, sessionIssue = null, sessionPhase = phase, checkedAtEpochMillis = now()))
        expiry?.cancel()
        expiry = viewModelScope.launch {
            while (isActive) {
                val remaining = session.expiresAtEpochMillis - now()
                if (remaining <= 0) { closeSession(true); break }
                delay(minOf(remaining,1_000L))
                checkExpiry()
            }
        }
    }
    private fun checkExpiry() {
        var current = mutableState.value
        if (current.confirmationRoute?.isFresh(now()) == false) { current=current.copy(confirmation=null, confirmationRoute=null); mutableState.value=current }
        if (current.session?.isExpired(now()) == true) { expiry?.cancel(); closeSession(true); return }
        val route = current.session?.routeCalculation
        val stale = route?.phase == RouteCalculationPhase.READY && route.validUntilEpochMillis?.let { now() >= it } == true
        mutableState.value = if (stale) current.copy(
            session = current.session?.copy(candidates = emptyList(), routeCalculation = route?.copy(phase = RouteCalculationPhase.STALE)),
            recommendations = emptyList(), selectedId = null, confirmation = null, confirmationRoute = null, sessionPhase = SessionPhase.ROUTE_FAILED,
            checkedAtEpochMillis = now()
        ) else current.copy(checkedAtEpochMillis = now())
    }
    private fun closeSession(expired: Boolean) {
        revision++
        loading?.cancel(); loading = null; managing?.cancel(); managing = null
        // 서버 선택을 기다리던 요청만 취소합니다. 이미 전달된 내비 목적지는 유지합니다.
        if (routeSession == null && mutableState.value.navigation.phase == NavigationPhase.REQUESTING) {
            submitting?.cancel()
            unlockRequest()
        }
        receipt = null
        mutableState.value = mutableState.value.copy(session = null, recommendations = emptyList(),
            selectedId = null, confirmation = null, confirmationRoute = null, shareFailed = false, managing = false, endConfirmation = false,
            sessionPhase = if (expired) SessionPhase.EXPIRED else SessionPhase.ENDED, sessionIssue = null, recovering = false)
    }
    private fun loadFailed(issue: SessionIssue) {
        expiry?.cancel()
        failures = (failures + 1).coerceAtMost(4)
        retryAt = now() + (3_000L * (1L shl (failures - 1))).coerceAtMost(15_000L)
        val recover = repository.pollingIntervalMillis != null && issue != SessionIssue.INVALID_DATA
        mutableState.value = mutableState.value.copy(session = null, recommendations = emptyList(), selectedId = null,
            confirmation = null, confirmationRoute = null, managing = false, endConfirmation = false, sessionPhase = SessionPhase.ERROR, sessionIssue = issue, recovering = recover)
    }
    private fun updateSelection(value: PickupUiState) {
        savedState["preference"] = value.preference.name; savedState["selected"] = value.selectedId
        mutableState.value = value
    }
    override fun onCleared() {
        loading?.cancel(); expiry?.cancel(); polling?.cancel(); submitting?.cancel(); sharing?.cancel(); managing?.cancel()
        navigator.onState = null; navigator.close()
    }
}
