package dev.pickspot.app.ui

import android.content.Context
import android.view.View
import android.widget.Button
import android.widget.TextView
import dev.pickspot.app.R
import dev.pickspot.app.domain.VehicleLocationPhase
import dev.pickspot.app.domain.VehicleLocationState
import java.text.DateFormat
import java.util.Date
import java.util.Locale

/** UI-only mapping. Location freshness and SDK calls live outside this panel. */
class VehicleLocationPanel(
    private val context: Context, root: View,
    onStart: () -> Unit, onStop: () -> Unit
) {
    private val status = root.findViewById<TextView>(R.id.vehicle_location_status)
    private val details = root.findViewById<TextView>(R.id.vehicle_location_details)
    private val start = root.findViewById<Button>(R.id.vehicle_location_start)
    private val stop = root.findViewById<Button>(R.id.vehicle_location_stop)
    init { start.setOnClickListener { onStart() }; stop.setOnClickListener { onStop() } }
    fun render(state: VehicleLocationState) {
        status.setText(when (state.phase) {
            VehicleLocationPhase.OFF -> R.string.vehicle_location_off
            VehicleLocationPhase.UNSUPPORTED -> R.string.vehicle_location_unsupported
            VehicleLocationPhase.PERMISSION_REQUIRED -> R.string.vehicle_location_permission
            VehicleLocationPhase.WAITING -> R.string.vehicle_location_waiting
            VehicleLocationPhase.FRESH -> R.string.vehicle_location_fresh
            VehicleLocationPhase.STALE -> R.string.vehicle_location_stale
            VehicleLocationPhase.INVALID -> R.string.vehicle_location_invalid
            VehicleLocationPhase.TIMEOUT -> R.string.vehicle_location_timeout
            VehicleLocationPhase.ERROR -> R.string.vehicle_location_error
            VehicleLocationPhase.PAUSED -> R.string.vehicle_location_paused
        })
        val fix = state.freshFix
        details.visibility = if (fix != null) View.VISIBLE else View.GONE
        details.text = fix?.let {
            context.getString(R.string.vehicle_location_details,
                String.format(Locale.US, "%.5f, %.5f", it.point.latitude, it.point.longitude),
                DateFormat.getTimeInstance(DateFormat.MEDIUM).format(Date(it.observedAtEpochMillis)),
                state.ageSeconds ?: 0L)
        }.orEmpty()
        start.isEnabled = state.phase !in setOf(VehicleLocationPhase.FRESH, VehicleLocationPhase.WAITING)
        stop.visibility = if (state.enabled) View.VISIBLE else View.GONE
    }
}
