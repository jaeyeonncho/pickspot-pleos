package dev.pickspot.app.domain

import org.junit.Assert.*
import org.junit.Test

class TripPreviewPolicyTest {
    private val target = TripPreviewTarget("s","a","A",GeoPoint(37.48544722,127.03636666))
    private val matching = TripPreviewPoint(target.point,true)
    @Test fun `matching destination returns provider metrics without ranking conversion`() {
        assertEquals(TripPreviewOutcome.Success(TripPreviewMetrics(12319,1045)), TripPreviewPolicy.validate(target,12319,1045,listOf(matching)))
    }
    @Test fun `origin or waypoint match cannot substitute for destination`() {
        for(points in listOf(emptyList(), listOf(matching.copy(isDestination=false)), listOf(matching,matching)))
            assertEquals(TripPreviewOutcome.Failure(TripPreviewIssue.MISMATCH,true),TripPreviewPolicy.validate(target,1,1,points))
    }
    @Test fun `coordinate mismatch zero sentinel and mismatched POI are rejected`() {
        for(point in listOf(GeoPoint(0.0,0.0),GeoPoint(37.486,127.036)))
            assertTrue(TripPreviewPolicy.validate(target,10,10,listOf(matching.copy(point=point))) is TripPreviewOutcome.Failure)
        val withPoi=target.copy(poi=PoiReference("expected","0","A",""))
        assertTrue(TripPreviewPolicy.validate(withPoi,10,10,listOf(matching.copy(poiId="other"))) is TripPreviewOutcome.Failure)
        assertTrue(TripPreviewPolicy.validate(withPoi,10,10,listOf(matching.copy(poiId="expected"))) is TripPreviewOutcome.Success)
    }
    @Test fun `small SDK offsets match while nonpositive metrics fail closed`() {
        assertTrue(TripPreviewPolicy.validate(target,10,10,listOf(matching.copy(point=GeoPoint(37.48545,127.03637)))) is TripPreviewOutcome.Success)
        for(pair in listOf(0 to 10,10 to 0,-1 to 1,1 to -1))
            assertEquals(TripPreviewOutcome.Failure(TripPreviewIssue.INVALID_RESULT,true), TripPreviewPolicy.validate(target,pair.first,pair.second,listOf(matching)))
    }
}
