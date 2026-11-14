package dev.pickspot.app.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.pickspot.app.domain.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

// UI, transport, and session persistence can change independently.
enum class SharingPhase { IDLE, CONNECTING, CURRENT, OFFLINE, ENDING, ENDED, PAUSED }
data class SharingUiState(val phase: SharingPhase = SharingPhase.IDLE, val session: SharingSnapshot? = null, val canEnd: Boolean = false, val drivingAccess: DrivingAccess = DrivingAccess.UNKNOWN, val refreshing: Boolean = false, val checkedSecondsAgo: Long? = null) {
    val canInteract: Boolean get() = drivingAccess == DrivingAccess.AVAILABLE
}
class SharingViewModel(private val repository: SharingRepository, private val now: () -> Long = System::currentTimeMillis,
    private val elapsed: () -> Long = { System.nanoTime() / 1_000_000 }) : ViewModel() {
    private val mutable = MutableStateFlow(SharingUiState())
    val state = mutable.asStateFlow()
    private var worker: Job? = null
    private var freshness: Job? = null
    private val initialWall = now()
    private val initialElapsed = elapsed()
    // Wall-clock rollback must not extend a response's lifetime.
    private var latestTime = initialWall
    private fun effectiveNow(): Long {
        latestTime = maxOf(latestTime, now(), initialWall + (elapsed() - initialElapsed).coerceAtLeast(0))
        return latestTime
    }
    private var foreground = false
    private var generation = 0
    private var drivingAccess = DrivingAccess.UNKNOWN
    fun updateDrivingAccess(access: DrivingAccess) {
        drivingAccess = access
        mutable.value = mutable.value.copy(drivingAccess = access)
    }
    private fun publish(value: SharingUiState) { mutable.value = value.copy(drivingAccess = drivingAccess) }
    fun onForeground() { foreground = true; sync() }
    fun onBackground() {
        updateDrivingAccess(DrivingAccess.UNKNOWN)
        foreground = false; generation++; worker?.cancel(); worker = null; freshness?.cancel()
        publish(SharingUiState(SharingPhase.PAUSED))
    }
    fun create() {
        if (!foreground || !state.value.canInteract || repository.hasSession || state.value.phase !in setOf(SharingPhase.IDLE, SharingPhase.ENDED)) return
        sync(create = true)
    }
    fun end() {
        if (!foreground || !state.value.canInteract || !repository.hasSession) return
        repository.requestEnd() // Persist intent before starting the request, including offline.
        sync()
    }
    fun retry() { if (foreground && state.value.canInteract && state.value.phase == SharingPhase.OFFLINE) sync() }
    private fun sync(create: Boolean = false) {
        worker?.cancel(); freshness?.cancel(); val epoch = ++generation
        publish(SharingUiState(if (repository.ending) SharingPhase.ENDING else SharingPhase.CONNECTING, canEnd = repository.hasSession))
        worker = viewModelScope.launch {
            var first = true
            while (isActive && foreground && epoch == generation) {
                var wait = 3_000L
                try {
                    if (first && create && !state.value.canInteract) {
                        publish(SharingUiState(SharingPhase.IDLE))
                        return@launch
                    }
                    val snapshot = if (first && create) repository.create() else repository.refresh()
                    ensureActive()
                    if (epoch != generation || !foreground) return@launch
                    if (snapshot == null) {
                        publish(SharingUiState(if (first && !create && state.value.phase != SharingPhase.ENDING) SharingPhase.IDLE else SharingPhase.ENDED))
                        return@launch
                    }
                    if (snapshot.expiresAt <= effectiveNow()) throw SharingClosedException()
                    val fresh = snapshot.displayableAt(effectiveNow())
                    publish(SharingUiState(SharingPhase.CURRENT, fresh, canEnd = true, checkedSecondsAgo = 0))
                    observeFreshness(snapshot, epoch)
                } catch (e: CancellationException) { throw e
                } catch (_: SharingClosedException) {
                    if (epoch != generation || !foreground) return@launch
                    freshness?.cancel()
                    if (epoch == generation) publish(SharingUiState(SharingPhase.ENDED))
                    return@launch
                } catch (e: Exception) {
                    if (epoch != generation || !foreground) return@launch
                    freshness?.cancel()
                    publish(SharingUiState(if (repository.ending) SharingPhase.ENDING else SharingPhase.OFFLINE, canEnd = repository.hasSession))
                    if (!repository.hasSession) return@launch
                    if (e is SharingRateLimitException) wait = 60_000
                }
                first = false
                // Keep valid content during refresh. A separate clock expires it even if transport is slow.
                delay(wait)
                if (epoch == generation && state.value.phase == SharingPhase.CURRENT) {
                    publish(state.value.copy(refreshing = true))
                }
            }
        }
    }
    private fun observeFreshness(snapshot: SharingSnapshot, epoch: Int) {
        freshness?.cancel()
        val receivedAt = elapsed()
        freshness = viewModelScope.launch {
            while (isActive && foreground && epoch == generation && state.value.phase == SharingPhase.CURRENT) {
                val time = effectiveNow()
                val age = (elapsed() - receivedAt).coerceAtLeast(0)
                if (snapshot.expiresAt <= time) {
                    publish(SharingUiState(SharingPhase.ENDED))
                    return@launch
                }
                // Status confirmation also has a maximum age if a transport never completes.
                if (age >= 30_000) {
                    publish(SharingUiState(SharingPhase.OFFLINE, canEnd = repository.hasSession))
                    return@launch
                }
                publish(state.value.copy(session = snapshot.displayableAt(time), checkedSecondsAgo = age / 1000))
                val deadlines = listOfNotNull(snapshot.expiresAt, snapshot.validUntil, snapshot.recommendation?.validUntil)
                val nextDeadline = deadlines.filter { it > time }.minOrNull()?.minus(time) ?: 1000L
                delay(minOf(1000L - age % 1000, nextDeadline, 30_000L - age).coerceAtLeast(1))
            }
        }
    }
    override fun onCleared() { foreground = false; generation++; worker?.cancel(); freshness?.cancel() }
}
