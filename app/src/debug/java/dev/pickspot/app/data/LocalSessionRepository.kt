package dev.pickspot.app.data

import dev.pickspot.app.domain.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.io.IOException
import kotlin.coroutines.coroutineContext

/** Debug only. adb reverse bridges this exact loopback port; no LAN or production host is accepted. */
enum class LocalSessionMode(val origin:String,val preferences:String) {
    STANDARD("http://127.0.0.1:8787","local_session"),
    COMPETITION("http://127.0.0.1:8788","competition_session")
}
class LocalSessionRepository(context: android.content.Context,private val mode:LocalSessionMode=LocalSessionMode.STANDARD) : PickupRepository {
    private val saved = context.applicationContext.getSharedPreferences(mode.preferences, android.content.Context.MODE_PRIVATE)
    override val pollingIntervalMillis = 3_000L
    override val sharesMeetingChoice get() = mode==LocalSessionMode.COMPETITION
    private var sessionId: String? = saved.getString("id", null)
    private var driverToken: String? = saved.getString("token", null)

    override suspend fun loadSession(): PickupSession {
        if (sessionId != null && (driverToken == null || saved.getLong("expiresAt", 0) <= System.currentTimeMillis())) {
            resetSession(); throw SessionClosedException(true)
        }
        if (sessionId != null && saved.getBoolean("ending", false)) {
            request("DELETE", "/v1/sessions/$sessionId")
            resetSession(); throw SessionClosedException(false)
        }
        if (sessionId == null) {
            val result = request("POST", "/v1/sessions", JSONObject())
            coroutineContext.ensureActive()
            driverToken = result.getString("driverToken")
            sessionId = result.getJSONObject("session").getString("id")
            saved.edit().putString("id", sessionId).putString("token", driverToken)
                .putLong("expiresAt", result.getJSONObject("session").getLong("expiresAt")).apply()
            return decode(result.getJSONObject("session"))
        }
        return decode(request("GET", "/v1/sessions/$sessionId"))
    }
    override suspend fun selectCandidate(session: PickupSession, candidate: PickupCandidate): PickupSession =
        decode(request("PUT", "/v1/sessions/${session.id}/selection", JSONObject()
            .put("candidateId", candidate.id).put("expectedVersion", session.version)))

    override suspend fun shareMeetingChoice(session:PickupSession,candidate:PickupCandidate):PickupSession {
        check(sharesMeetingChoice)
        return decode(request("PUT","/v1/sessions/${session.id}/meeting-choice",JSONObject()
            .put("candidateId",candidate.id).put("expectedVersion",session.version)))
    }

    override suspend fun reportNavigation(session: PickupSession, confirmed: Boolean) {
        val selectionId = session.selectionRequestId ?: return
        request("PUT", "/v1/sessions/${session.id}/navigation", JSONObject()
            .put("selectionId", selectionId).put("status", if (confirmed) "confirmed" else "failed"))
    }
    override suspend fun recalculateRoutes(session: PickupSession): PickupSession =
        decode(request("PUT", "/v1/sessions/${session.id}/route-refresh", JSONObject().put("expectedVersion", session.version)))
    override suspend fun changeDestination(session: PickupSession, destinationId: String): PickupSession =
        decode(request("PUT", "/v1/sessions/${session.id}/destination", JSONObject()
            .put("expectedVersion", session.version).put("destinationId", destinationId)))
    override suspend fun endSession(session: PickupSession) {
        saved.edit().putBoolean("ending", true).apply()
        request("DELETE", "/v1/sessions/${session.id}")
        resetSession()
    }
    override fun resetSession() { sessionId = null; driverToken = null; saved.edit().clear().apply() }

    private suspend fun request(method: String, path: String, body: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
        val connection = URL("${mode.origin}$path").openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = 5_000; connection.readTimeout = 5_000
            connection.instanceFollowRedirects = false
            driverToken?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
            connection.setRequestProperty("Accept", "application/json")
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val code = connection.responseCode
            coroutineContext.ensureActive()
            if (code == 429) throw SessionRateLimitException()
            if (code == 409) throw SessionConflictException()
            if (code in setOf(401,403,404,410)) {
                val error = connection.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
                resetSession()
                throw SessionClosedException(error.contains("SESSION_EXPIRED"))
            }
            if (code !in 200..299) throw IOException("Local session service unavailable")
            val content = connection.inputStream.bufferedReader().use { it.readText() }
            coroutineContext.ensureActive()
            JSONObject(content)
        } finally { connection.disconnect() }
    }
    private fun decode(json: JSONObject): PickupSession {
        val active = json.getString("status") == "active"
        val passenger = json.optJSONObject("passenger")
        val location = passenger?.optJSONObject("location")
        val rows = json.getJSONArray("candidates")
        val candidates = (0 until rows.length()).map { index ->
            val row = rows.getJSONObject(index); val point = row.getJSONObject("point")
            PickupCandidate(row.getString("id"), row.getString("name"),
                GeoPoint(point.getDouble("latitude"), point.getDouble("longitude")),
                row.getInt("walkMeters"), row.getInt("detourSeconds"),
                when (row.getString("curbStatus")) {
                    "designated" -> CurbStatus.DESIGNATED
                    "restricted" -> CurbStatus.RESTRICTED
                    else -> CurbStatus.UNKNOWN
                }, row.getString("note"), walkSeconds = if (row.isNull("walkSeconds")) null else row.getInt("walkSeconds"))
        }
        val selection = json.optJSONObject("selection")
        val route = json.optJSONObject("route")?.let {
            val source = RouteSource.fromWire(it.getString("source"), it.getBoolean("synthetic"),
                if (it.isNull("inputMode")) null else it.getString("inputMode"))
            RouteCalculation(when(it.getString("status")) {
                "calculating" -> RouteCalculationPhase.CALCULATING
                "ready" -> RouteCalculationPhase.READY
                "failed" -> RouteCalculationPhase.FAILED
                "stale" -> RouteCalculationPhase.STALE
                else -> throw IllegalArgumentException("Unknown calculation status")
            }, it.getString("destinationName"),
                if (it.isNull("completedAt")) null else it.getLong("completedAt"),
                if (it.isNull("validUntil")) null else it.getLong("validUntil"),
                it.getLong("retryAt"), it.getInt("attemptsRemaining"), source,
                RouteCalculationIssue.fromWire(if (it.isNull("issue")) null else it.getString("issue")))
        }
        return PickupSession(json.getString("id"), passenger?.optString("name") ?: "동승자",
            location?.let { GeoPoint(it.getDouble("latitude"), it.getDouble("longitude")) }, candidates,
            json.getBoolean("isDemo"), json.getLong("expiresAt"),
            if (active) SessionAvailability.ACTIVE else SessionAvailability.WAITING, json.getLong("version"),
            if (json.isNull("inviteCode")) null else json.getString("inviteCode"),
            selection?.getString("candidateId"), selection?.getString("id"), route, true,
            selection?.optString("navigationStatus") == "pending",
            json.optJSONObject("destination")?.optString("id"),
            json.optJSONArray("destinationOptions")?.let { options ->
                (0 until options.length()).map { index -> options.getJSONObject(index).let { DestinationOption(it.getString("id"), it.getString("name")) } }
            } ?: emptyList())
    }
}
