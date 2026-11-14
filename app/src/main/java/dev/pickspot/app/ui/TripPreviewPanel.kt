package dev.pickspot.app.ui

import android.content.Context
import android.view.View
import android.widget.Button
import android.widget.TextView
import dev.pickspot.app.R
import dev.pickspot.app.presentation.TripPreviewPhase
import dev.pickspot.app.presentation.TripPreviewState

class TripPreviewPanel(private val context: Context, view: View, onRequest: () -> Unit) {
    private val status = view.findViewById<TextView>(R.id.trip_preview_status)
    private val age = view.findViewById<TextView>(R.id.trip_preview_age)
    private val button = view.findViewById<Button>(R.id.trip_preview_request)
    private val text = PickupText(context)
    init { button.setOnClickListener { onRequest() } }
    fun render(state: TripPreviewState) {
        status.text = when {
            state.restartRequired -> context.getString(R.string.trip_preview_restart)
            !state.allowed -> context.getString(R.string.trip_preview_blocked)
            state.busy -> context.getString(R.string.trip_preview_loading)
            state.phase == TripPreviewPhase.READY && state.metrics != null -> {
                val metrics = state.metrics
                val distance = if(metrics.distanceMeters < 1000) context.getString(R.string.trip_preview_meters, metrics.distanceMeters)
                    else context.getString(R.string.trip_preview_kilometers, metrics.distanceMeters / 1000.0)
                context.getString(R.string.trip_preview_ready, text.duration(metrics.durationSeconds), distance)
            }
            state.phase == TripPreviewPhase.STALE -> context.getString(R.string.trip_preview_stale)
            state.phase == TripPreviewPhase.ERROR -> context.getString(R.string.trip_preview_failed)
            else -> context.getString(R.string.trip_preview_idle)
        }
        age.text = state.ageSeconds?.let { context.getString(R.string.trip_preview_age, it) }.orEmpty()
        button.isEnabled = state.canRequest
        button.alpha = if(state.canRequest) 1f else 0.45f
        button.setText(when {
            state.busy -> R.string.trip_preview_wait
            state.phase == TripPreviewPhase.READY -> R.string.trip_preview_current
            state.phase in setOf(TripPreviewPhase.STALE, TripPreviewPhase.ERROR) -> R.string.trip_preview_request_again
            else -> R.string.trip_preview_request
        })
    }
}
