package dev.pickspot.app.probe

import android.app.Activity
import android.app.Instrumentation
import android.content.pm.ApplicationInfo
import android.location.Location
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import ai.pleos.playground.navi.constants.NaviErrorCode
import ai.pleos.playground.navi.constants.NaviMode
import ai.pleos.playground.navi.data.*
import ai.pleos.playground.navi.helper.NaviHelper
import ai.pleos.playground.navi.helper.listener.NaviHelperEventListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/** Explicit emulator-only diagnostic APK, absent from both application variants.
 * Records aggregates/equality only; never serializes vehicle coordinates or POIs.
 * Requests are serial because TripInfo has no public request identifier.
 */
class TripProbeInstrumentation : Instrumentation() {
    private data class Event(val kind: String, val value: Any? = null)
    private val events = LinkedBlockingQueue<Event>()
    private lateinit var helper: NaviHelper
    private var enabled = false
    private var mode: String? = null
    private var waypointMode = false
    private var waypointDiagnostic = false
    private var waypointSafety = false
    private var waypointCleanup = false
    private var waypointIdle = false
    private var previewIntegration = false
    private var previewRender = false
    private var sharingRender = false
    private var observingTrip = false
    private var routeChanges = 0
    private val report = JSONObject().put("locationInput", "emulator-fixed-examples").put("tmapCalls", 0)
    private val listener = object : NaviHelperEventListener {
        override fun onRouteStateInfo(routeStateInfo: RouteStateInfo) { events.offer(Event("state", routeStateInfo)) }
        override fun onDestinationInfo(destinationInfo: DestinationInfo) { events.offer(Event("destination", destinationInfo)) }
        override fun onTripInfo(tripInfo: TripInfo) { events.offer(Event("trip", tripInfo)) }
        override fun onError(errorCode: NaviErrorCode) { events.offer(Event("error", errorCode.name)) }
        override fun onDestinationChanged() { if (observingTrip) routeChanges++ }
        override fun onRouteStarted(routeStartInfo: RouteStartInfo) { if (observingTrip) routeChanges++ }
        override fun onRouteCancelled() { if (observingTrip) routeChanges++ }
        override fun onWaypointChanged(waypointChangedInfo: WaypointChangedInfo) { if (observingTrip) routeChanges++ }
        override fun onRoutingCompleted() { events.offer(Event("routed")) }
        @Suppress("OVERRIDE_DEPRECATION")
        override fun onRouteEnded() { events.offer(Event("routed")) }
    }
    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        enabled = arguments?.getString("fixed_examples") == "true"
        mode = arguments?.getString("mode")
        waypointMode = arguments?.getString("mode") == "waypoints"
        waypointDiagnostic = arguments?.getString("mode") == "waypoint-api"
        waypointSafety = arguments?.getString("mode") == "waypoint-safety"
        waypointCleanup = arguments?.getString("mode") == "waypoint-cleanup"
        waypointIdle = arguments?.getString("mode") == "waypoint-state"
        previewIntegration = arguments?.getString("mode") == "preview-integration"
        previewRender = arguments?.getString("mode") == "preview-render"
        sharingRender = arguments?.getString("mode") == "sharing-render"
        start()
    }
    private fun stage(name: String) { sendStatus(0, Bundle().apply { putString("stream", "stage=$name\n") }) }
    private fun await(kind: String, timeoutSeconds: Long = 15): Event {
        val end = SystemClock.elapsedRealtime() + timeoutSeconds * 1000
        while (true) {
            val remaining = end - SystemClock.elapsedRealtime()
            if (remaining <= 0) return Event("timeout")
            val event = events.poll(remaining, TimeUnit.MILLISECONDS) ?: return Event("timeout")
            if (event.kind == kind || event.kind == "error") return event
        }
    }
    private fun queryState(): RouteStateInfo {
        events.clear(); runOnMainSync { helper.getRouteStateInfo() }
        val result = await("state")
        check(result.kind == "state") { "STATE_${result.kind}" }
        return result.value as RouteStateInfo
    }
    private fun queryDestination(): DestinationInfo {
        events.clear(); runOnMainSync { helper.getDestinationInfo() }
        val result = await("destination")
        check(result.kind == "destination") { "DESTINATION_${result.kind}" }
        return result.value as DestinationInfo
    }
    private fun guiding(state: RouteStateInfo) = state.naviMode in listOf(NaviMode.ROUTE_GUIDING, NaviMode.SIMULATION_GUIDING)
    override fun onStart() {
        // No fallback: a typo in a render/read-only mode must never create navigation guidance.
        if (!enabled || mode !in setOf("trip-preservation", "waypoints", "waypoint-api", "waypoint-safety",
                "waypoint-cleanup", "waypoint-state", "preview-integration", "preview-render", "sharing-render", "vehicle-input-render", "vehicle-input-read", "live-route-contract", "live-route-render", "vehicle-pairing", "vehicle-https", "pickup-render", "pickup-atlas")) {
            finish(Activity.RESULT_CANCELED, Bundle().apply { putString("stream", JSONObject()
                .put("passed", false).put("failure", "EXPLICIT_PROBE_MODE_REQUIRED")
                .put("navigationRequests", 0).put("networkRequests", 0).toString()+"\n") })
            return
        }
        if (mode == "pickup-atlas") { PickupAtlasProbe(this).execute(); return }
        if (mode == "pickup-render") { PickupRenderProbe(this).execute(); return }
        if (mode == "vehicle-https") { VehicleHttpsProbe(this).execute(); return }
        if (mode == "vehicle-pairing") { VehiclePairingProbe(this).execute(); return }
        if (mode == "live-route-render") { LiveRouteRenderProbe(this).execute(); return }
        if (mode == "live-route-contract") { LiveRouteContractProbe(this).execute(); return }
        if (mode == "vehicle-input-render") { VehicleInputRenderProbe(this).execute(); return }
        if (mode == "vehicle-input-read") { VehicleInputReadProbe(this).execute(); return }
        if (enabled && sharingRender) { SharingRenderProbe(this).execute(); return }
        if (enabled && previewRender) { TripPreviewRenderProbe(this).execute(); return }
        if (enabled && previewIntegration) { TripPreviewIntegrationProbe(this).execute(); return }
        if (enabled && waypointIdle) { WaypointIntegrationProbe(this).executeIdleCheck(); return }
        if (enabled && waypointCleanup) { WaypointIntegrationProbe(this).executeSafety(cleanupOnly=true); return }
        if (enabled && waypointSafety) { WaypointIntegrationProbe(this).executeSafety(); return }
        if (enabled && waypointDiagnostic) { WaypointIntegrationProbe(this).executeDiagnostic(); return }
        if (enabled && waypointMode) { WaypointIntegrationProbe(this).execute(); return }
        var connected = false
        var createdBaseline = false
        try {
            check(enabled && Build.HARDWARE in listOf("ranchu", "goldfish") &&
                targetContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) { "EMULATOR_DEBUG_ONLY" }
            stage("connect")
            runOnMainSync {
                helper = NaviHelper(targetContext)
                helper.initialize(onConnected = { helper.addListener(listener); events.offer(Event("connected")) },
                    onFailed = { events.offer(Event("error", "CONNECT_FAILED")) })
            }
            check(await("connected", 30).kind == "connected") { "CONNECT_FAILED" }; connected = true
            stage("baseline")
            var before = queryState()
            report.put("initialIsRouting", before.isRouting).put("initialNaviMode", before.naviMode.name)
            if (!guiding(before)) {
                events.clear()
                runOnMainSync { helper.requestRoute(RouteInfo(latitude = 37.48544722, longitude = 127.03636666,
                    poiName = "42dot", poiId = "36khp37hh8gqcm5nqhe5", poiSubId = "0", address = "서울시 강남구 남부순환로 2621")) }
                createdBaseline = true
                check(await("routed", 40).kind == "routed") { "BASELINE_ROUTE_FAILED" }
                before = queryState()
                for (attempt in 1..10) {
                    if (guiding(before)) break
                    SystemClock.sleep(500); before = queryState()
                }
            }
            report.put("baselineNaviMode", before.naviMode.name).put("baselineIsRouting", before.isRouting)
            check(guiding(before)) { "ACTIVE_ROUTE_REQUIRED" }
            val destination = queryDestination()
            report.put("baselineDestinationRead", true).put("createdExampleBaseline", createdBaseline)
            val results = JSONArray(); report.put("requests", results)
            val examples = listOf(
                TripRequest(37.48544722, 127.03636666, "36khp37hh8gqcm5nqhe5", "42dot", "0"),
                TripRequest(37.41275833, 127.09481944, "36khp2hdj2cfcm5nqhe3", "판교 현대백화점", "0"),
                TripRequest(37.48544722, 127.03636666, "", "픽스팟 좌표 예제", null)
            )
            for ((index, request) in examples.withIndex()) {
                stage("trip_${index + 1}")
                events.clear(); runOnMainSync { routeChanges = 0; observingTrip = true; helper.requestTrip(request) }
                val response = await("trip", 30)
                val result = JSONObject().put("example", index + 1).put("response", response.kind)
                results.put(result)
                if (response.kind == "trip") {
                    val trip = response.value as TripInfo
                    result.put("distanceMeters", trip.distance).put("etaSeconds", trip.eta)
                        .put("routePointCount", trip.summary.routePoints.size)
                        .put("positiveDistanceAndTime", trip.distance > 0 && trip.eta > 0)
                        .put("requestedPoiReturned", request.poiId.isNotEmpty() && trip.summary.routePoints.any { it.poiId == request.poiId })
                        .put("requestedCoordinateReturned", trip.summary.routePoints.any {
                            abs(it.latitude - request.latitude) < 0.00001 && abs(it.longitude - request.longitude) < 0.00001
                        })
                    val offsets = trip.summary.routePoints.map { point ->
                        val distance = FloatArray(1)
                        Location.distanceBetween(request.latitude, request.longitude, point.latitude, point.longitude, distance)
                        JSONObject().put("offsetMeters", distance[0].toInt()).put("type", point.pointType.name)
                            .put("zeroCoordinate", point.latitude == 0.0 && point.longitude == 0.0)
                    }
                    result.put("returnedPointOffsets", JSONArray(offsets)).put("requestedWithPoi", request.poiId.isNotEmpty())
                } else if (response.kind == "error") result.put("error", response.value)
                stage("preservation_${index + 1}")
                SystemClock.sleep(1000)
                val after = queryState()
                val afterDestination = if (guiding(after)) queryDestination() else null
                result.put("isRoutingFlagPreserved", after.isRouting == before.isRouting)
                    .put("guidanceModePreserved", after.naviMode == before.naviMode)
                    .put("routeOptionPreserved", after.routeOption == before.routeOption)
                    .put("destinationPreserved", afterDestination?.let { it.latitude == destination.latitude && it.longitude == destination.longitude && it.poiId == destination.poiId } ?: false)
                runOnMainSync { observingTrip = false; result.put("routeChangeEvents", routeChanges) }
                if (response.kind != "trip" || !result.getBoolean("destinationPreserved")) break
            }
            report.put("exactCoordinatesMatch", results.length() == examples.size && (0 until results.length()).all {
                results.getJSONObject(it).optBoolean("requestedCoordinateReturned")
            })
            // This is a deliberately narrow diagnostic tolerance for these fixed examples,
            // not a rule that validates arbitrary pickup entrances or stopping safety.
            report.put("fixedExampleToleranceMetersExclusive", 10)
            report.put("tripPreviewVerified", results.length() == examples.size && (0 until results.length()).all { index ->
                val result = results.getJSONObject(index)
                val points = result.optJSONArray("returnedPointOffsets")
                val matchingPoint = points != null && (0 until points.length()).any { point ->
                    val value = points.getJSONObject(point)
                    value.optString("type") == "DESTINATION" && !value.optBoolean("zeroCoordinate") && value.optInt("offsetMeters", Int.MAX_VALUE) < 10
                }
                result.optBoolean("positiveDistanceAndTime") && matchingPoint &&
                    (!result.optBoolean("requestedWithPoi") || result.optBoolean("requestedPoiReturned")) &&
                    result.optBoolean("destinationPreserved") && result.optBoolean("guidanceModePreserved") &&
                    result.optBoolean("routeOptionPreserved") && result.optInt("routeChangeEvents", -1) == 0
            })
            report.put("completed", true)
        } catch (error: Exception) {
            report.put("completed", false).put("failure", error.message?.takeIf { it.matches(Regex("[A-Za-z_]+")) } ?: error.javaClass.simpleName)
        } finally {
            if (::helper.isInitialized) {
                runOnMainSync { observingTrip = false }
                if (createdBaseline && connected) {
                    val cleanupConfirmed = runCatching {
                        runOnMainSync { helper.cancelRoute() }
                        var state = queryState()
                        for (attempt in 1..10) {
                            if (!guiding(state)) break
                            SystemClock.sleep(500); state = queryState()
                        }
                        !guiding(state)
                    }.getOrDefault(false)
                    report.put("baselineCleanupConfirmed", cleanupConfirmed)
                }
                runOnMainSync { runCatching { helper.removeListener(listener); helper.release() } }
            }
            report.put("baselineCleanupRequested", createdBaseline && connected)
            finish(Activity.RESULT_OK, Bundle().apply { putString("stream", report.toString(2) + "\n") })
        }
    }
}
