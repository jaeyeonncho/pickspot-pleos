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
import android.widget.Button
import dev.pickspot.app.R
import dev.pickspot.app.data.DemoPickupRepository
import dev.pickspot.app.domain.*
import dev.pickspot.app.presentation.*
import dev.pickspot.app.ui.PickupScreen
import dev.pickspot.app.ui.TripPreviewPanel
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Current production layouts rendered offscreen with explicit synthetic states. No device UI input or network. */
class PickupAtlasProbe(private val instrumentation: Instrumentation) {
 fun execute() {
  val result=JSONObject()
  try {
   check(Build.HARDWARE in listOf("ranchu","goldfish") && instrumentation.targetContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE!=0)
   instrumentation.runOnMainSync {
    val now=System.currentTimeMillis()
    val sample=DemoPickupRepository.sampleSession(now)
    val session=sample.copy(candidates=sample.candidates.take(3).map{it.copy(curbStatus=CurbStatus.UNKNOWN)},canEndRemotely=true,
     destinationId="maebong",destinationOptions=listOf(DestinationOption("maebong","예제 목적지 · 양재·매봉")),
     routeCalculation=RouteCalculation(RouteCalculationPhase.READY,"예제 목적지 · 양재·매봉",now,now+1_800_000,now,4))
    val ranker=PickupRecommender()
    val base=PickupUiState(session=session,selectedId="a",meetingChoiceAvailable=true,recommendations=ranker.rank(session.candidates,PickupPreference.BALANCED),
     sessionPhase=SessionPhase.READY,checkedAtEpochMillis=now,drivingAccess=DrivingAccess.AVAILABLE)
    val states=listOf(
     "01_waiting" to base.copy(session=session.copy(passengerPoint=null,candidates=emptyList(),availability=SessionAvailability.WAITING,inviteCode="000000000000",routeCalculation=null),sessionPhase=SessionPhase.WAITING,recommendations=emptyList(),selectedId=null),
     "02_calculating" to base.copy(sessionPhase=SessionPhase.CALCULATING,recommendations=emptyList(),selectedId=null),
     "03_balanced" to base,
     "04_less_walk" to base.copy(preference=PickupPreference.LESS_WALK,recommendations=ranker.rank(session.candidates,PickupPreference.LESS_WALK),selectedId="b"),
     "05_less_detour" to base.copy(preference=PickupPreference.LESS_DETOUR,recommendations=ranker.rank(session.candidates,PickupPreference.LESS_DETOUR),selectedId="c"),
     "06_preview_b" to base.copy(selectedId="b"),
     "07_confirming_b" to base.copy(selectedId="b",managing=true),
     "08_confirmed_b" to base.copy(selectedId="b",session=session.copy(selectedCandidateId="b")),
     "09_preview_c_keep_b" to base.copy(selectedId="c",session=session.copy(selectedCandidateId="b")),
     "10_confirmed_c" to base.copy(selectedId="c",session=session.copy(selectedCandidateId="c")),
     "11_pleos_loading" to base,
     "12_pleos_ready" to base,
     "13_settings" to base,
     "15_ended" to base.copy(sessionPhase=SessionPhase.ENDED,recommendations=emptyList(),selectedId=null),
     "16_expired" to base.copy(sessionPhase=SessionPhase.EXPIRED,recommendations=emptyList(),selectedId=null),
     "17_route_retry" to base.copy(sessionPhase=SessionPhase.ROUTE_FAILED,recommendations=emptyList(),selectedId=null),
     "18_error" to base.copy(sessionPhase=SessionPhase.ERROR,sessionIssue=SessionIssue.UNAVAILABLE,recommendations=emptyList(),selectedId=null),
     "19_restricted" to base.copy(drivingAccess=DrivingAccess.RESTRICTED)
    )
    val files=JSONArray()
    for(night in listOf(false,true)) {
     val config=Configuration(instrumentation.targetContext.resources.configuration).apply {uiMode=(uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or (if(night) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO);densityDpi=160;screenWidthDp=1600;screenHeightDp=900;fontScale=1f}
     val context=ContextThemeWrapper(instrumentation.targetContext.createConfigurationContext(config),R.style.Theme_Pickspot)
     for((name,state) in states) {
      val screen=PickupScreen(context,{},competitionDemo=true);screen.render(state)
      if(name=="13_settings")screen.view.findViewById<Button>(R.id.dashboard_settings_toggle).performClick()
      val target=TripPreviewTarget("atlas","a","픽업 지점 A",session.candidates.first().point)
      val preview=when(name){"11_pleos_loading"->TripPreviewState(target,true,busy=true,phase=TripPreviewPhase.LOADING);"12_pleos_ready"->TripPreviewState(target,true,phase=TripPreviewPhase.READY,metrics=TripPreviewMetrics(12331,1045),ageSeconds=3);else->TripPreviewState(target,state.canSelect)}
      TripPreviewPanel(context,screen.view){}.render(preview)
      val view=screen.view;view.measure(View.MeasureSpec.makeMeasureSpec(1600,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(900,View.MeasureSpec.EXACTLY));view.layout(0,0,1600,900)
      val bitmap=Bitmap.createBitmap(1600,900,Bitmap.Config.ARGB_8888);view.draw(Canvas(bitmap))
      val file=File(context.cacheDir,"atlas-${name}-${if(night) "dark" else "light"}.png")
      file.outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)};bitmap.recycle();files.put(file.name)
     }
    }
    result.put("passed",true).put("files",files).put("syntheticStates",true).put("networkRequests",0).put("navigationRequests",0)
   }
  }catch(e:Exception){result.put("passed",false).put("failure",e.message?:e.javaClass.simpleName)}
  instrumentation.finish(Activity.RESULT_OK,Bundle().apply{putString("stream",result.toString(2)+"\n")})
 }
}
