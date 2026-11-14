package dev.pickspot.app.probe

import android.app.Activity
import android.app.Instrumentation
import android.content.pm.ApplicationInfo
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import androidx.lifecycle.ViewModelStore
import dev.pickspot.app.driving.PleosDrivingAccess
import dev.pickspot.app.location.AndroidMeasuredLocation
import dev.pickspot.app.location.PleosVehicleRouteReader
import dev.pickspot.app.presentation.*
import dev.pickspot.app.domain.*
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/** Existing GPS permission only; no permission grant, coordinates in report, route writes or HTTP. */
class VehicleInputReadProbe(private val instrumentation:Instrumentation){
    fun execute(){
        val report=JSONObject().put("networkRequests",0).put("navigationMutationRequests",0)
        val store=ViewModelStore();var model:VehicleInputViewModel?=null;var driving:PleosDrivingAccess?=null
        try{
            check(Build.HARDWARE in listOf("ranchu","goldfish")&&instrumentation.targetContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE!=0){"EMULATOR_ONLY"}
            val access=LinkedBlockingQueue<DrivingAccess>()
            instrumentation.runOnMainSync {
                val gps=AndroidMeasuredLocation(instrumentation.targetContext)
                check(gps.hasPermission()){"EXISTING_FINE_PERMISSION_REQUIRED"}
                model=VehicleInputViewModel(gps,PleosVehicleRouteReader(instrumentation.targetContext),System::currentTimeMillis,SystemClock::elapsedRealtime)
                store.put("input-probe",model!!);model!!.onForeground()
                driving=PleosDrivingAccess(instrumentation.targetContext).also{adapter->adapter.start{value->model!!.updateAccess(value);access.offer(value)}}
            }
            val deadline=SystemClock.elapsedRealtime()+15000;var allowed=false
            while(SystemClock.elapsedRealtime()<deadline){
                if(access.poll(1,TimeUnit.SECONDS)==DrivingAccess.AVAILABLE){allowed=true;break}
            }
            check(allowed){"INTERACTION_NOT_AVAILABLE"}
            instrumentation.runOnMainSync {model!!.choose(DrivePreference.FREE_FIRST);model!!.start()}
            val end=SystemClock.elapsedRealtime()+20000
            var measured=false;var routeObserved=false;var routeIssue:String?=null
            while(SystemClock.elapsedRealtime()<end){
                instrumentation.runOnMainSync {
                    val state=model!!.state.value
                    measured=state.accuracyMeters!=null
                    routeObserved=state.navigation.phase in setOf(NavigationPhase.READY,NavigationPhase.FAILED)
                    routeIssue=state.navigation.issue?.name
                }
                if(measured&&routeObserved)break
                SystemClock.sleep(250)
            }
            report.put("measuredAccuracyReceived",measured).put("routeReadFinished",routeObserved)
                .put("routeIssue",routeIssue?:JSONObject.NULL)
            instrumentation.runOnMainSync {
                model!!.onBackground();val state=model!!.state.value
                val cleared=!state.running&&state.accuracyMeters==null&&state.preparation.draft==null&&state.navigation.route==null
                report.put("backgroundCleared",cleared);check(cleared){"BACKGROUND_NOT_CLEARED"}
            }
            check(measured&&routeObserved){"READ_NOT_CONFIRMED"};report.put("passed",true)
        }catch(e:Exception){report.put("passed",false).put("failure",e.message?.takeIf{it.matches(Regex("[A-Z_]+"))}?:e.javaClass.simpleName)}
        finally{instrumentation.runOnMainSync{driving?.stop();store.clear()}}
        instrumentation.finish(Activity.RESULT_OK,Bundle().apply{putString("stream",report.toString(2)+"\n")})
    }
}
