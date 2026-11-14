package dev.pickspot.app.ui

import android.app.AlertDialog
import android.content.Context
import android.view.LayoutInflater
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import dev.pickspot.app.R
import dev.pickspot.app.domain.PickupPreference
import dev.pickspot.app.presentation.PickupAction
import dev.pickspot.app.presentation.PickupUiState
import dev.pickspot.app.presentation.SessionPhase

/** Rendering and user gestures only. Replace this screen without changing ViewModel or SDK adapter. */
class PickupScreen(
    private val context: Context,
    private val dispatch: (PickupAction) -> Unit,
    private val competitionDemo: Boolean = false
) {
    private val inflater = LayoutInflater.from(context)
    val view: View = inflater.inflate(R.layout.screen_pickup, null)
    private val dashboard = view.findViewById<View>(R.id.dashboard_workspace) != null
    private var settingsOpen = false
    private val formatter = PickupText(context)
    private val cards = view.findViewById<LinearLayout>(R.id.candidate_list)
    private val detail = view.findViewById<View>(R.id.selected_detail)
    private val sketch = view.findViewById<MeetingSketchView>(R.id.sketch)
    private val navigate = view.findViewById<Button>(R.id.navigate)
    private val reconnect = view.findViewById<Button>(R.id.reconnect)
    private val preferences = mapOf(
        R.id.balanced to PickupPreference.BALANCED,
        R.id.less_walk to PickupPreference.LESS_WALK,
        R.id.less_detour to PickupPreference.LESS_DETOUR
    )
    private var dialog: AlertDialog? = null
    private var dialogCandidateId: String? = null
    private var rendered: PickupUiState? = null

    init {
        if (!dashboard) {
        val wide = context.resources.getBoolean(R.bool.wide_layout)
        val gap = context.resources.getDimensionPixelSize(R.dimen.section_gap)
        view.findViewById<LinearLayout>(R.id.body).orientation = if (wide) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
        view.findViewById<View>(R.id.candidates_panel).layoutParams = LinearLayout.LayoutParams(
            if (wide) 0 else -1, -2, if (wide) 1.15f else 0f)
        view.findViewById<View>(R.id.details_panel).layoutParams = LinearLayout.LayoutParams(
            if (wide) 0 else -1, -2, if (wide) 1f else 0f).apply {
                marginStart = if (wide) gap else 0
                topMargin = if (wide) 0 else gap
            }
        }
        view.findViewById<Button>(R.id.dashboard_recalculate)?.setOnClickListener {
            dispatch(when (rendered?.sessionPhase) {
                SessionPhase.ENDED, SessionPhase.EXPIRED -> PickupAction.NewSession
                SessionPhase.ROUTE_FAILED -> PickupAction.RecalculateRoutes
                else -> PickupAction.ReloadSession
            })
        }
        view.findViewById<Button>(R.id.dashboard_settings_toggle)?.setOnClickListener {
            settingsOpen = !settingsOpen
            rendered?.let(::renderDashboard)
        }
        view.findViewById<Button>(R.id.confirm_meeting_point).setOnClickListener {
            dispatch(PickupAction.ConfirmMeetingPoint)
        }
        preferences.forEach { (id, value) -> view.findViewById<Button>(id).setOnClickListener {
            dispatch(PickupAction.ChangePreference(value))
        } }
        view.findViewById<Button>(R.id.reload_session).setOnClickListener {
            dispatch(if (rendered?.sessionPhase in setOf(SessionPhase.ENDED, SessionPhase.EXPIRED)) PickupAction.NewSession else PickupAction.ReloadSession)
        }
        view.findViewById<Button>(R.id.retry_share).setOnClickListener { dispatch(PickupAction.RetryShare) }
        view.findViewById<Button>(R.id.recalculate_routes).setOnClickListener { dispatch(PickupAction.RecalculateRoutes) }
        view.findViewById<Button>(R.id.end_session).setOnClickListener { dispatch(PickupAction.OpenEndConfirmation) }
        view.findViewById<Button>(R.id.change_destination).setOnClickListener {
            val state = rendered ?: return@setOnClickListener
            if (!state.canChangeDestination) return@setOnClickListener
            val choices = state.session?.destinationOptions ?: return@setOnClickListener
            dismissDialog(); dialogCandidateId = "__destination__"
            dialog = AlertDialog.Builder(context).setTitle(R.string.choose_destination)
                .setItems(choices.map { formatter.destinationName(it.name) }.toTypedArray()) { _, index ->
                    dispatch(PickupAction.ChangeDestination(choices[index].id))
                }.setNegativeButton(R.string.back, null).create().also { it.show() }
        }
        navigate.isSelected = true
        navigate.setOnClickListener { dispatch(PickupAction.OpenConfirmation) }
        reconnect.setOnClickListener { dispatch(PickupAction.Reconnect) }
        view.findViewById<Button>(R.id.refresh_vehicle_route).setOnClickListener { dispatch(PickupAction.RefreshVehicleRoute) }
    }

    fun render(state: PickupUiState) {
        val previous = rendered
        rendered = state
        view.findViewById<View>(R.id.interactive_content).visibility = if (state.canInteract) View.VISIBLE else View.GONE
        view.findViewById<TextView>(R.id.driving_status).apply {
            visibility = if (state.canInteract) View.GONE else View.VISIBLE
            setText(if (state.drivingAccess == dev.pickspot.app.domain.DrivingAccess.RESTRICTED)
                R.string.driving_restricted else R.string.driving_unknown)
        }
        if (!state.canInteract) dismissDialog()
        view.findViewById<View>(R.id.body).visibility = if (state.sessionPhase == SessionPhase.READY && (!state.managing || state.recommendations.isNotEmpty())) View.VISIBLE else View.GONE
        view.findViewById<View>(R.id.loading_progress).visibility = if (state.sessionPhase in setOf(SessionPhase.LOADING,SessionPhase.CALCULATING) || state.managing) View.VISIBLE else View.GONE
        view.findViewById<TextView>(R.id.session_status).text = if (competitionDemo &&
            state.sessionPhase == SessionPhase.READY && !state.managing && !state.recovering)
            context.getString(if (state.confirmedMeeting?.id == state.selectedId && state.confirmedMeeting != null)
                R.string.meeting_confirmed_note else R.string.competition_ready) else formatter.session(state)
        view.findViewById<Button>(R.id.reload_session).apply {
            isEnabled = state.canReload
            text = context.getString(when (state.sessionPhase) {
                SessionPhase.ENDED, SessionPhase.EXPIRED -> R.string.new_session
                SessionPhase.READY, SessionPhase.WAITING -> R.string.refresh_session
                else -> R.string.retry_session
            })
            visibility = if (state.sessionPhase == SessionPhase.LOADING) View.GONE else View.VISIBLE
        }
        view.findViewById<TextView>(R.id.invitation).apply {
            val code = state.session?.inviteCode
            visibility = if (state.sessionPhase == SessionPhase.WAITING) View.VISIBLE else View.GONE
            text = if (code == null) context.getString(R.string.passenger_joined) else context.getString(R.string.invitation_code, code.chunked(4).joinToString(" "))
        }
        view.findViewById<View>(R.id.share_status).visibility = if (state.shareFailed) View.VISIBLE else View.GONE
        view.findViewById<Button>(R.id.retry_share).apply { visibility = if (state.shareFailed) View.VISIBLE else View.GONE; isEnabled = !state.navigation.busy }
        view.findViewById<Button>(R.id.change_destination).apply {
            visibility = if (state.session?.destinationOptions?.isNotEmpty() == true) View.VISIBLE else View.GONE
            isEnabled = state.canChangeDestination
            val destination = state.session?.destinationOptions?.firstOrNull { it.id == state.session.destinationId }
            text = destination?.let { context.getString(R.string.destination_current, formatter.destinationName(it.name)) } ?: context.getString(R.string.change_destination)
        }
        val route = state.session?.routeCalculation
        view.findViewById<TextView>(R.id.route_summary).apply {
            visibility = if (route != null) View.VISIBLE else View.GONE
            text = route?.let(formatter::routeSummary).orEmpty()
        }
        view.findViewById<View>(R.id.session_management).visibility = if (state.session?.canEndRemotely == true) View.VISIBLE else View.GONE
        view.findViewById<Button>(R.id.end_session).isEnabled = state.canEnd
        view.findViewById<Button>(R.id.recalculate_routes).apply {
            visibility = if (route != null) View.VISIBLE else View.GONE
            isEnabled = state.canRecalculate
            text = context.getString(when {
                route?.attemptsRemaining == 0 -> R.string.route_limit
                route != null && state.checkedAtEpochMillis < route.retryAtEpochMillis -> R.string.route_cooldown
                else -> R.string.recalculate_routes
            })
        }
        preferences.forEach { (id, value) -> view.findViewById<Button>(id).apply {
            isSelected = value == state.preference
            isEnabled = state.canSelect
        } }
        if (previous?.recommendations != state.recommendations || previous.selectedId != state.selectedId || previous.session != state.session) {
            renderCandidates(state)
            renderDetail(state)
        }
        for (i in 0 until cards.childCount) cards.getChildAt(i).isEnabled = state.canSelect
        val confirmed = state.session?.candidates?.firstOrNull { it.id == state.navigation.confirmedId }
        view.findViewById<TextView>(R.id.navigation_status).apply {
            this.text = formatter.navigation(state.navigation, confirmed?.name)
            setTextColor(context.getColor(if (confirmed != null && confirmed.id == state.selectedId) R.color.accent else R.color.muted))
        }
        navigate.isEnabled = state.canRequest
        val vehicleRoute = state.navigation.route?.takeIf { it.isFresh(state.checkedAtEpochMillis) }
        view.findViewById<TextView>(R.id.vehicle_route_summary).text = if(competitionDemo && vehicleRoute == null)
            context.getString(R.string.competition_route_optional) else if(vehicleRoute == null)
            context.getString(R.string.vehicle_route_missing) else
            context.getString(R.string.vehicle_route_summary, vehicleRoute.destination.name, vehicleRoute.waypoints.size)
        view.findViewById<TextView>(R.id.vehicle_input_status).setText(if(competitionDemo)
            R.string.competition_input_note else if(state.vehicleTripInput != null)
            R.string.vehicle_input_ready else R.string.vehicle_input_waiting)
        view.findViewById<Button>(R.id.refresh_vehicle_route).isEnabled = state.canInteract && !state.navigation.busy && !state.managing && state.confirmation == null
        navigate.alpha = if (state.canRequest) 1f else 0.45f
        navigate.text = when {
            state.navigation.busy -> context.getString(R.string.route_wait)
            !state.navigation.waypointDispatchAvailable -> context.getString(R.string.route_unavailable)
            state.selected != null -> context.getString(R.string.route_to, state.selected!!.name)
            else -> context.getString(R.string.route_select_first)
        }
        reconnect.visibility = if (!state.navigation.connected && !state.navigation.busy) View.VISIBLE else View.GONE
        renderMeetingConfirmation(state)
        renderDashboard(state)
        renderConfirmation(state)
    }

    private fun renderMeetingConfirmation(state: PickupUiState) {
        val confirmed = state.confirmedMeeting
        val selectedIsConfirmed = confirmed != null && confirmed.id == state.selectedId
        view.findViewById<View>(R.id.meeting_confirmation).visibility =
            if (state.meetingChoiceAvailable && state.sessionPhase == SessionPhase.READY && state.selected != null) View.VISIBLE else View.GONE
        view.findViewById<Button>(R.id.confirm_meeting_point).apply {
            isEnabled = state.canConfirmMeeting
            isSelected = true
            alpha = if (isEnabled || selectedIsConfirmed || state.confirmingMeeting) 1f else 0.45f
            setText(when {
                state.confirmingMeeting -> R.string.meeting_confirming
                selectedIsConfirmed -> R.string.meeting_confirmed
                confirmed != null -> R.string.confirm_meeting_change
                else -> R.string.confirm_meeting_point
            })
        }
        view.findViewById<TextView>(R.id.meeting_confirmation_status).text = when {
            state.confirmingMeeting -> context.getString(R.string.meeting_confirming_status)
            selectedIsConfirmed -> context.getString(R.string.meeting_confirmed_status, confirmed!!.name)
            confirmed != null -> context.getString(R.string.meeting_previous_status, confirmed.name)
            else -> context.getString(R.string.meeting_confirm_hint)
        }
    }

    private fun renderDashboard(state: PickupUiState) {
        if (!dashboard) return
        if (!state.canInteract) settingsOpen = false
        view.findViewById<TextView>(R.id.dashboard_empty_note).text = if (state.sessionPhase == SessionPhase.WAITING)
            context.getString(R.string.dashboard_waiting_note) else formatter.session(state)
        view.findViewById<Button>(R.id.dashboard_recalculate).apply {
            val phase = state.sessionPhase
            visibility = if (phase in setOf(SessionPhase.ROUTE_FAILED, SessionPhase.ENDED, SessionPhase.EXPIRED, SessionPhase.ERROR)) View.VISIBLE else View.GONE
            isEnabled = if (phase == SessionPhase.ROUTE_FAILED) state.canRecalculate else state.canReload
            setText(when (phase) {
                SessionPhase.ENDED, SessionPhase.EXPIRED -> R.string.new_session
                SessionPhase.ROUTE_FAILED -> when {
                    state.session?.routeCalculation?.attemptsRemaining == 0 -> R.string.route_limit
                    state.session?.routeCalculation?.let { state.checkedAtEpochMillis < it.retryAtEpochMillis } == true -> R.string.route_cooldown
                    else -> R.string.recalculate_routes
                }
                else -> R.string.retry_session
            })
        }
        val ready = state.sessionPhase == SessionPhase.READY && (!state.managing || state.recommendations.isNotEmpty())
        view.findViewById<View>(R.id.body).visibility = if (ready && !settingsOpen) View.VISIBLE else View.GONE
        view.findViewById<View>(R.id.dashboard_waiting).visibility = if (!ready && !settingsOpen) View.VISIBLE else View.GONE
        view.findViewById<View>(R.id.dashboard_settings).visibility = if (settingsOpen) View.VISIBLE else View.GONE
        view.findViewById<Button>(R.id.dashboard_settings_toggle).apply {
            setText(if (settingsOpen) R.string.dashboard_settings_close else R.string.dashboard_settings_open)
            isSelected = settingsOpen
            isEnabled = state.canInteract
        }
    }

    private fun renderCandidates(state: PickupUiState) {
        view.findViewById<TextView>(R.id.candidates_title).text = context.getString(R.string.candidates_title, state.recommendations.size)
        view.findViewById<TextView>(R.id.ranking_note).text = if (state.excludedCount == 0) context.getString(R.string.ranking_note_no_exclusions) else context.getString(R.string.ranking_note, state.excludedCount)
        view.findViewById<View>(R.id.empty_candidates).visibility = if (state.recommendations.isEmpty()) View.VISIBLE else View.GONE
        cards.removeAllViews()
        state.recommendations.forEachIndexed { index, ranked ->
            val candidate = ranked.candidate
            val card = inflater.inflate(R.layout.item_candidate, cards, false)
            card.isSelected = candidate.id == state.selectedId
            card.findViewById<TextView>(R.id.card_title).text = context.getString(R.string.card_title, index + 1, candidate.name)
            val badge = context.getString(when {
                state.confirmedMeeting?.id == candidate.id -> R.string.meeting_confirmed_badge
                card.isSelected -> if (state.meetingChoiceAvailable) R.string.meeting_preview_badge else R.string.selected
                index == 0 -> R.string.recommended
                else -> R.string.select
            })
            card.findViewById<TextView>(R.id.card_badge).text = badge
            val metrics = context.getString(R.string.card_metrics, candidate.walkMeters, formatter.duration(candidate.detourSeconds))
            card.findViewById<TextView>(R.id.card_metrics).text = metrics
            card.findViewById<TextView>(R.id.card_curb).text = formatter.curb(candidate.curbStatus)
            card.contentDescription = "${index + 1}, ${candidate.name}, $metrics, ${formatter.curb(candidate.curbStatus)}, $badge"
            card.setOnClickListener { dispatch(PickupAction.SelectCandidate(candidate.id)) }
            cards.addView(card)
        }
    }

    private fun renderDetail(state: PickupUiState) {
        val candidate = state.selected
        detail.visibility = if (candidate != null) View.VISIBLE else View.GONE
        val session = state.session
        if (candidate == null || session == null) { sketch.clear(); return }
        val confirmed = state.confirmedMeeting?.id == candidate.id
        view.findViewById<TextView>(R.id.selected_heading).setText(if (!state.meetingChoiceAvailable) R.string.selected_heading
            else if (confirmed) R.string.meeting_confirmed_heading else R.string.meeting_preview_heading)
        view.findViewById<TextView>(R.id.selected_name).text = candidate.name
        view.findViewById<TextView>(R.id.selected_note).text = if (confirmed) context.getString(R.string.meeting_confirmed_note) else if (session.isDemo) context.getString(R.string.meeting_point_note) else candidate.note
        view.findViewById<TextView>(R.id.detail_metrics).text = context.getString(R.string.detail_metrics,
            candidate.walkSeconds?.let(formatter::duration) ?: context.getString(R.string.time_unknown), formatter.duration(candidate.detourSeconds))
        view.findViewById<View>(R.id.detail_demo_note).visibility = if (session.isDemo) View.VISIBLE else View.GONE
        sketch.bind(session, candidate)
    }

    private fun renderConfirmation(state: PickupUiState) {
        if (!state.canInteract) { dismissDialog(); return }
        if (dialogCandidateId == "__destination__" && state.canChangeDestination && dialog?.isShowing == true) return
        if (state.endConfirmation) {
            if (dialogCandidateId == "__end__" && dialog?.isShowing == true) return
            dismissDialog(); dialogCandidateId = "__end__"
            dialog = AlertDialog.Builder(context).setTitle(R.string.confirm_end_title).setMessage(R.string.confirm_end_message)
                .setNegativeButton(R.string.back) { _, _ -> dispatch(PickupAction.DismissEndConfirmation) }
                .setPositiveButton(R.string.end_session) { _, _ -> dispatch(PickupAction.ConfirmEnd) }
                .setOnCancelListener { dispatch(PickupAction.DismissEndConfirmation) }
                .create().also { it.show() }
            return
        }
        val target = state.confirmation
        if (target == null) { dismissDialog(); return }
        if (dialogCandidateId == target.id && dialog?.isShowing == true) return
        dismissDialog()
        dialogCandidateId = target.id
        dialog = AlertDialog.Builder(context)
            .setTitle(context.getString(R.string.confirm_title, target.name))
            .setMessage(context.getString(R.string.confirm_message, state.confirmationRoute?.destination?.name.orEmpty(),
                state.confirmationRoute?.waypoints?.size ?: 0))
            .setNegativeButton(R.string.back) { _, _ -> dispatch(PickupAction.DismissConfirmation) }
            .setPositiveButton(R.string.send_route) { _, _ -> dispatch(PickupAction.ConfirmRoute) }
            .setOnCancelListener { dispatch(PickupAction.DismissConfirmation) }
            .create().also { it.show() }
    }

    // A destroyed screen dismisses its window, not the ViewModel confirmation or in-flight request.
    private fun dismissDialog() { dialog?.setOnCancelListener(null); dialog?.dismiss(); dialog = null; dialogCandidateId = null }
    fun dispose() { dismissDialog() }
}
