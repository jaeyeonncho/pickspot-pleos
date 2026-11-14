package dev.pickspot.app.ui

import android.content.Context
import dev.pickspot.app.R
import dev.pickspot.app.domain.*
import dev.pickspot.app.presentation.*

/** Formatting belongs to the UI, so domain and vehicle integration have no display copy. */
class PickupText(private val context: Context) {
    fun session(state: PickupUiState): String = if (state.managing) context.getString(R.string.session_managing) else if (state.recovering) context.getString(R.string.session_recovering) else context.getString(when (state.sessionPhase) {
        SessionPhase.CALCULATING -> R.string.session_calculating
        SessionPhase.ROUTE_FAILED -> when (state.session?.routeCalculation?.issue) {
            RouteCalculationIssue.LIMIT -> R.string.route_failed_limit
            RouteCalculationIssue.CONFIGURATION -> R.string.route_failed_configuration
            RouteCalculationIssue.CONNECTION -> R.string.route_failed_connection
            else -> R.string.session_route_failed
        }
        SessionPhase.LOADING -> R.string.session_loading
        SessionPhase.READY -> if (state.session?.isDemo == true) R.string.session_demo_ready else R.string.session_ready
        SessionPhase.WAITING -> R.string.session_waiting
        SessionPhase.ENDED -> R.string.session_ended
        SessionPhase.EXPIRED -> R.string.session_expired
        SessionPhase.ERROR -> when (state.sessionIssue) {
            SessionIssue.RATE_LIMIT -> R.string.session_rate_limit
            SessionIssue.TIMEOUT -> R.string.session_timeout
            SessionIssue.CONFLICT -> R.string.session_conflict
            SessionIssue.INVALID_DATA -> R.string.session_invalid
            else -> R.string.session_error
        }
    })
    fun destinationName(value: String) = value.removePrefix("예제 목적지 · ")

    fun routeSummary(route: RouteCalculation): String {
        val status = when (route.phase) {
            RouteCalculationPhase.CALCULATING -> context.getString(R.string.route_calculating)
            RouteCalculationPhase.FAILED -> context.getString(when (route.issue) {
                RouteCalculationIssue.LIMIT -> R.string.route_failed_limit
                RouteCalculationIssue.CONFIGURATION -> R.string.route_failed_configuration
                RouteCalculationIssue.CONNECTION -> R.string.route_failed_connection
                else -> R.string.route_failed
            })
            RouteCalculationPhase.STALE -> context.getString(R.string.route_stale)
            RouteCalculationPhase.READY -> context.getString(R.string.route_calculated,
                route.completedAtEpochMillis?.let { android.text.format.DateFormat.format("HH:mm:ss", it) } ?: "—",
                route.validUntilEpochMillis?.let { android.text.format.DateFormat.format("HH:mm:ss", it) } ?: "—")
        }
        val source = context.getString(if (route.source == RouteSource.TMAP_EXAMPLE) R.string.route_source_tmap_example else R.string.route_source_fixture)
        return context.getString(R.string.route_summary, destinationName(route.destinationName), status, route.attemptsRemaining, source)
    }
    fun duration(seconds: Int): String = when {
        seconds < 60 -> context.getString(R.string.duration_seconds, seconds)
        seconds % 60 == 0 -> context.getString(R.string.duration_minutes, seconds / 60)
        else -> context.getString(R.string.duration_minutes_seconds, seconds / 60, seconds % 60)
    }
    fun curb(status: CurbStatus) = context.getString(when (status) {
        CurbStatus.DESIGNATED -> R.string.curb_designated_demo
        CurbStatus.UNKNOWN -> R.string.curb_unknown
        CurbStatus.RESTRICTED -> R.string.curb_restricted
    })
    fun navigation(state: NavigationState, confirmedName: String?): String {
        if (state.phase == NavigationPhase.CONFIRMED) {
            return context.getString(R.string.nav_confirmed, confirmedName.orEmpty())
        }
        return context.getString(when (state.phase) {
            NavigationPhase.DISCONNECTED -> R.string.nav_disconnected
            NavigationPhase.CONNECTING -> R.string.nav_connecting
            NavigationPhase.READING -> R.string.nav_reading
            NavigationPhase.READY -> if(state.waypointDispatchAvailable) R.string.nav_ready else R.string.nav_waypoint_unavailable
            NavigationPhase.REQUESTING -> R.string.nav_requesting
            NavigationPhase.ROUTING -> R.string.nav_routing
            NavigationPhase.VERIFYING -> R.string.nav_verifying
            NavigationPhase.CONFIRMED -> error("Handled above")
            NavigationPhase.FAILED -> when (state.issue) {
                NavigationIssue.NO_DESTINATION -> R.string.nav_no_destination
                NavigationIssue.ROUTE_CHANGED -> R.string.nav_route_changed
                NavigationIssue.ROUTE_CONTEXT_STALE -> R.string.nav_context_stale
                NavigationIssue.WAYPOINT_UNAVAILABLE -> R.string.nav_waypoint_unavailable
                NavigationIssue.WAYPOINT_LIMIT -> R.string.nav_waypoint_limit
                NavigationIssue.DUPLICATE_WAYPOINT -> R.string.nav_duplicate_waypoint
                NavigationIssue.INTERACTION_RESTRICTED -> R.string.driving_restricted
                NavigationIssue.CONNECTION -> R.string.nav_connection_failed
                NavigationIssue.TIMEOUT -> R.string.nav_timeout
                NavigationIssue.CANCELLED -> R.string.nav_cancelled
                NavigationIssue.TOO_CLOSE -> R.string.nav_too_close
                NavigationIssue.TOO_FAR -> R.string.nav_too_far
                NavigationIssue.INVALID_DESTINATION -> R.string.nav_invalid_destination
                NavigationIssue.DESTINATION_MISMATCH -> R.string.nav_destination_mismatch
                NavigationIssue.SEND_FAILED -> R.string.nav_send_failed
                else -> R.string.nav_search_failed
            }
        })
    }
}
