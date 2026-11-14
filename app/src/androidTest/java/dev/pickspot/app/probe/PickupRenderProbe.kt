package dev.pickspot.app.probe

import android.app.Activity
import android.app.Instrumentation
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.Bundle
import android.view.ContextThemeWrapper
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import dev.pickspot.app.R
import dev.pickspot.app.data.DemoPickupRepository
import dev.pickspot.app.domain.*
import dev.pickspot.app.presentation.*
import dev.pickspot.app.ui.PickupScreen
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Fixed-state layout render only. No Activity launch, clicks, GPS, navigation or HTTP. */
class PickupRenderProbe(private val instrumentation: Instrumentation) {
    fun execute() {
        val report=JSONObject()
        try {
            check(Build.HARDWARE in listOf("ranchu","goldfish") && instrumentation.targetContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE!=0)
            instrumentation.runOnMainSync {
                val files=JSONArray()
                val now=System.currentTimeMillis()
                val sample=DemoPickupRepository.sampleSession(now)
                val session=sample.copy(candidates=sample.candidates.take(3).map{it.copy(curbStatus=CurbStatus.UNKNOWN)},
                    canEndRemotely=true,destinationId="maebong",destinationOptions=listOf(DestinationOption("maebong","예제 목적지 · 양재·매봉")),
                    routeCalculation=RouteCalculation(RouteCalculationPhase.READY,"예제 목적지 · 양재·매봉",now,now+300_000,now,4))
                for((width,height) in listOf(520 to 0,1600 to 900,1600 to 1200,1000 to 700)) for(night in listOf(false,true)) {
                    val config=Configuration(instrumentation.targetContext.resources.configuration).apply {
                        uiMode=(uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or (if(night) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO)
                        densityDpi=160;screenWidthDp=width;screenHeightDp=if(height==0)900 else height;fontScale=1f
                    }
                    val context=ContextThemeWrapper(instrumentation.targetContext.createConfigurationContext(config),R.style.Theme_Pickspot)
                    val actions=mutableListOf<PickupAction>()
                    val screen=PickupScreen(context,{actions.add(it)},competitionDemo=true)
                    val state=PickupUiState(session=session,selectedId="b",meetingChoiceAvailable=true,recommendations=session.candidates.mapIndexed{i,c->RankedPickup(c,i.toDouble())},
                        sessionPhase=SessionPhase.READY,checkedAtEpochMillis=now,drivingAccess=DrivingAccess.AVAILABLE)
                    screen.render(state)
                    val root=screen.view
                    root.measure(View.MeasureSpec.makeMeasureSpec(width,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(height,if(height==0) View.MeasureSpec.UNSPECIFIED else View.MeasureSpec.EXACTLY))
                    root.layout(0,0,root.measuredWidth,root.measuredHeight)
                    val prefs=root.findViewById<ViewGroup>(R.id.preferences)
                    check((0..2).map{prefs.getChildAt(it).id}==listOf(R.id.less_walk,R.id.balanced,R.id.less_detour)){"PREFERENCE_ORDER"}
                    val dashboard=root.findViewById<View>(R.id.dashboard_workspace)
                    val ids=if(dashboard==null) listOf(R.id.confirm_meeting_point,R.id.change_destination,R.id.recalculate_routes,R.id.end_session,R.id.refresh_vehicle_route,R.id.vehicle_location_start)
                        else listOf(R.id.confirm_meeting_point,R.id.dashboard_settings_toggle,R.id.reload_session,R.id.end_session)
                    for(id in ids) {
                        val button=root.findViewById<Button>(id)
                        check(button.width<=320 && button.height>=84){"BUTTON_PROPORTION_$id"}
                        check(button.right<=(button.parent as View).width){"BUTTON_BOUNDS_$id"}
                    }
                    if(dashboard!=null) {
                        val toolbar=root.findViewById<View>(R.id.dashboard_toolbar)
                        val rect=android.graphics.Rect(0,0,toolbar.width,toolbar.height)
                        (root as ViewGroup).offsetDescendantRectToMyCoords(toolbar,rect)
                        check(rect.bottom<=height){"FOOTER_CLIPPED"}
                        check(dashboard.height>height/2){"CONTENT_TOO_SMALL"}
                        check(root.findViewById<View>(R.id.dashboard_settings).visibility==View.GONE){"SETTINGS_IN_MAIN"}
                        val preview=root.findViewById<View>(R.id.trip_preview_request)
                        val previewRect=android.graphics.Rect(0,0,preview.width,preview.height)
                        root.offsetDescendantRectToMyCoords(preview,previewRect)
                        if(width==1600) {
                            check(previewRect.bottom<=rect.top){"PREVIEW_BELOW_FOOTER"}
                            val rows=root.findViewById<ViewGroup>(R.id.candidate_list)
                            val last=rows.getChildAt(2)
                            val lastRect=android.graphics.Rect(0,0,last.width,last.height)
                            root.offsetDescendantRectToMyCoords(last,lastRect)
                            check(lastRect.bottom<=rect.top){"THIRD_CANDIDATE_CLIPPED"}
                        }
                    }
                    val bitmap=Bitmap.createBitmap(root.measuredWidth,root.measuredHeight,Bitmap.Config.ARGB_8888)
                    root.draw(Canvas(bitmap));val file=File(context.cacheDir,"pickup-dashboard-${width}x$height-${if(night) "dark" else "light"}.png")
                    file.outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)};bitmap.recycle();files.put(file.name)
                    val confirm=root.findViewById<Button>(R.id.confirm_meeting_point)
                    check(confirm.isEnabled){"PREVIEW_CONFIRM_DISABLED"}
                    confirm.performClick();check(actions.last()==PickupAction.ConfirmMeetingPoint){"EXPLICIT_CONFIRM_ACTION"}
                    screen.render(state.copy(session=session.copy(selectedCandidateId="b")))
                    check(!confirm.isEnabled && confirm.text.toString()==context.getString(R.string.meeting_confirmed)){"CONFIRMED_STATE"}
                    screen.render(state.copy(session=session.copy(selectedCandidateId="a")))
                    check(confirm.isEnabled && confirm.text.toString()==context.getString(R.string.confirm_meeting_change)){"CHANGE_CONFIRMATION"}
                    screen.render(state.copy(managing=true))
                    check(!confirm.isEnabled && confirm.text.toString()==context.getString(R.string.meeting_confirming)){"CONFIRMING_STATE"}
                    screen.render(state)
                    if(dashboard!=null) {
                        val confirmRect=android.graphics.Rect(0,0,confirm.width,confirm.height)
                        (root as ViewGroup).offsetDescendantRectToMyCoords(confirm,confirmRect)
                        check(confirmRect.bottom<=height && confirmRect.right<=width){"CONFIRM_BUTTON_CLIPPED"}
                        val toggle=root.findViewById<Button>(R.id.dashboard_settings_toggle)
                        toggle.performClick()
                        check(root.findViewById<View>(R.id.dashboard_settings).visibility==View.VISIBLE && root.findViewById<View>(R.id.body).visibility==View.GONE){"SETTINGS_NOT_OPEN"}
                        screen.render(state.copy(drivingAccess=DrivingAccess.RESTRICTED))
                        check(root.findViewById<View>(R.id.interactive_content).visibility==View.GONE){"DRIVING_RESTRICTION"}
                        screen.render(state)
                        check(root.findViewById<View>(R.id.dashboard_settings).visibility==View.GONE){"SETTINGS_NOT_RESET"}
                        screen.render(state.copy(sessionPhase=SessionPhase.ROUTE_FAILED,recommendations=emptyList(),selectedId=null))
                        val recalculate=root.findViewById<Button>(R.id.dashboard_recalculate)
                        check(recalculate.visibility==View.VISIBLE && recalculate.isEnabled){"RECALCULATION_RECOVERY"}
                        recalculate.performClick()
                        check(actions.last()==PickupAction.RecalculateRoutes){"RECALCULATION_ACTION"}
                        for (phase in listOf(SessionPhase.EXPIRED, SessionPhase.ENDED, SessionPhase.ERROR)) {
                            screen.render(state.copy(session=null,sessionPhase=phase,recommendations=emptyList(),selectedId=null))
                            check(recalculate.visibility==View.VISIBLE && recalculate.isEnabled){"RECOVERY_BUTTON_MISSING"}
                            recalculate.performClick()
                            check(actions.last()==if (phase==SessionPhase.ERROR) PickupAction.ReloadSession else PickupAction.NewSession){"RECOVERY_ACTION"}
                        }
                    }
                }
                report.put("passed",true).put("files",files).put("networkRequests",0).put("navigationRequests",0)
            }
        } catch(e:Exception) {report.put("passed",false).put("failure",e.message?:e.javaClass.simpleName)}
        instrumentation.finish(Activity.RESULT_OK,Bundle().apply{putString("stream",report.toString(2)+"\n")})
    }
}
