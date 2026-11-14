package dev.pickspot.app.probe

import android.app.Activity
import android.app.Instrumentation
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.Bundle
import android.view.ContextThemeWrapper
import android.view.LayoutInflater
import android.view.View
import android.widget.Button
import android.widget.Spinner
import android.widget.TextView
import dev.pickspot.app.R
import dev.pickspot.app.debug.VehicleInputScreen
import dev.pickspot.app.domain.*
import dev.pickspot.app.presentation.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class VehicleInputRenderProbe(private val instrumentation:Instrumentation){
    fun execute(){
        val report=JSONObject()
        try{
            check(Build.HARDWARE in listOf("ranchu","goldfish")&&instrumentation.targetContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE!=0)
            instrumentation.runOnMainSync {
                val context=ContextThemeWrapper(instrumentation.targetContext,R.style.Theme_Pickspot)
                val wall=1_800_000_000_000L;val elapsed=100_000L
                val fix=MeasuredVehiclePolicy().validate(MeasuredVehicleSample(37.484,127.030,wall,elapsed,12f),wall,elapsed)!!
                val route=VehicleRoute(VehiclePlace(GeoPoint(37.5,127.04),"검사 목적지"),emptyList(),"UNMAPPED",wall)
                val draft=VehicleTripPreparer.prepare(fix,ObservedVehicleRoute(route,wall,elapsed),DrivePreference.FREE_FIRST,wall,elapsed)
                val ready=VehicleInputState(MeasuredInputPhase.FRESH,true,DrivingAccess.AVAILABLE,12f,
                    NavigationState(NavigationPhase.READY,true),DrivePreference.FREE_FIRST,draft)
                val variants=listOf("ready" to ready,
                    "no-route" to ready.copy(navigation=NavigationState(NavigationPhase.FAILED,true,issue=NavigationIssue.NO_DESTINATION),preparation=VehicleTripPreparation(issue=TripPreparationIssue.ROUTE_REQUIRED)),
                    "no-preference" to ready.copy(preference=null,preparation=VehicleTripPreparation(issue=TripPreparationIssue.PREFERENCE_REQUIRED)),
                    "stale" to ready.copy(phase=MeasuredInputPhase.STALE,accuracyMeters=null,navigation=NavigationState(NavigationPhase.FAILED,issue=NavigationIssue.ROUTE_CONTEXT_STALE),preparation=VehicleTripPreparation(issue=TripPreparationIssue.POSITION_REQUIRED)),
                    "restricted" to VehicleInputState(MeasuredInputPhase.STOPPED,access=DrivingAccess.RESTRICTED))
                val files=JSONArray()
                for(width in listOf(520,960)){
                    val root=LayoutInflater.from(context).inflate(R.layout.activity_location_probe,null)
                    root.setBackgroundColor(context.getColor(R.color.background))
                    val screen=VehicleInputScreen(context,root){}
                    for((name,state)in variants){
                        screen.render(state)
                        check(root.findViewById<Spinner>(R.id.probe_preference).selectedItemPosition==(state.preference?.ordinal?.plus(1)?:0))
                        if(name=="stale")check(root.findViewById<TextView>(R.id.probe_details).text.isEmpty())
                        if(name=="restricted")check(root.findViewById<View>(R.id.probe_content).visibility==View.GONE)
                        if(name=="ready")check(!root.findViewById<Button>(R.id.probe_start).isEnabled)
                        root.measure(View.MeasureSpec.makeMeasureSpec(width,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(0,View.MeasureSpec.UNSPECIFIED))
                        root.layout(0,0,root.measuredWidth,root.measuredHeight)
                        val bitmap=Bitmap.createBitmap(root.measuredWidth,root.measuredHeight,Bitmap.Config.ARGB_8888)
                        root.draw(Canvas(bitmap));val file=File(context.cacheDir,"vehicle-input-$name-$width.png")
                        file.outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)};bitmap.recycle();files.put(file.name)
                    }
                }
                report.put("passed",true).put("files",files).put("locationReads",0).put("navigationRequests",0)
            }
        }catch(e:Exception){report.put("passed",false).put("failure",e.javaClass.simpleName)}
        instrumentation.finish(Activity.RESULT_OK,Bundle().apply{putString("stream",report.toString(2)+"\n")})
    }
}
