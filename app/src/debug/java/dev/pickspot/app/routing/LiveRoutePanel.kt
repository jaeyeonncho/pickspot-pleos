package dev.pickspot.app.routing

import android.content.Context
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import dev.pickspot.app.R
import dev.pickspot.app.domain.*
import dev.pickspot.app.presentation.*

/** Rendering only. Repeated status polls keep the same candidate views. */
class LiveRoutePanel(private val context:Context,root:View,onCompare:()->Unit,onCancel:()->Unit){
    private val panel=root.findViewById<View>(R.id.live_routes_panel)
    private val status=root.findViewById<TextView>(R.id.live_routes_status)
    private val compare=root.findViewById<Button>(R.id.live_routes_compare)
    private val cancel=root.findViewById<Button>(R.id.live_routes_cancel)
    private val results=root.findViewById<LinearLayout>(R.id.live_routes_results)
    private var displayed:LiveRouteReport?=null
    init{compare.setOnClickListener{onCompare()};cancel.setOnClickListener{onCancel()}}
    fun render(state:LiveRouteState,canInteract:Boolean){
        panel.visibility=if(canInteract)View.VISIBLE else View.GONE
        val current=state.report?.takeIf{canInteract&&state.phase==LiveRoutePhase.READY}
        if(current!=displayed){
            results.removeAllViews();displayed=current
            current?.let{report->
                for(row in report.candidates){
                    add(row.evidence.name,R.style.Text_Heading)
                    add(context.getString(R.string.live_routes_metrics,row.walkMeters,duration(row.walkSeconds),duration(row.detourSeconds)))
                    add(context.getString(R.string.live_routes_conditions,row.evidence.conditions),R.style.Text_Caption)
                    add(context.getString(R.string.live_routes_sources,row.evidence.sources.joinToString("\n")),R.style.Text_Caption)
                }
                add(context.getString(R.string.live_routes_reference),R.style.Text_Caption)
            }
        }
        results.visibility=if(current!=null)View.VISIBLE else View.GONE
        status.setText(when(state.phase){
            LiveRoutePhase.UNAVAILABLE->R.string.live_routes_unavailable
            LiveRoutePhase.WAITING->R.string.live_routes_waiting
            LiveRoutePhase.AVAILABLE->R.string.live_routes_available
            LiveRoutePhase.CONSENT->R.string.live_routes_consent
            LiveRoutePhase.CALCULATING->R.string.live_routes_calculating
            LiveRoutePhase.READY->if(current?.candidates?.isEmpty()==true)R.string.live_routes_empty else R.string.live_routes_ready
            LiveRoutePhase.STALE->R.string.live_routes_stale
            LiveRoutePhase.FAILED->when(state.issue){
                LiveRouteFailure.ACCESS->R.string.live_routes_access
                LiveRouteFailure.CHANGED->R.string.live_routes_changed
                LiveRouteFailure.CONSENT->R.string.live_routes_consent_required
                LiveRouteFailure.INPUT->R.string.live_routes_input
                LiveRouteFailure.LIMIT->R.string.live_routes_limit
                LiveRouteFailure.UNAVAILABLE->R.string.live_routes_unavailable
                LiveRouteFailure.INVALID_RESPONSE->R.string.live_routes_invalid
                else->R.string.live_routes_connection
            }
        })
        compare.setText(if(state.phase==LiveRoutePhase.READY)R.string.live_routes_again else R.string.live_routes_request)
        compare.isEnabled=canInteract&&state.phase in setOf(LiveRoutePhase.AVAILABLE,LiveRoutePhase.READY)
        compare.alpha=if(compare.isEnabled)1f else 0.45f
        cancel.visibility=if(state.phase==LiveRoutePhase.CALCULATING)View.VISIBLE else View.GONE
        cancel.isEnabled=canInteract&&state.phase==LiveRoutePhase.CALCULATING
    }
    private fun add(value:String,style:Int=R.style.Text_Body){
        results.addView(TextView(context,null,0,style).apply{
            text=value
            layoutParams=LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,LinearLayout.LayoutParams.WRAP_CONTENT).apply{
                topMargin=context.resources.getDimensionPixelSize(R.dimen.content_gap)
            }
        })
    }
    private fun duration(seconds:Int):String=when{
        seconds<60->context.getString(R.string.duration_seconds,seconds)
        seconds%60==0->context.getString(R.string.duration_minutes,seconds/60)
        else->context.getString(R.string.duration_minutes_seconds,seconds/60,seconds%60)
    }
}
