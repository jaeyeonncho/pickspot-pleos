package dev.pickspot.app.domain

/** Status only. Raw passenger positions never cross this contract. */
enum class SharingStatus { NOT_SHARING, WAITING, READY, STALE, WITHDRAWN, INVALID }
data class SharedExampleCandidate(val id: String, val walkMeters: Int, val walkSeconds: Int, val detourSeconds: Int) {
    init { require(id in listOf("a", "b", "c") && walkMeters >= 0 && walkSeconds >= 0 && detourSeconds >= 0) }
}
data class SharedExampleRecommendation(val validUntil: Long, val candidates: List<SharedExampleCandidate>) {
    init { require(validUntil > 0 && candidates.size in 1..3 && candidates.map { it.id }.distinct().size == candidates.size) }
}
data class SharingSnapshot(val inviteCode: String?, val status: SharingStatus, val expiresAt: Long, val validUntil: Long?,
    val recommendation: SharedExampleRecommendation? = null) {
    fun displayableAt(now: Long): SharingSnapshot {
        val fresh = status == SharingStatus.READY && validUntil != null && validUntil > now && expiresAt > now
        return copy(status = if (status == SharingStatus.READY && !fresh) SharingStatus.STALE else status,
            recommendation = recommendation?.takeIf { fresh && it.validUntil > now })
    }
}
interface SharingRepository {
    val hasSession: Boolean
    val ending: Boolean
    suspend fun create(): SharingSnapshot
    suspend fun refresh(): SharingSnapshot?
    fun requestEnd()
}
class SharingClosedException : Exception()
class SharingRateLimitException : Exception()
