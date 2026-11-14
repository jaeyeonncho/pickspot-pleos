package dev.pickspot.app.sharing

import android.content.Context
import dev.pickspot.app.domain.*
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** Debug simulation only, fixed adb-reversed loopback endpoint. No location collection. */
class LocalSharingRepository private constructor(context: Context) : SharingRepository {
    companion object {
        private var instance: LocalSharingRepository? = null
        @Synchronized fun get(context: Context): LocalSharingRepository = instance ?: LocalSharingRepository(context).also { instance = it }
    }
    private val saved = context.applicationContext.getSharedPreferences("sharing_simulation", Context.MODE_PRIVATE)
    private val mutex = Mutex()
    override val hasSession get() = saved.contains("id")
    override val ending get() = saved.getBoolean("ending", false)
    override fun requestEnd() { check(saved.edit().putBoolean("ending", true).commit()) }
    private fun clear() { check(saved.edit().clear().commit()) }
    // Finish the bounded response and persist credentials even if the screen leaves mid-create.
    override suspend fun create(): SharingSnapshot = mutex.withLock {
        withContext(Dispatchers.IO + NonCancellable) {
            check(!hasSession)
            val health = request("GET", "/health")
            check(health.getString("service") == "pickspot-sharing" && health.getBoolean("simulation"))
            val created = request("POST", "/v1/sessions", JSONObject())
            val session = created.getJSONObject("session")
            val id = session.getString("id"); val token = created.getString("driverToken")
            check(Regex("[a-f0-9-]{36}").matches(id) && Regex("[A-Za-z0-9_-]{43}").matches(token))
            check(saved.edit().putString("id", id).putString("token", token).putLong("expiresAt",session.getLong("expiresAt")).putBoolean("ending", false).commit())
            decode(session)
        }
    }
    override suspend fun refresh(): SharingSnapshot? = mutex.withLock {
        withContext(Dispatchers.IO + NonCancellable) {
            val id = saved.getString("id", null) ?: return@withContext null
            if (saved.getLong("expiresAt",0) <= System.currentTimeMillis()) { clear(); throw SharingClosedException() }
            try {
                if (ending) { request("DELETE", "/v1/sessions/$id"); clear(); null }
                else decode(request("GET", "/v1/sessions/$id"))
            } catch (e: SharingClosedException) { clear(); throw e }
        }
    }
    private fun request(method: String, path: String, body: JSONObject? = null): JSONObject {
        val origin = "http://127.0.0.1:8790"
        val connection = URL(origin + path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method; connection.instanceFollowRedirects = false
            connection.connectTimeout = 4_000; connection.readTimeout = 4_000
            connection.setRequestProperty("Origin", origin)
            connection.setRequestProperty("Accept", "application/json")
            saved.getString("token",null)?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
            if (body != null) {
                connection.doOutput = true; connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            when (val code = connection.responseCode) {
                401,403,404,410 -> throw SharingClosedException()
                429 -> throw SharingRateLimitException()
                !in 200..299 -> throw IOException("Sharing service unavailable: $code")
            }
            val bytes = connection.inputStream.use { input ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(2048)
                while (true) {
                    val count = input.read(buffer, 0, minOf(buffer.size, 16_385 - output.size()))
                    if (count < 0) break
                    output.write(buffer,0,count)
                    if (output.size() >= 16_385) break
                }
                output.toByteArray()
            }
            check(bytes.size <= 16_384)
            return JSONObject(String(bytes, Charsets.UTF_8))
        } finally { connection.disconnect() }
    }
    private fun decode(json: JSONObject): SharingSnapshot {
        val share = json.getJSONObject("locationShare")
        val status = when (share.getString("status")) {
            "not-sharing" -> SharingStatus.NOT_SHARING
            "waiting" -> SharingStatus.WAITING
            "ready" -> SharingStatus.READY
            "stale" -> SharingStatus.STALE
            "withdrawn" -> SharingStatus.WITHDRAWN
            else -> SharingStatus.INVALID
        }
        val code = if (json.isNull("inviteCode")) null else json.getString("inviteCode").also { check(Regex("[A-F0-9]{12}").matches(it)) }
        val report = json.optJSONObject("sharedRecommendation")
        val recommendation = if (report?.optString("status") == "ready") {
            check(report.getString("source") == "synthetic-fixture" && report.getBoolean("synthetic") &&
                report.getString("inputMode") == "example" && report.getBoolean("referenceOnly"))
            val candidates = report.getJSONArray("candidates")
            check(candidates.length() in 1..3)
            fun metric(row: JSONObject, name: String): Int {
                val value = row.get(name)
                check(value is Number && value !is Double && value !is Float)
                return value.toLong().also { check(it in 0..Int.MAX_VALUE.toLong()) }.toInt()
            }
            SharedExampleRecommendation(report.getLong("validUntil"), (0 until candidates.length()).map { index ->
                val row = candidates.getJSONObject(index)
                check(row.getString("curbStatus") == "unknown")
                SharedExampleCandidate(row.getString("id"), metric(row,"walkMeters"), metric(row,"walkSeconds"), metric(row,"detourSeconds"))
            })
        } else null
        return SharingSnapshot(code, status, json.getLong("expiresAt"), if (share.isNull("validUntil")) null else share.getLong("validUntil"), recommendation)
    }
}
