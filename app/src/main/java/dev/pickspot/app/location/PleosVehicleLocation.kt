package dev.pickspot.app.location

import ai.pleos.playground.location.fused.FusedLocation
import ai.pleos.playground.location.fused.listener.FusedLocationListener
import ai.pleos.playground.location.fused.model.LocationData
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import dev.pickspot.app.domain.VehicleLocationGateway
import dev.pickspot.app.domain.VehicleLocationSample

/** No fallback to phone/network location, no coordinate logging, no backend transmission. */
class PleosVehicleLocation(context: Context) : VehicleLocationGateway {
    private val context = context.applicationContext
    private val handler = Handler(Looper.getMainLooper())
    private var sdk: FusedLocation? = null
    private var listener: FusedLocationListener? = null
    private var generation = 0

    override fun isSupported() = runCatching { FusedLocation(context).isSupported() }.getOrDefault(false)

    @SuppressLint("MissingPermission") // Custom permission is checked here and before Activity launch.
    override fun start(onSample: (VehicleLocationSample?) -> Unit, onError: () -> Unit) {
        stop()
        if (ContextCompat.checkSelfPermission(context, PERMISSION) != PackageManager.PERMISSION_GRANTED) {
            onError(); return
        }
        val epoch = generation
        fun deliver(action: () -> Unit) { handler.post { if (epoch == generation) action() } }
        val events = object : FusedLocationListener {
            override fun onChanged(location: LocationData?) = deliver {
                onSample(location?.let { VehicleLocationSample(it.latitude, it.longitude, it.timestampMillis, it.confidence) })
            }
            override fun onError(exception: Exception) = deliver { onError() }
        }
        try {
            val api = FusedLocation(context)
            sdk = api; listener = events
            api.initialize()
            api.registerFusedLocationCallback(events)
            api.getLastKnownLocation(events)
        } catch (_: Exception) { stop(); onError() }
    }

    @SuppressLint("MissingPermission")
    override fun stop() {
        generation++
        val api = sdk
        val events = listener
        sdk = null; listener = null
        if (events != null) runCatching { api?.unregisterFusedLocationCallback(events) }
        runCatching { api?.release() }
        handler.removeCallbacksAndMessages(null)
    }
    companion object { const val PERMISSION = "pleos.car.permission.FUSED_LOCATION" }
}
