package dev.pickspot.app.domain

import dev.pickspot.app.data.DemoPickupRepository
import org.junit.Assert.*
import org.junit.Test

class WaypointPlannerTest {
    private val now = 1_800_000_000_000L
    private val destination = VehiclePlace(GeoPoint(37.52,127.06), "원래 목적지", poiId="destination")
    private val existing = VehiclePlace(GeoPoint(37.50,127.05), "기존 경유지", poiId="old")
    private val candidate = DemoPickupRepository.sampleSession(now).candidates.first()
    private fun route(points: List<VehiclePlace> = emptyList()) = VehicleRoute(destination, points, "FREE", now)
    private fun rejects(issue: NavigationIssue, action: () -> Unit) {
        try { action(); fail("Expected $issue") } catch (error: WaypointPlanningException) { assertEquals(issue,error.issue) }
    }
    @Test fun `pickup is inserted first and original destination order and option are retained`() {
        val original=route(listOf(existing)); val plan=WaypointPlanner.plan(original,original,candidate,now)
        assertEquals(original,plan.original);assertEquals(candidate.point,plan.waypoints[0].point)
        assertEquals(existing,plan.waypoints[1]);assertEquals("FREE",plan.original.routeOption)
        assertTrue(plan.matches(original.copy(waypoints=plan.waypoints)))
    }
    @Test fun `full waypoint list is never truncated`() {
        val original=route(listOf(existing,existing.copy(name="둘째",point=GeoPoint(37.51,127.055))))
        rejects(NavigationIssue.WAYPOINT_LIMIT){WaypointPlanner.plan(original,original,candidate,now)}
    }
    @Test fun `changed destination waypoint order or route option prevents sending`() {
        val original=route(listOf(existing))
        for(changed in listOf(original.copy(destination=existing),original.copy(waypoints=emptyList()),original.copy(routeOption="RECOMMENDED")))
            rejects(NavigationIssue.ROUTE_CHANGED){WaypointPlanner.plan(original,changed,candidate,now)}
    }
    @Test fun `stale future or restricted inputs cannot dispatch a waypoint`() {
        val original=route()
        for(at in listOf(now+30000,now-1))rejects(NavigationIssue.ROUTE_CONTEXT_STALE){WaypointPlanner.plan(original,original,candidate,at)}
        rejects(NavigationIssue.INVALID_DESTINATION){WaypointPlanner.plan(original,original,candidate.copy(curbStatus=CurbStatus.RESTRICTED),now)}
    }
    @Test fun `a pickup already near a route stop is not duplicated`() {
        val original=route(listOf(existing.copy(point=candidate.point)))
        rejects(NavigationIssue.DUPLICATE_WAYPOINT){WaypointPlanner.plan(original,original,candidate,now)}
    }
    @Test fun `verification requires original destination and all waypoints in order`() {
        val original=route(listOf(existing));val plan=WaypointPlanner.plan(original,original,candidate,now)
        for(actual in listOf(original,original.copy(destination=plan.pickup,waypoints=plan.waypoints),
            original.copy(waypoints=plan.waypoints.reversed()),original.copy(waypoints=listOf(plan.pickup)),
            original.copy(waypoints=plan.waypoints,routeOption="RECOMMENDED")))assertFalse(plan.matches(actual))
    }
    @Test fun `small map coordinate offsets do not hide a different POI`() {
        val original=route();val plan=WaypointPlanner.plan(original,original,candidate,now)
        val actual=original.copy(waypoints=plan.waypoints,destination=destination.copy(point=GeoPoint(37.52001,127.06)))
        assertTrue(plan.matches(actual));assertFalse(plan.matches(actual.copy(destination=actual.destination.copy(poiId="other"))))
    }
    @Test fun `missing coordinate sentinel blocks route rebuild and success verification`() {
        val original=route(); val broken=original.copy(waypoints=listOf(existing.copy(point=GeoPoint(0.0,0.0))))
        rejects(NavigationIssue.INVALID_DESTINATION){WaypointPlanner.plan(broken,broken,candidate,now)}
        rejects(NavigationIssue.INVALID_DESTINATION){WaypointPlanner.plan(original,original,candidate.copy(point=GeoPoint(0.0,0.0)),now)}
        val plan=WaypointPlanner.plan(original,original,candidate,now)
        assertFalse(plan.matches(original.copy(waypoints=listOf(plan.pickup.copy(point=GeoPoint(0.0,0.0))))))
    }

    @Test fun `verification rejects adjacent place coordinates and changed POI entrance or provider`() {
        val original=route().copy(destination=destination.copy(poiSubId="0",poiProvider="42dot"))
        val plan=WaypointPlanner.plan(original,original,candidate,now)
        val actual=original.copy(waypoints=plan.waypoints)
        for(d in listOf(original.destination.copy(point=GeoPoint(37.5202,127.06)),
            original.destination.copy(poiSubId="1"),original.destination.copy(poiProvider="other")))
            assertFalse(plan.matches(actual.copy(destination=d)))
        assertTrue(plan.matches(actual))
    }

}
