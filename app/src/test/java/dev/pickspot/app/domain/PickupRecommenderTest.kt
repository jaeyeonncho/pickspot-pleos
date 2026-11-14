package dev.pickspot.app.domain

import dev.pickspot.app.data.DemoPickupRepository
import dev.pickspot.app.navigation.RouteConfirmation
import org.junit.Assert.*
import org.junit.Test

class PickupRecommenderTest {
    private val recommender = PickupRecommender()
    private val candidates = DemoPickupRepository.sampleSession().candidates
    @Test fun `preference changes the recommended meeting point`() {
        assertEquals("a", recommender.rank(candidates, PickupPreference.BALANCED).first().candidate.id)
        assertEquals("b", recommender.rank(candidates, PickupPreference.LESS_WALK).first().candidate.id)
        assertEquals("c", recommender.rank(candidates, PickupPreference.LESS_DETOUR).first().candidate.id)
    }
    @Test fun `nearby restricted point is excluded in every preference`() {
        PickupPreference.entries.forEach {
            val result = recommender.rank(candidates, it)
            assertEquals(3, result.size)
            assertFalse(result.any { it.candidate.id == "e" })
        }
    }
    @Test fun `unknown curb conditions are penalized rather than called safe`() {
        val known = candidates[0].copy(id = "known")
        val unknown = known.copy(id = "unknown", curbStatus = CurbStatus.UNKNOWN)
        assertEquals("known", recommender.rank(listOf(unknown, known), PickupPreference.BALANCED).first().candidate.id)
    }
    @Test fun `empty and small candidate sets never get invented fillers`() {
        assertTrue(recommender.rank(emptyList(), PickupPreference.BALANCED).isEmpty())
        assertEquals(1, recommender.rank(candidates.take(1), PickupPreference.BALANCED).size)
    }
    @Test fun `order is stable regardless of source ordering`() {
        assertEquals(recommender.rank(candidates, PickupPreference.BALANCED), recommender.rank(candidates.reversed(), PickupPreference.BALANCED))
    }
    @Test(expected = IllegalArgumentException::class) fun `invalid coordinates rejected`() { GeoPoint(Double.NaN, 127.0) }
    @Test(expected = IllegalArgumentException::class) fun `invalid travel input rejected`() { candidates[0].copy(detourSeconds = -1) }
    @Test fun `request or unrelated completion alone cannot confirm a route`() {
        val state = RouteConfirmation(candidates[0].point)
        assertFalse(state.confirmed)
        state.routingCompleted()
        assertFalse(state.confirmed)
        state.destinationReceived(candidates[1].point)
        assertFalse(state.confirmed)
        state.destinationReceived(candidates[0].point)
        assertTrue(state.confirmed)
    }
    @Test fun `destination callback can arrive before completion`() {
        val state = RouteConfirmation(candidates[0].point)
        state.destinationReceived(candidates[0].point)
        assertFalse(state.confirmed)
        state.routingCompleted()
        assertTrue(state.confirmed)
    }
    @Test fun `mismatch is distinct from missing response and can recover before deadline`() {
        val state = RouteConfirmation(candidates[0].point)
        state.routingCompleted()
        assertFalse(state.mismatched)
        state.destinationReceived(candidates[1].point)
        assertTrue(state.mismatched)
        assertFalse(state.confirmed)
        state.destinationReceived(candidates[0].point)
        assertFalse(state.mismatched)
        assertTrue(state.confirmed)
    }
    @Test fun `replacement cancellation before start cannot terminate the new request`() {
        val state = RouteConfirmation(candidates[0].point)
        assertFalse(state.hasStarted)
        state.destinationReceived(GeoPoint(0.0, 0.0)) // previous route was removed
        state.routingStarted()
        assertTrue(state.hasStarted)
        state.routingCompleted()
        assertFalse(state.confirmed)
        state.destinationReceived(candidates[0].point)
        assertTrue(state.confirmed)
    }
}
