package dev.pickspot.app.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.pickspot.app.domain.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

class VehicleLocationViewModel(
    private val gateway: VehicleLocationGateway,
    private val wallMillis: () -> Long,
    private val elapsedMillis: () -> Long,
    private val policy: VehicleLocationPolicy = VehicleLocationPolicy()
) : ViewModel() {
    private val mutableState = MutableStateFlow(VehicleLocationState())
    val state = mutableState.asStateFlow()
    private var foreground = false
    private var enabled = false
    private var generation = 0
    private var watcher: Job? = null
    private var latest: VehicleFix? = null
    private var newestTimestamp = 0L

    fun checkSupported(): Boolean {
        if (runCatching { gateway.isSupported() }.getOrDefault(false)) return true
        stop(); mutableState.value = VehicleLocationState(VehicleLocationPhase.UNSUPPORTED)
        return false
    }
    fun start(permissionGranted: Boolean) {
        if (!checkSupported()) return
        if (!permissionGranted) {
            stop(); mutableState.value = VehicleLocationState(VehicleLocationPhase.PERMISSION_REQUIRED)
            return
        }
        enabled = true
        if (foreground) begin() else mutableState.value = VehicleLocationState(VehicleLocationPhase.PAUSED, enabled = true)
    }
    fun onForeground(permissionGranted: Boolean) {
        foreground = true
        if (enabled) start(permissionGranted)
    }
    fun onBackground() {
        foreground = false
        cancelCollection()
        mutableState.value = VehicleLocationState(if (enabled) VehicleLocationPhase.PAUSED else VehicleLocationPhase.OFF, enabled = enabled)
    }
    fun stop() {
        enabled = false; cancelCollection()
        mutableState.value = VehicleLocationState()
    }
    private fun cancelCollection() {
        generation++; watcher?.cancel(); watcher = null
        latest = null; newestTimestamp = 0L
        gateway.stop()
    }
    private fun begin() {
        cancelCollection()
        val epoch = generation
        mutableState.value = VehicleLocationState(VehicleLocationPhase.WAITING, enabled = true)
        watcher = viewModelScope.launch {
            val startedAt = elapsedMillis()
            while (isActive) {
                delay(1_000)
                val fix = latest
                if (fix != null) publish(fix)
                else if (mutableState.value.phase == VehicleLocationPhase.WAITING && elapsedMillis() - startedAt >= 15_000)
                    mutableState.value = VehicleLocationState(VehicleLocationPhase.TIMEOUT, enabled = true)
            }
        }
        try {
            gateway.start(onSample = sample@{ sample ->
                if (epoch != generation) return@sample
                if (sample == null) return@sample // An empty cached reply does not overwrite a live fix.
                val validated = policy.validate(sample, wallMillis(), elapsedMillis())
                if (validated == null) {
                    latest = null
                    mutableState.value = VehicleLocationState(VehicleLocationPhase.INVALID, enabled = true)
                } else if (validated.observedAtEpochMillis > newestTimestamp) {
                    newestTimestamp = validated.observedAtEpochMillis
                    latest = validated; publish(validated)
                }
            }, onError = {
                if (epoch == generation) {
                    latest = null
                    mutableState.value = VehicleLocationState(VehicleLocationPhase.ERROR, enabled = true)
                }
            })
        } catch (_: Exception) {
            cancelCollection()
            mutableState.value = VehicleLocationState(VehicleLocationPhase.ERROR, enabled = true)
        }
    }
    private fun publish(fix: VehicleFix) {
        val age = fix.ageMillis(elapsedMillis()) / 1_000
        val fresh = policy.isFresh(fix, elapsedMillis())
        mutableState.value = VehicleLocationState(
            if (fresh) VehicleLocationPhase.FRESH else VehicleLocationPhase.STALE,
            fix = if (fresh) fix else null, ageSeconds = age, enabled = true)
    }
    override fun onCleared() { enabled = false; cancelCollection() }
}
