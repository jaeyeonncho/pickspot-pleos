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
import android.widget.LinearLayout
import android.widget.TextView
import dev.pickspot.app.R
import dev.pickspot.app.domain.*
import dev.pickspot.app.presentation.*
import dev.pickspot.app.routing.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Fixed-state Android layouts only, no location, HTTP or navigation access. */
class LiveRouteRenderProbe(private val instrumentation:Instrumentation){
    fun execute(){
        val report=JSONObject();val files=JSONArray();var checks=0
        try{
            check(Build.HARDWARE in listOf("ranchu","goldfish")&&instrumentation.targetContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE!=0)
            instrumentation.runOnMainSync{
                val context=ContextThemeWrapper(instrumentation.targetContext,R.style.Theme_Pickspot)
                val example=LiveRouteReport(6,3,1_800_000_030_000,DrivePreference.RECOMMENDED,0,listOf(
                    LiveRouteCandidate("a",230,240,120,RouteEvidence("검사 후보 A","고정 예제 · 실제 승하차 장소 아님",listOf("https://example.test/catalog"))),
                    LiveRouteCandidate("b",90,120,300,RouteEvidence("검사 후보 B","자료 출처·운영 조건 표시 검사",listOf("https://example.test/catalog")))))
                fun verify(value:Boolean){check(value);checks++}
                fun render(view:View,name:String,width:Int){
                    view.setBackgroundColor(context.getColor(R.color.background))
                    view.measure(View.MeasureSpec.makeMeasureSpec(width,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(0,View.MeasureSpec.UNSPECIFIED))
                    view.layout(0,0,view.measuredWidth,view.measuredHeight)
                    val image=Bitmap.createBitmap(view.measuredWidth,view.measuredHeight,Bitmap.Config.ARGB_8888)
                    view.draw(Canvas(image));val file=File(context.cacheDir,"live-route-$name-$width.png")
                    file.outputStream().use{image.compress(Bitmap.CompressFormat.PNG,100,it)};image.recycle();files.put(file.name)
                }
                for(width in listOf(520,960)){
                    val root=LayoutInflater.from(context).inflate(R.layout.panel_live_routes,null)
                    val panel=LiveRoutePanel(context,root,{},{});val rows=root.findViewById<LinearLayout>(R.id.live_routes_results)
                    val states=listOf(
                        "unavailable" to LiveRouteState(),"waiting" to LiveRouteState(LiveRoutePhase.WAITING),
                        "available" to LiveRouteState(LiveRoutePhase.AVAILABLE),"calculating" to LiveRouteState(LiveRoutePhase.CALCULATING),
                        "ready" to LiveRouteState(LiveRoutePhase.READY,example),"stale" to LiveRouteState(LiveRoutePhase.STALE),
                        "failed" to LiveRouteState(LiveRoutePhase.FAILED,issue=LiveRouteFailure.LIMIT))
                    for((name,state) in states){
                        panel.render(state,true)
                        verify(root.findViewById<Button>(R.id.live_routes_compare).isEnabled==(state.phase in setOf(LiveRoutePhase.AVAILABLE,LiveRoutePhase.READY)))
                        verify((root.findViewById<Button>(R.id.live_routes_cancel).visibility==View.VISIBLE)==(state.phase==LiveRoutePhase.CALCULATING))
                        if(name=="ready"){
                            val row=rows.getChildAt(0);panel.render(state,true);verify(rows.getChildAt(0)===row)
                            verify((rows.getChildAt(2) as TextView).text.contains("실제 승하차 장소 아님"))
                        }else verify(rows.childCount==0)
                        render(root,name,width)
                    }
                    panel.render(LiveRouteState(LiveRoutePhase.READY,example),true)
                    panel.render(LiveRouteState(LiveRoutePhase.READY,example),false)
                    verify(root.visibility==View.GONE&&rows.childCount==0&&!root.findViewById<Button>(R.id.live_routes_compare).isEnabled)
                    val content=LiveRouteConsentDialog.content(context,LiveRouteDisclosure("https://example.test","검사 전용 · 실제 전송 없음"))
                    verify(content.findViewById<TextView>(R.id.live_consent_recipient).text.contains("https://example.test"))
                    verify(content.findViewById<Button>(R.id.live_consent_confirm).text==context.getString(R.string.live_consent_confirm))
                    render(content,"consent",width)
                }
            }
            report.put("passed",true)
        }catch(e:Exception){report.put("passed",false).put("failure",e.javaClass.simpleName)}
        report.put("checks",checks).put("files",files).put("networkRequests",0).put("locationReads",0).put("navigationRequests",0)
        instrumentation.finish(Activity.RESULT_OK,Bundle().apply{putString("stream",report.toString(2)+"\n")})
    }
}
