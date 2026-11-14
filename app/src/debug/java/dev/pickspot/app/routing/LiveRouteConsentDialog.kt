package dev.pickspot.app.routing

import android.app.AlertDialog
import android.content.Context
import android.view.LayoutInflater
import android.view.View
import android.widget.Button
import android.widget.TextView
import dev.pickspot.app.R
import dev.pickspot.app.presentation.*

/** A stale window cannot confirm or dismiss a newer intent. No automatic consent restoration. */
class LiveRouteConsentDialog(private val context:Context,private val disclosure:LiveRouteDisclosure?,
    private val onConfirm:(Int)->Unit,private val onDecline:(Int)->Unit){
    private var dialog:AlertDialog?=null
    private var shownId:Int?=null
    fun render(state:LiveRouteState,canInteract:Boolean){
        val wanted=state.consentId?.takeIf{state.phase==LiveRoutePhase.CONSENT&&canInteract&&disclosure!=null}
        if(wanted==shownId)return
        close()
        if(wanted==null)return
        val content=content(context,disclosure!!)
        val window=AlertDialog.Builder(context).setView(content).create()
        shownId=wanted;dialog=window
        content.findViewById<Button>(R.id.live_consent_confirm).setOnClickListener{
            close();onConfirm(wanted)
        }
        content.findViewById<Button>(R.id.live_consent_cancel).setOnClickListener{
            close();onDecline(wanted)
        }
        window.setOnCancelListener{close();onDecline(wanted)}
        window.setCanceledOnTouchOutside(false)
        window.show()
    }
    fun close(){
        dialog?.setOnCancelListener(null);dialog?.dismiss();dialog=null;shownId=null
    }
    companion object {
        fun content(context:Context,disclosure:LiveRouteDisclosure):View =
            LayoutInflater.from(context).inflate(R.layout.dialog_live_route_consent,android.widget.FrameLayout(context),false).apply{
                findViewById<TextView>(R.id.live_consent_recipient).text=context.getString(R.string.live_consent_recipient,disclosure.origin,disclosure.processingRegion)
            }
    }
}
