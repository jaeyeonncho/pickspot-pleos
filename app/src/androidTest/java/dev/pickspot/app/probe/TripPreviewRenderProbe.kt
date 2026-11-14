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
import android.widget.TextView
import dev.pickspot.app.R
import dev.pickspot.app.domain.*
import dev.pickspot.app.presentation.*
import dev.pickspot.app.ui.TripPreviewPanel
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Offscreen Android layout verification. These images are panel renders, not full app screenshots. */
class TripPreviewRenderProbe(private val instrumentation:Instrumentation) {
    fun execute() {
        val report=JSONObject()
        try {
            check(Build.HARDWARE in listOf("ranchu","goldfish")&&instrumentation.targetContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE!=0){"EMULATOR_ONLY"}
            instrumentation.runOnMainSync {
                val context=ContextThemeWrapper(instrumentation.targetContext,R.style.Theme_Pickspot)
                val target=TripPreviewTarget("render","a","예제 A",GeoPoint(37.48544722,127.03636666))
                val ready=TripPreviewState(target,true,phase=TripPreviewPhase.READY,metrics=TripPreviewMetrics(12319,1043),ageSeconds=4)
                val files=JSONArray()
                for(width in listOf(520,340)) {
                    val view=LayoutInflater.from(context).inflate(R.layout.panel_trip_preview,null)
                    view.setBackgroundColor(context.getColor(R.color.background));view.setPadding(20,20,20,20)
                    val panel=TripPreviewPanel(context,view){}
                    for((name,state) in listOf("ready" to ready,"stale" to ready.copy(phase=TripPreviewPhase.STALE,metrics=null,ageSeconds=null))) {
                        panel.render(state)
                        val button=view.findViewById<Button>(R.id.trip_preview_request)
                        check(button.isEnabled==(name=="stale")){"BUTTON_STATE"}
                        if(name=="stale")check(!view.findViewById<TextView>(R.id.trip_preview_status).text.contains("12.3")){"STALE_VALUE"}
                        view.measure(View.MeasureSpec.makeMeasureSpec(width,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(0,View.MeasureSpec.UNSPECIFIED))
                        view.layout(0,0,view.measuredWidth,view.measuredHeight)
                        val bitmap=Bitmap.createBitmap(view.measuredWidth,view.measuredHeight,Bitmap.Config.ARGB_8888)
                        view.draw(Canvas(bitmap))
                        val file=File(context.cacheDir,"trip-preview-$name-$width.png")
                        file.outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)};bitmap.recycle()
                        files.put(file.absolutePath)
                    }
                }
                report.put("panelRenders",files).put("passed",true)
            }
        }catch(e:Exception){report.put("passed",false).put("failure",e.javaClass.simpleName)}
        instrumentation.finish(Activity.RESULT_OK,Bundle().apply{putString("stream",report.toString(2)+"\n")})
    }
}
