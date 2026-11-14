package dev.pickspot.app.routing

import android.content.Context
import android.view.View
import android.widget.Button
import android.widget.TextView
import dev.pickspot.app.R
import dev.pickspot.app.presentation.*

class VehiclePairingPanel(private val context:Context,root:View,start:()->Unit,clear:()->Unit){
    private val panel=root.findViewById<View>(R.id.pairing_panel)
    private val status=root.findViewById<TextView>(R.id.pairing_status)
    private val code=root.findViewById<TextView>(R.id.pairing_code)
    private val remaining=root.findViewById<TextView>(R.id.pairing_remaining)
    private val startButton=root.findViewById<Button>(R.id.pairing_start).apply{setOnClickListener{start()}}
    private val clearButton=root.findViewById<Button>(R.id.pairing_clear).apply{setOnClickListener{clear()}}
    fun render(state:VehiclePairingState,canInteract:Boolean){
        panel.visibility=if(canInteract)View.VISIBLE else View.GONE
        val waiting=canInteract&&state.phase==VehiclePairingPhase.WAITING
        val value=if(waiting)state.code?.chunked(4)?.joinToString(" ").orEmpty() else ""
        if(code.text.toString()!=value)code.text=value
        code.visibility=if(waiting)View.VISIBLE else View.GONE;remaining.visibility=code.visibility
        remaining.text=if(waiting)context.getString(R.string.pairing_remaining,state.seconds) else ""
        val message=when(state.phase){
            VehiclePairingPhase.UNAVAILABLE->R.string.pairing_unavailable
            VehiclePairingPhase.IDLE->R.string.pairing_idle
            VehiclePairingPhase.CREATING->R.string.pairing_creating
            VehiclePairingPhase.WAITING->R.string.pairing_waiting
            VehiclePairingPhase.CONNECTED->R.string.pairing_connected
            VehiclePairingPhase.EXPIRED->R.string.pairing_expired
            VehiclePairingPhase.FAILED->R.string.pairing_failed
        }
        val text=context.getString(message);if(status.text.toString()!=text)status.text=text
        startButton.isEnabled=canInteract&&state.phase in setOf(VehiclePairingPhase.IDLE,VehiclePairingPhase.EXPIRED,VehiclePairingPhase.FAILED)
        startButton.alpha=if(startButton.isEnabled)1f else .45f
        clearButton.visibility=if(canInteract&&state.phase in setOf(VehiclePairingPhase.CREATING,VehiclePairingPhase.WAITING,VehiclePairingPhase.CONNECTED))View.VISIBLE else View.GONE
        clearButton.isEnabled=canInteract
        clearButton.setText(if(state.phase==VehiclePairingPhase.CONNECTED)R.string.pairing_clear else R.string.pairing_cancel)
    }
}
