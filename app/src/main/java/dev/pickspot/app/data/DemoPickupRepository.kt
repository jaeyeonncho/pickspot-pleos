package dev.pickspot.app.data

import dev.pickspot.app.domain.*

class DemoPickupRepository(private val now: () -> Long = System::currentTimeMillis) : PickupRepository {
    override suspend fun loadSession() = sampleSession(now())
    companion object {
        fun sampleSession(nowEpochMillis: Long = System.currentTimeMillis()) = PickupSession(
            "DEMO-001", "동승자", GeoPoint(37.4859, 127.0348), listOf(
                PickupCandidate("a", "만남 지점 A", GeoPoint(37.48544722, 127.03636666),
                    230, 120, CurbStatus.DESIGNATED, "도보와 우회를 함께 줄이는 시나리오", walkSeconds = 240),
                PickupCandidate("b", "만남 지점 B", GeoPoint(37.4866, 127.0342),
                    90, 300, CurbStatus.DESIGNATED, "동승자가 적게 걷는 시나리오", walkSeconds = 120),
                PickupCandidate("c", "만남 지점 C", GeoPoint(37.4845, 127.0335),
                    480, 45, CurbStatus.DESIGNATED, "운전자가 적게 우회하는 시나리오", walkSeconds = 420),
                PickupCandidate("d", "미확인 지점 D", GeoPoint(37.4851, 127.0350),
                    170, 240, CurbStatus.UNKNOWN, "정차 관련 정보가 부족한 후보", walkSeconds = 180),
                PickupCandidate("e", "제외 지점 E", GeoPoint(37.4860, 127.0350),
                    30, 15, CurbStatus.RESTRICTED, "제한 구간은 가까워도 제외")
            ), true, nowEpochMillis + 15 * 60_000
        )
    }
}

