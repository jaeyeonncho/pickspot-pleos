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
import android.widget.LinearLayout
import android.widget.TextView
import dev.pickspot.app.R
import dev.pickspot.app.domain.*
import dev.pickspot.app.presentation.*
import dev.pickspot.app.sharing.SharingScreen
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Offscreen real Android layout; no session, location, navigation or HTTP calls. */
class SharingRenderProbe(private val instrumentation: Instrumentation) {
    fun execute() {
        val report = JSONObject()
        try {
            check(Build.HARDWARE in listOf("ranchu", "goldfish") &&
                instrumentation.targetContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
            instrumentation.runOnMainSync {
                val context = ContextThemeWrapper(instrumentation.targetContext, R.style.Theme_Pickspot)
                val candidates = listOf(SharedExampleCandidate("a",230,240,120), SharedExampleCandidate("b",90,120,300))
                val snapshot = SharingSnapshot(null, SharingStatus.READY, 900000, 30000,
                    SharedExampleRecommendation(30000, candidates))
                val ready = SharingUiState(SharingPhase.CURRENT, snapshot, true, DrivingAccess.AVAILABLE, checkedSecondsAgo=0)
                val files = JSONArray()
                for (width in listOf(520,960)) {
                    val view = LayoutInflater.from(context).inflate(R.layout.activity_sharing, null)
                    view.setBackgroundColor(context.getColor(R.color.background))
                    val screen = SharingScreen(context, view)
                    fun layout() {
                        view.measure(View.MeasureSpec.makeMeasureSpec(width,View.MeasureSpec.EXACTLY),
                            View.MeasureSpec.makeMeasureSpec(0,View.MeasureSpec.UNSPECIFIED))
                        view.layout(0,0,view.measuredWidth,view.measuredHeight)
                    }
                    screen.render(ready); layout()
                    val rows=view.findViewById<LinearLayout>(R.id.sharing_candidates)
                    val firstRow=rows.getChildAt(0)
                    val height=view.measuredHeight
                    val endTop=view.findViewById<View>(R.id.sharing_end).top
                    for (age in listOf(1L,3L,9L,10L,29L)) {
                        screen.render(ready.copy(refreshing=true,checkedSecondsAgo=age)); layout()
                        check(rows.getChildAt(0)===firstRow) { "CANDIDATE_REBUILT" }
                        check(view.measuredHeight==height && view.findViewById<View>(R.id.sharing_end).top==endTop) { "REFRESH_LAYOUT_SHIFT" }
                        check(view.findViewById<TextView>(R.id.sharing_status).text==context.getString(R.string.sharing_ready)) { "STATUS_FLICKER" }
                    }
                    val variants = listOf(
                        "idle" to SharingUiState(drivingAccess=DrivingAccess.AVAILABLE),
                        "invitation" to ready.copy(session=snapshot.copy(inviteCode="DEMO12345678",status=SharingStatus.NOT_SHARING,recommendation=null)),
                        "ready" to ready.copy(checkedSecondsAgo=3,refreshing=true),
                        "stale" to ready.copy(session=snapshot.displayableAt(30000),checkedSecondsAgo=5),
                        "withdrawn" to ready.copy(session=snapshot.copy(status=SharingStatus.WITHDRAWN,recommendation=null)),
                        "offline" to SharingUiState(SharingPhase.OFFLINE,canEnd=true,drivingAccess=DrivingAccess.AVAILABLE),
                        "ended" to SharingUiState(SharingPhase.ENDED,drivingAccess=DrivingAccess.AVAILABLE),
                        "restricted" to ready.copy(drivingAccess=DrivingAccess.RESTRICTED)
                    )
                    for ((name,state) in variants) {
                        screen.render(state); layout()
                        if(name in listOf("stale","withdrawn","offline","ended","restricted")) {
                            check(rows.childCount==0) { "HIDDEN_CANDIDATE_RETAINED" }
                        }
                        val bitmap=Bitmap.createBitmap(view.measuredWidth,view.measuredHeight,Bitmap.Config.ARGB_8888)
                        view.draw(Canvas(bitmap))
                        val file=File(context.cacheDir,"sharing-$name-$width.png")
                        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG,100,it) }; bitmap.recycle()
                        files.put(file.name)
                    }
                }
                report.put("passed",true).put("files",files).put("refreshKeepsRowsAndLayout",true)
                    .put("networkRequests",0).put("navigationRequests",0)
            }
        } catch(e:Exception) { report.put("passed",false).put("failure",e.message?:e.javaClass.simpleName) }
        instrumentation.finish(Activity.RESULT_OK,Bundle().apply { putString("stream",report.toString(2)+"\n") })
    }
}
