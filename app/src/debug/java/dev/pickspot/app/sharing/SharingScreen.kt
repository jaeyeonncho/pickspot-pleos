package dev.pickspot.app.sharing

import android.content.Context
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import dev.pickspot.app.R
import dev.pickspot.app.domain.*
import dev.pickspot.app.presentation.*

/** Display only; changing layout does not change polling or session lifetime. */
class SharingScreen(private val context: Context, private val root: View) {
    private var lastCandidates = emptyList<SharedExampleCandidate>()
    fun render(state: SharingUiState) {
        root.findViewById<View>(R.id.sharing_content).visibility = if (state.canInteract) View.VISIBLE else View.GONE
        root.findViewById<TextView>(R.id.sharing_driving_status).apply {
            visibility = if (state.canInteract) View.GONE else View.VISIBLE
            setText(if (state.drivingAccess == DrivingAccess.RESTRICTED) R.string.driving_restricted else R.string.driving_unknown)
        }
        val recommendation = state.session?.recommendation?.takeIf { state.phase == SharingPhase.CURRENT && state.canInteract }
        root.findViewById<View>(R.id.sharing_recommendation).visibility = if (recommendation != null) View.VISIBLE else View.GONE
        val candidates = recommendation?.candidates.orEmpty()
        if (candidates != lastCandidates) {
            lastCandidates = candidates.toList()
            root.findViewById<LinearLayout>(R.id.sharing_candidates).apply {
                removeAllViews()
                candidates.forEach { candidate ->
                    addView(TextView(context).apply {
                        setTextAppearance(R.style.Text_Body)
                        text = context.getString(R.string.sharing_candidate, candidate.id.uppercase(), candidate.walkMeters,
                            (candidate.walkSeconds.toLong()+59).div(60), (candidate.detourSeconds.toLong()+59).div(60))
                        setPadding(0,context.resources.getDimensionPixelSize(R.dimen.content_gap),0,0)
                    })
                }
            }
        }
        val title = when (state.phase) {
            SharingPhase.IDLE -> R.string.sharing_idle
            SharingPhase.CONNECTING -> R.string.sharing_connecting
            SharingPhase.OFFLINE -> R.string.sharing_offline
            SharingPhase.ENDING -> R.string.sharing_ending
            SharingPhase.ENDED -> R.string.sharing_ended
            SharingPhase.PAUSED -> R.string.sharing_paused
            SharingPhase.CURRENT -> when {
                state.session?.inviteCode != null -> R.string.sharing_join
                else -> when (state.session?.status) {
                    SharingStatus.READY -> R.string.sharing_ready
                    SharingStatus.WAITING -> R.string.sharing_waiting
                    SharingStatus.STALE -> R.string.sharing_stale
                    SharingStatus.WITHDRAWN -> R.string.sharing_withdrawn
                    SharingStatus.INVALID -> R.string.sharing_invalid
                    else -> R.string.sharing_consent
                }
            }
        }
        root.findViewById<TextView>(R.id.sharing_status).setIfChanged(context.getString(title))
        root.findViewById<TextView>(R.id.sharing_freshness).apply {
            // Reserve one line throughout the connection so refreshes do not move the actions.
            setIfChanged(state.checkedSecondsAgo?.let {
                context.getString(R.string.sharing_checked_ago, it)
            }.orEmpty())
        }
        root.findViewById<TextView>(R.id.sharing_code).apply {
            setIfChanged(state.session?.inviteCode?.let { context.getString(R.string.sharing_code, it.chunked(4).joinToString(" ")) }.orEmpty())
            visibility = if (text.isEmpty()) View.GONE else View.VISIBLE
        }
        root.findViewById<Button>(R.id.sharing_create).visibility = if (state.phase in setOf(SharingPhase.IDLE,SharingPhase.ENDED)) View.VISIBLE else View.GONE
        root.findViewById<Button>(R.id.sharing_retry).visibility = if (state.phase == SharingPhase.OFFLINE) View.VISIBLE else View.GONE
        root.findViewById<Button>(R.id.sharing_end).apply { visibility = if (state.canEnd) View.VISIBLE else View.GONE; isEnabled = state.phase != SharingPhase.ENDING }
    }
    private fun TextView.setIfChanged(value: String) { if (text.toString() != value) text = value }
}
