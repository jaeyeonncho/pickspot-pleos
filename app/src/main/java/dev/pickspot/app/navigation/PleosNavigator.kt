package dev.pickspot.app.navigation

import android.content.Context
import android.os.Handler
import android.os.Looper
import ai.pleos.playground.navi.constants.*
import ai.pleos.playground.navi.data.*
import ai.pleos.playground.navi.helper.NaviHelper
import ai.pleos.playground.navi.helper.listener.NaviHelperEventListener
import dev.pickspot.app.domain.*

/** Serial reads and writes; no coordinates in logs, disk, or backend requests. */
class PleosNavigator(context: Context, private val now: () -> Long = System::currentTimeMillis,
    diagnosticWaypointRequests: Boolean = false) : NavigationGateway {
    override var onState: ((NavigationState) -> Unit)? = null
    private val appContext = context.applicationContext
    // Current provider returns waypoint (0,0) for both SDK request methods.
    // Re-enable the app only after destination + all waypoint coordinates verify.
    // No intent, preference, or remote flag can bypass this in the shipped UI.
    private val waypointDispatchAvailable = diagnosticWaypointRequests && dev.pickspot.app.BuildConfig.DEBUG &&
        android.os.Build.HARDWARE in listOf("ranchu", "goldfish")
    private val handler = Handler(Looper.getMainLooper())
    private var helper: NaviHelper? = null
    private var listener: NaviHelperEventListener? = null
    private var connected = false
    private var closed = false
    private var allowed = false
    private var generation = 0
    private var mutation = 0
    private var readMutation = 0
    private var route: VehicleRoute? = null
    private var pending: PickupCandidate? = null
    private var expected: VehicleRoute? = null
    private var plan: WaypointPlan? = null
    private var started = false
    private var timeout: Runnable? = null
    private var cancellation: Runnable? = null
    private var verifyRetry: Runnable? = null
    private var mismatched = false
    private enum class Purpose { REFRESH, PREFLIGHT, VERIFY }
    private enum class Step { STATE, DESTINATION, WAYPOINTS }
    private var purpose: Purpose? = null
    private var step = Step.STATE
    private var readState: RouteStateInfo? = null
    private var readDestination: VehiclePlace? = null

    override fun setInteractionAllowed(allowed: Boolean) { this.allowed = allowed }
    override fun connect() {
        if (closed || pending != null) return
        generation++; val epoch = generation
        cleanup(); connected = false; route = null; purpose = null
        emit(NavigationPhase.CONNECTING)
        val sdk = NaviHelper(appContext); helper = sdk
        val events = object : NaviHelperEventListener {
            override fun onRouteStateInfo(routeStateInfo: RouteStateInfo) = dispatch(epoch) {
                if (purpose == null || step != Step.STATE) return@dispatch
                if (routeStateInfo.naviMode !in setOf(NaviMode.ROUTE_GUIDING, NaviMode.SIMULATION_GUIDING)) {
                    fail(NavigationIssue.NO_DESTINATION); return@dispatch
                }
                readState = routeStateInfo; step = Step.DESTINATION
                safely { sdk.getDestinationInfo() }
            }
            override fun onDestinationInfo(destinationInfo: DestinationInfo) = dispatch(epoch) {
                if (purpose == null || step != Step.DESTINATION) return@dispatch
                try {
                    readDestination = VehiclePlace(GeoPoint(destinationInfo.latitude, destinationInfo.longitude), destinationInfo.name,
                        destinationInfo.address, destinationInfo.poiId, destinationInfo.poiSubId.orEmpty(), destinationInfo.poiProvider)
                    step = Step.WAYPOINTS; sdk.getWaypointInfo()
                } catch (_: Exception) { fail(NavigationIssue.INVALID_DESTINATION) }
            }
            override fun onWayPointInfo(waypointInfoList: List<WaypointInfo>) = dispatch(epoch) {
                if (purpose == null || step != Step.WAYPOINTS) return@dispatch
                try {
                    val waypoints = waypointInfoList.map { VehiclePlace(GeoPoint(it.latitude, it.longitude), it.name,
                        it.address, it.poiId, it.poiSubId.orEmpty(), it.poiProvider) }
                    val snapshot = VehicleRoute(readDestination!!, waypoints, readState!!.routeOption.name, now())
                    completeRead(snapshot)
                } catch (_: Exception) { fail(NavigationIssue.INVALID_DESTINATION) }
            }
            override fun onDestinationChanged() = dispatch(epoch) { changed() }
            override fun onWaypointChanged(waypointChangedInfo: WaypointChangedInfo) = dispatch(epoch) { changed() }
            override fun onRouteOptionChanged(routeOption: RouteOption) = dispatch(epoch) { changed() }
            override fun onRouteStarted(routeStartInfo: RouteStartInfo) = dispatch(epoch) {
                if (plan != null) { started = true; clearCancellation(); emit(NavigationPhase.ROUTING) }
            }
            override fun onRoutingCompleted() = dispatch(epoch) { completed() }
            @Suppress("OVERRIDE_DEPRECATION")
            override fun onRouteEnded() = dispatch(epoch) { completed() }
            override fun onRouteCancelled() = dispatch(epoch) {
                if (plan != null && started) {
                    clearCancellation()
                    cancellation = Runnable { if (pending != null) fail(NavigationIssue.CANCELLED) }.also { handler.postDelayed(it, 500) }
                } else if (pending == null) changed()
            }
            override fun onError(errorCode: NaviErrorCode) = dispatch(epoch) {
                if (pending != null || purpose != null) fail(when(errorCode) {
                    NaviErrorCode.CAUSE_SEARCH_ROUTE_TOO_SHORT_DISTANCE -> NavigationIssue.TOO_CLOSE
                    NaviErrorCode.CAUSE_SEARCH_ROUTE_OVER_DISTANCE -> NavigationIssue.TOO_FAR
                    else -> NavigationIssue.ROUTE_SEARCH
                })
            }
        }
        listener = events
        deadline(20_000) { disconnectTimeout() }
        try {
            sdk.initialize(onConnected = { dispatch(epoch) {
                clearTimeout(); connected = true; sdk.addListener(events); refreshRoute()
            } }, onFailed = { dispatch(epoch) { disconnectTimeout() } })
        } catch (_: Exception) { disconnectTimeout() }
    }
    override fun refreshRoute() {
        if (!connected || closed || pending != null || purpose != null) return
        route = null; emit(NavigationPhase.READING)
        deadline(15_000) { disconnectTimeout() }; beginRead(Purpose.REFRESH)
    }
    override fun request(candidate: PickupCandidate, expectedRoute: VehicleRoute) {
        if (closed || pending != null) return
        if (!waypointDispatchAvailable) { fail(NavigationIssue.WAYPOINT_UNAVAILABLE); return }
        if (!connected || purpose != null) { fail(NavigationIssue.CONNECTION); return }
        if (!allowed) { fail(NavigationIssue.INTERACTION_RESTRICTED); return }
        pending = candidate; expected = expectedRoute; plan = null; started = false
        emit(NavigationPhase.REQUESTING)
        deadline(15_000) { disconnectTimeout() }; beginRead(Purpose.PREFLIGHT)
    }
    private fun beginRead(value: Purpose) {
        purpose = value; step = Step.STATE; readState = null; readDestination = null; readMutation = mutation
        safely { helper!!.getRouteStateInfo() }
    }
    private fun completeRead(snapshot: VehicleRoute) {
        val reason = purpose ?: return
        purpose = null
        if (readMutation != mutation) {
            if (reason == Purpose.VERIFY) beginRead(Purpose.VERIFY) else fail(NavigationIssue.ROUTE_CHANGED)
            return
        }
        when(reason) {
            Purpose.REFRESH -> {
                if (!snapshot.hasCoordinates) { fail(NavigationIssue.INVALID_DESTINATION); return }
                clearTimeout(); route = snapshot; emit(NavigationPhase.READY)
            }
            Purpose.PREFLIGHT -> {
                if (!allowed) { fail(NavigationIssue.INTERACTION_RESTRICTED); return }
                val candidate = pending ?: return
                val next = try { WaypointPlanner.plan(expected!!, snapshot, candidate, now()) }
                    catch (error: WaypointPlanningException) { fail(error.issue); return }
                plan = next; route = snapshot; started = false
                mismatched = false
                deadline(40_000) { disconnectTimeout(if(mismatched) NavigationIssue.DESTINATION_MISMATCH else NavigationIssue.TIMEOUT) }
                safely {
                    val d = next.original.destination
                    helper!!.requestRouteWithWaypoints(RouteWithWaypointsRequest(
                        RouteInfo(latitude=d.point.latitude, longitude=d.point.longitude, poiName=d.name, poiId=d.poiId,
                            poiSubId=d.poiSubId, address=d.address, poiProvider=d.poiProvider, routeOption=RouteOption.valueOf(next.original.routeOption)),
                        next.waypoints.mapIndexed { index, p -> RequestWaypointInfo(p.point.latitude, p.point.longitude, p.name,
                            if(index == 0) WaypointIndex.FIRST else WaypointIndex.SECOND, p.poiId, p.address, p.poiSubId, p.poiProvider) }
                    ))
                }
            }
            Purpose.VERIFY -> {
                if (plan?.matches(snapshot) != true) {
                    mismatched = true
                    verifyRetry?.let(handler::removeCallbacks)
                    verifyRetry = Runnable { if(plan != null && purpose == null) beginRead(Purpose.VERIFY) }.also { handler.postDelayed(it, 1000) }
                    return
                }
                val id = pending?.id; clearTimeout(); clearCancellation(); route = snapshot
                pending = null; expected = null; plan = null
                onState?.invoke(NavigationState(NavigationPhase.CONFIRMED, connected, confirmedId=id, route=snapshot, waypointDispatchAvailable=waypointDispatchAvailable))
            }
        }
    }
    private fun completed() {
        if (plan == null || purpose == Purpose.VERIFY) return
        clearCancellation(); emit(NavigationPhase.VERIFYING); beginRead(Purpose.VERIFY)
    }
    private fun changed() {
        mutation++
        if (pending == null) {
            route = null
            if (purpose == null) emit(NavigationPhase.READY, NavigationIssue.ROUTE_CHANGED)
        }
    }
    private fun safely(action: () -> Unit) { try { action() } catch (_: Exception) { fail(NavigationIssue.SEND_FAILED) } }
    private fun fail(issue: NavigationIssue) {
        clearTimeout(); clearCancellation(); pending = null; expected = null; plan = null; purpose = null; route = null
        emit(NavigationPhase.FAILED, issue)
    }
    private fun disconnectTimeout(issue: NavigationIssue = NavigationIssue.TIMEOUT) {
        generation++; cleanup(); connected = false
        fail(issue)
    }
    private fun emit(phase: NavigationPhase, issue: NavigationIssue? = null) {
        if (!closed) onState?.invoke(NavigationState(phase, connected, issue, route=route, waypointDispatchAvailable=waypointDispatchAvailable))
    }
    private fun dispatch(epoch: Int, action: () -> Unit) { handler.post { if (!closed && epoch == generation) action() } }
    private fun deadline(ms: Long, action: () -> Unit) { clearTimeout(); timeout = Runnable { if (!closed) action() }.also { handler.postDelayed(it,ms) } }
    private fun clearTimeout() { timeout?.let(handler::removeCallbacks); timeout = null; verifyRetry?.let(handler::removeCallbacks); verifyRetry = null }
    private fun clearCancellation() { cancellation?.let(handler::removeCallbacks); cancellation = null }
    private fun cleanup() { clearTimeout(); clearCancellation(); listener?.let { runCatching { helper?.removeListener(it) } }; runCatching { helper?.release() }; listener=null; helper=null }
    override fun close() { closed=true; generation++; cleanup(); handler.removeCallbacksAndMessages(null); onState=null }
}
