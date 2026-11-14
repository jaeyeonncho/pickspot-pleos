package dev.pickspot.app.driving

import android.car.Car
import android.car.drivingstate.CarUxRestrictions
import android.car.drivingstate.CarUxRestrictionsManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import dev.pickspot.app.domain.DrivingAccess

/** Activity-scoped AAOS UX service adapter used by Pleos. No speed/GPS access. */
class PleosDrivingAccess(private val context: Context) {
    private val handler = Handler(Looper.getMainLooper())
    private var car: Car? = null
    private var manager: CarUxRestrictionsManager? = null
    private var generation = 0

    fun start(onAccess: (DrivingAccess) -> Unit) {
        stop()
        val epoch = generation
        onAccess(DrivingAccess.UNKNOWN)
        fun publish(value: CarUxRestrictions?) {
            if (epoch == generation) onAccess(value?.let {
                DrivingAccess.fromPlatform(it.isRequiresDistractionOptimization, it.activeRestrictions)
            } ?: DrivingAccess.UNKNOWN)
        }
        try {
            car = Car.createCar(context, handler, Car.CAR_WAIT_TIMEOUT_DO_NOT_WAIT) { connectedCar, ready ->
                // Queue a synchronous createCar callback until assignment completes.
                handler.post {
                    if (epoch != generation) return@post
                    runCatching { manager?.unregisterListener() }
                    manager = null
                    publish(null)
                    if (ready) {
                        try {
                            val service = connectedCar.getCarManager(Car.CAR_UX_RESTRICTION_SERVICE) as? CarUxRestrictionsManager
                            manager = service
                            service?.registerListener { value ->
                                if (epoch == generation && manager === service) publish(value)
                            }
                            publish(service?.currentCarUxRestrictions)
                        } catch (_: Exception) {
                            runCatching { manager?.unregisterListener() }
                            manager = null
                            publish(null)
                        }
                    }
                }
            }
        } catch (_: Exception) { stop(); onAccess(DrivingAccess.UNKNOWN) }
    }

    fun stop() {
        generation++
        handler.removeCallbacksAndMessages(null)
        runCatching { manager?.unregisterListener() }
        manager = null
        runCatching { car?.disconnect() }
        car = null
    }
}
