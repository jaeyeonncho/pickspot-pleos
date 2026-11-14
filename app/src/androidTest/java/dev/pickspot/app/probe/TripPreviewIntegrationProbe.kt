package dev.pickspot.app.probe

import android.app.Activity
import android.app.Instrumentation
import android.content.pm.ApplicationInfo
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import ai.pleos.playground.navi.constants.*
import ai.pleos.playground.navi.data.*
import ai.pleos.playground.navi.helper.NaviHelper
import ai.pleos.playground.navi.helper.listener.NaviHelperEventListener
import dev.pickspot.app.domain.*
import dev.pickspot.app.navigation.PleosTripPreview
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** Production adapter test. Never creates, cancels, or modifies a navigation route. */
class TripPreviewIntegrationProbe(private val instrumentation: Instrumentation) {
    private val states = LinkedBlockingQueue<RouteStateInfo>()
    private val connected = LinkedBlockingQueue<Boolean>()
    private val results = LinkedBlockingQueue<TripPreviewOutcome>()
    private var changes = 0
    private lateinit var raw: NaviHelper
    private var preview: PleosTripPreview? = null
    private val report = JSONObject().put("fixedExamples",true).put("tmapCalls",0).put("routeMutationRequests",0)
    private val listener = object:NaviHelperEventListener {
        override fun onRouteStateInfo(routeStateInfo:RouteStateInfo){states.offer(routeStateInfo)}
        override fun onDestinationChanged(){changes++}
        override fun onWaypointChanged(waypointChangedInfo:WaypointChangedInfo){changes++}
        override fun onRouteOptionChanged(routeOption:RouteOption){changes++}
        override fun onRouteStarted(routeStartInfo:RouteStartInfo){changes++}
        override fun onRouteCancelled(){changes++}
    }
    private fun main(action:()->Unit)=instrumentation.runOnMainSync(action)
    private fun state():RouteStateInfo {
        states.clear();main{raw.getRouteStateInfo()}
        return states.poll(15,TimeUnit.SECONDS)?:error("STATE_TIMEOUT")
    }
    private fun guiding(state:RouteStateInfo)=state.naviMode in setOf(NaviMode.ROUTE_GUIDING,NaviMode.SIMULATION_GUIDING)
    fun execute() {
        try {
            check(Build.HARDWARE in listOf("ranchu","goldfish")&&instrumentation.targetContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE!=0){"EMULATOR_ONLY"}
            main{raw=NaviHelper(instrumentation.targetContext);raw.initialize(onConnected={raw.addListener(listener);connected.offer(true)},onFailed={connected.offer(false)})}
            check(connected.poll(20,TimeUnit.SECONDS)==true){"CONNECTION_FAILED"}
            val before=state();check(!guiding(before)){"EXISTING_GUIDANCE_NOT_MODIFIED"}
            main{changes=0;preview=PleosTripPreview(instrumentation.targetContext).also{it.setInteractionAllowed(true)}}
            val examples=listOf(
                TripPreviewTarget("probe","a","고정 예제 A",GeoPoint(37.48544722,127.03636666)),
                TripPreviewTarget("probe","b","고정 예제 B",GeoPoint(37.41275833,127.09481944)))
            val rows=JSONArray();report.put("requests",rows)
            for(target in examples) {
                instrumentation.sendStatus(0,Bundle().apply{putString("stream","preview=${target.candidateId}\n")})
                results.clear();main{preview!!.request(target,results::offer)}
                val response=results.poll(35,TimeUnit.SECONDS)?:error("PREVIEW_TIMEOUT")
                val row=JSONObject().put("example",target.candidateId)
                when(response) {
                    is TripPreviewOutcome.Success -> row.put("verified",true).put("distanceMeters",response.metrics.distanceMeters).put("durationSeconds",response.metrics.durationSeconds)
                    is TripPreviewOutcome.Failure -> row.put("verified",false).put("issue",response.issue.name)
                }
                rows.put(row);check(response is TripPreviewOutcome.Success){"PREVIEW_FAILED"}
                val after=state()
                check(after.naviMode==before.naviMode&&after.routeOption==before.routeOption){"GUIDANCE_CHANGED"}
            }
            // Verify the production dispatch gate without transmitting another SDK request.
            results.clear();main{preview!!.setInteractionAllowed(false);preview!!.request(examples.first(),results::offer)}
            val blocked=results.poll(2,TimeUnit.SECONDS)
            report.put("restrictedRequestBlocked",blocked==TripPreviewOutcome.Failure(TripPreviewIssue.RESTRICTED))
            check(blocked==TripPreviewOutcome.Failure(TripPreviewIssue.RESTRICTED)){"RESTRICTION_FAILED"}
            val end=SystemClock.elapsedRealtime()+6_000
            do {check(!guiding(state())){"GUIDANCE_CHANGED"};SystemClock.sleep(1_000)}while(SystemClock.elapsedRealtime()<end)
            main{report.put("routeChangeEvents",changes)}
            check(report.getInt("routeChangeEvents")==0){"GUIDANCE_EVENTS"}
            report.put("idleStableSeconds",6).put("passed",true)
        }catch(e:Exception){report.put("passed",false).put("failure",e.message?.takeIf{it.matches(Regex("[A-Z_]+"))}?:e.javaClass.simpleName)}
        finally {
            main{preview?.close();if(::raw.isInitialized)runCatching{raw.removeListener(listener);raw.release()}}
            instrumentation.finish(Activity.RESULT_OK,Bundle().apply{putString("stream",report.toString(2)+"\n")})
        }
    }
}
