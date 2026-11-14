package dev.pickspot.app.domain

import org.junit.Assert.*
import org.junit.Test

class VehicleTripPreparerTest {
    private val wall=1_800_000_000_000L
    private val elapsed=100_000L
    private val point=GeoPoint(37.484,127.030)
    private val fix=MeasuredVehiclePolicy().validate(MeasuredVehicleSample(point.latitude,point.longitude,wall,elapsed,12f),wall,elapsed)!!
    private val route=VehicleRoute(VehiclePlace(GeoPoint(37.5,127.04),"원래 목적지"),emptyList(),"PLEOS_UNMAPPED",wall)
    private fun prepare(f:MeasuredVehicleFix?=fix,r:VehicleRoute?=route,p:DrivePreference?=DrivePreference.FREE_FIRST,w:Long=wall,e:Long=elapsed)=
        VehicleTripPreparer.prepare(f,r?.let{ObservedVehicleRoute(it,wall,elapsed)},p,w,e)
    @Test fun `local draft keeps measured accuracy original destination and explicit independent preference`() {
        val result=prepare().draft!!
        assertEquals(12f,result.vehicle.accuracyMeters)
        assertEquals(route,result.route);assertEquals("PLEOS_UNMAPPED",result.route.routeOption)
        assertEquals(DrivePreference.FREE_FIRST,result.preference);assertEquals(wall+30000,result.validUntil)
    }
    @Test fun `GPS and route are both required and comparison is never inferred from Pleos option`() {
        assertEquals(TripPreparationIssue.POSITION_REQUIRED,prepare(f=null).issue)
        assertEquals(TripPreparationIssue.ROUTE_REQUIRED,prepare(r=null).issue)
        assertEquals(TripPreparationIssue.PREFERENCE_REQUIRED,prepare(p=null).issue)
    }
    @Test fun `earliest measured position or route bounds draft lifetime`() {
        assertEquals(wall+10000,prepare(r=route.copy(observedAtEpochMillis=wall-20000)).draft!!.validUntil)
        val older=MeasuredVehiclePolicy().validate(MeasuredVehicleSample(point.latitude,point.longitude,wall-25000,elapsed-25000,12f),wall,elapsed)!!
        assertEquals(wall+5000,prepare(f=older).draft!!.validUntil)
        assertEquals(TripPreparationIssue.POSITION_STALE,prepare(w=wall+30000,e=elapsed+30000).issue)
    }
    @Test fun `monotonic age and clock rollback cannot prolong original route`() {
        val observation=ObservedVehicleRoute(route,wall,elapsed)
        assertEquals(0,observation.remainingMillis(wall,elapsed+30000).toInt())
        assertEquals(0,observation.remainingMillis(wall-1,elapsed).toInt())
        assertEquals(0,observation.remainingMillis(wall,elapsed-1).toInt())
        assertEquals(TripPreparationIssue.ROUTE_STALE,prepare(r=route.copy(observedAtEpochMillis=wall-30000)).issue)
        assertEquals(TripPreparationIssue.ROUTE_STALE,prepare(r=route.copy(observedAtEpochMillis=wall+1)).issue)
    }
    @Test fun `missing coordinate sentinels never enter prepared input`() {
        assertEquals(TripPreparationIssue.COORDINATE_UNAVAILABLE,prepare(f=fix.copy(point=GeoPoint(0.0,0.0))).issue)
        assertEquals(TripPreparationIssue.COORDINATE_UNAVAILABLE,prepare(r=route.copy(destination=route.destination.copy(point=GeoPoint(0.0,0.0)))).issue)
        assertEquals(TripPreparationIssue.COORDINATE_UNAVAILABLE,prepare(r=route.copy(waypoints=listOf(VehiclePlace(GeoPoint(0.0,0.0),"경유")))).issue)
    }
    @Test fun `one original stop is copied in order while two are refused`() {
        val stops=mutableListOf(VehiclePlace(GeoPoint(37.49,127.035),"원래 경유"))
        val result=prepare(r=route.copy(waypoints=stops)).draft!!;stops.clear()
        assertEquals(1,result.route.waypoints.size)
        assertEquals(TripPreparationIssue.WAYPOINT_LIMIT,prepare(r=route.copy(waypoints=listOf(route.destination,route.destination))).issue)
    }
    @Test fun `invalid destination names are refused rather than silently rewritten`() {
        for(name in listOf("","  ","x".repeat(101),"목적지\n이름","\u007f"))
            assertEquals(TripPreparationIssue.INVALID_DESTINATION,prepare(r=route.copy(destination=route.destination.copy(name=name))).issue)
    }
    @Test fun `all explicit preferences retain stable server identifiers`() {
        assertEquals(listOf("recommended","free-first","fastest","beginner","highway-first","shortest","avoid-school-zones"),DrivePreference.entries.map{it.wireValue})
        for(value in DrivePreference.entries)assertEquals(value,prepare(p=value).draft!!.preference)
    }
}
