package dev.pickspot.app.navigation

import android.content.Context
import android.os.Handler
import android.os.Looper
import ai.pleos.playground.navi.constants.NaviErrorCode
import ai.pleos.playground.navi.constants.RoutePointType
import ai.pleos.playground.navi.data.TripInfo
import ai.pleos.playground.navi.data.TripRequest
import ai.pleos.playground.navi.helper.NaviHelper
import ai.pleos.playground.navi.helper.listener.NaviHelperEventListener
import dev.pickspot.app.domain.*

/** No route-setting API, coordinate logging, persistence, or sharing-server dependency. */
class PleosTripPreview(context: Context) : TripPreviewGateway {
    private val appContext = context.applicationContext
    private val handler = Handler(Looper.getMainLooper())
    private var sdk: NaviHelper? = null
    private var listener: NaviHelperEventListener? = null
    private var connected = false
    private var closed = false
    private var locked = false
    private var allowed = false
    private var generation = 0
    private var pending: TripPreviewTarget? = null
    private var callback: ((TripPreviewOutcome) -> Unit)? = null
    private var deadline: Runnable? = null
    private var sent = false

    override fun setInteractionAllowed(allowed: Boolean) { this.allowed = allowed }
    override fun request(target: TripPreviewTarget, callback: (TripPreviewOutcome) -> Unit) {
        if (closed || locked) { callback(TripPreviewOutcome.Failure(TripPreviewIssue.UNAVAILABLE, true)); return }
        if (pending != null) { callback(TripPreviewOutcome.Failure(TripPreviewIssue.BUSY)); return }
        if (!allowed) { callback(TripPreviewOutcome.Failure(TripPreviewIssue.RESTRICTED)); return }
        pending = target; this.callback = callback; sent = false
        // One deadline covers connection and response, never extended by duplicate callbacks.
        deadline = Runnable { finish(TripPreviewOutcome.Failure(TripPreviewIssue.TIMEOUT, true)) }
            .also { handler.postDelayed(it, 30_000) }
        try { if (connected) send() else connect() }
        catch (_: Exception) { finish(TripPreviewOutcome.Failure(TripPreviewIssue.CONNECTION, true)) }
    }
    private fun connect() {
        val epoch = ++generation
        val helper = NaviHelper(appContext); sdk = helper
        val events = object : NaviHelperEventListener {
            override fun onTripInfo(tripInfo: TripInfo) = dispatch(epoch) {
                val target = pending ?: return@dispatch
                if (!sent) return@dispatch
                val outcome = runCatching {
                    TripPreviewPolicy.validate(target, tripInfo.distance, tripInfo.eta, tripInfo.summary.routePoints.map {
                        TripPreviewPoint(GeoPoint(it.latitude, it.longitude), it.pointType == RoutePointType.DESTINATION,
                            it.poiId)
                    })
                }.getOrElse { TripPreviewOutcome.Failure(TripPreviewIssue.INVALID_RESULT, true) }
                finish(outcome)
            }
            override fun onError(errorCode: NaviErrorCode) = dispatch(epoch) {
                // No request ID: an error may be followed by a late response. Do not reuse this session.
                if (pending != null) finish(TripPreviewOutcome.Failure(TripPreviewIssue.SERVICE, true))
            }
        }
        listener = events
        try {
            helper.initialize(onConnected = { dispatch(epoch) {
                if (pending != null) {
                    try { connected = true; helper.addListener(events); send() }
                    catch (_: Exception) { finish(TripPreviewOutcome.Failure(TripPreviewIssue.CONNECTION, true)) }
                }
            } }, onFailed = { dispatch(epoch) { finish(TripPreviewOutcome.Failure(TripPreviewIssue.CONNECTION, true)) } })
        } catch (_: Exception) { finish(TripPreviewOutcome.Failure(TripPreviewIssue.CONNECTION, true)) }
    }
    private fun send() {
        val target = pending ?: return
        if (sent) return
        if (!allowed) { finish(TripPreviewOutcome.Failure(TripPreviewIssue.RESTRICTED)); return }
        sent = true
        try {
            sdk!!.requestTrip(TripRequest(target.point.latitude, target.point.longitude, target.poi?.id.orEmpty(),
                target.poi?.name ?: target.name, target.poi?.subId))
        } catch (_: Exception) { finish(TripPreviewOutcome.Failure(TripPreviewIssue.SERVICE, true)) }
    }
    private fun finish(outcome: TripPreviewOutcome) {
        val notify = callback ?: return
        deadline?.let(handler::removeCallbacks); deadline = null
        pending = null; callback = null; sent = false
        if (outcome is TripPreviewOutcome.Failure && outcome.restartRequired) {
            locked = true; generation++; release()
        }
        notify(outcome)
    }
    private fun dispatch(epoch: Int, action: () -> Unit) {
        handler.post { if (!closed && epoch == generation) action() }
    }
    private fun release() {
        listener?.let { runCatching { sdk?.removeListener(it) } }
        runCatching { sdk?.release() }; listener = null; sdk = null; connected = false
    }
    override fun close() {
        closed = true; generation++; handler.removeCallbacksAndMessages(null)
        pending = null; callback = null; release()
    }
}
