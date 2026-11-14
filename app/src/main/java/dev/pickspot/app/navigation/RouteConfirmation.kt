package dev.pickspot.app.navigation

import dev.pickspot.app.domain.GeoPoint

/** A navigation callback can belong to another app. Verify coordinates before claiming success. */
class RouteConfirmation(private val target: GeoPoint) {
    private var completed = false
    var hasStarted: Boolean = false
        private set
    fun routingStarted() { hasStarted = true }
    private var destination: GeoPoint? = null
    fun routingCompleted() { completed = true }
    fun destinationReceived(point: GeoPoint) { destination = point }
    val confirmed: Boolean get() = completed && destination?.let { target.distanceTo(it) <= 35.0 } == true
    // Evaluate at the request deadline: an old destination can arrive while the new route is loading.
    val mismatched: Boolean get() = completed && destination?.let { target.distanceTo(it) > 35.0 } == true
}
