package dev.pickspot.app.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.pickspot.app.domain.*
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class TripPreviewPhase { IDLE, LOADING, READY, STALE, ERROR }
data class TripPreviewState(val target: TripPreviewTarget? = null, val allowed: Boolean = false,
    val busy: Boolean = false, val phase: TripPreviewPhase = TripPreviewPhase.IDLE,
    val metrics: TripPreviewMetrics? = null, val ageSeconds: Long? = null,
    val issue: TripPreviewIssue? = null, val restartRequired: Boolean = false) {
    val canRequest get() = target != null && allowed && !busy && !restartRequired && phase != TripPreviewPhase.READY
}

/** Candidate/session/lifecycle ownership is separate from both the SDK and screen layout. */
class TripPreviewViewModel(private val gateway: TripPreviewGateway, private val elapsed: () -> Long) : ViewModel() {
    private val mutableState = MutableStateFlow(TripPreviewState())
    val state = mutableState.asStateFlow()
    private var revision = 0
    private var expiry: Job? = null
    private var closed = false

    fun update(target: TripPreviewTarget?, allowed: Boolean) {
        gateway.setInteractionAllowed(allowed)
        val old = mutableState.value
        if (target != old.target || allowed != old.allowed) {
            revision++; expiry?.cancel(); expiry = null
            mutableState.value = TripPreviewState(target, allowed, busy=old.busy,
                restartRequired=old.restartRequired, issue=if(old.restartRequired) old.issue else null)
        }
    }
    fun request() {
        val current = mutableState.value
        if (!current.canRequest) return
        val target = current.target ?: return
        val epoch = revision
        mutableState.value = current.copy(busy=true, phase=TripPreviewPhase.LOADING, metrics=null, ageSeconds=null, issue=null)
        var delivered = false
        gateway.request(target) completion@{ outcome ->
            if (delivered) return@completion
            delivered = true
            if (closed) return@completion
            val latest = mutableState.value
            val locked = outcome is TripPreviewOutcome.Failure && outcome.restartRequired
            if (epoch != revision || !latest.allowed || target != latest.target) {
                mutableState.value = latest.copy(busy=false, restartRequired=latest.restartRequired || locked,
                    issue=if(locked) (outcome as TripPreviewOutcome.Failure).issue else latest.issue)
            } else when(outcome) {
                is TripPreviewOutcome.Failure -> mutableState.value = latest.copy(busy=false, phase=TripPreviewPhase.ERROR,
                    metrics=null, ageSeconds=null, issue=outcome.issue, restartRequired=outcome.restartRequired)
                is TripPreviewOutcome.Success -> {
                    mutableState.value = latest.copy(busy=false, phase=TripPreviewPhase.READY, metrics=outcome.metrics, ageSeconds=0)
                    val received = elapsed()
                    expiry = viewModelScope.launch {
                        while (true) {
                            delay(1_000)
                            if (epoch != revision) break
                            val age = elapsed() - received
                            if (age < 0 || age >= TripPreviewPolicy.VALID_FOR_MILLIS) {
                                mutableState.value = mutableState.value.copy(phase=TripPreviewPhase.STALE, metrics=null, ageSeconds=null)
                                break
                            }
                            mutableState.value = mutableState.value.copy(ageSeconds=age / 1000)
                        }
                    }
                }
            }
        }
    }
    override fun onCleared() {
        closed=true; revision++; expiry?.cancel(); gateway.close()
    }
}

fun PickupUiState.tripPreviewTarget(): TripPreviewTarget? {
    val candidate = selected ?: return null
    val currentSession = session ?: return null
    if (sessionPhase != SessionPhase.READY || currentSession.isExpired(checkedAtEpochMillis) ||
        candidate.curbStatus == CurbStatus.RESTRICTED) return null
    return TripPreviewTarget(currentSession.id, candidate.id, candidate.name, candidate.point, candidate.poi)
}
