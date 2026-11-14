package dev.pickspot.app.debug

import android.content.Context
import android.view.View
import android.widget.*
import dev.pickspot.app.R
import dev.pickspot.app.domain.*
import dev.pickspot.app.presentation.*
import kotlin.math.ceil

class VehicleInputScreen(private val context:Context,private val root:View,onPreference:(DrivePreference?)->Unit){
    private val preferences=listOf<DrivePreference?>(null)+DrivePreference.entries
    private val spinner=root.findViewById<Spinner>(R.id.probe_preference)
    init {
        spinner.adapter=ArrayAdapter.createFromResource(context,R.array.probe_preferences,android.R.layout.simple_spinner_item)
            .also{it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)}
        spinner.onItemSelectedListener=object:AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent:AdapterView<*>?,view:View?,position:Int,id:Long){onPreference(preferences.getOrNull(position))}
            override fun onNothingSelected(parent:AdapterView<*>?)=Unit
        }
    }
    fun render(state:VehicleInputState){
        root.findViewById<TextView>(R.id.probe_driving).apply {
            visibility=if(state.canInteract)View.GONE else View.VISIBLE
            setText(if(state.access==DrivingAccess.RESTRICTED)R.string.driving_restricted else R.string.driving_unknown)
        }
        root.findViewById<View>(R.id.probe_content).visibility=if(state.canInteract)View.VISIBLE else View.GONE
        root.findViewById<TextView>(R.id.probe_status).setText(when(state.phase){
            MeasuredInputPhase.IDLE->R.string.probe_idle
            MeasuredInputPhase.WAITING->R.string.probe_waiting
            MeasuredInputPhase.FRESH->R.string.probe_fresh
            MeasuredInputPhase.INVALID->R.string.probe_invalid
            MeasuredInputPhase.STALE->R.string.probe_stale
            MeasuredInputPhase.TIMEOUT->R.string.probe_timeout
            MeasuredInputPhase.PERMISSION->R.string.probe_permission
            MeasuredInputPhase.UNAVAILABLE->R.string.probe_unavailable
            MeasuredInputPhase.STOPPED->R.string.probe_stopped
            MeasuredInputPhase.FINISHED->R.string.probe_finished
        })
        root.findViewById<TextView>(R.id.probe_details).text=state.accuracyMeters?.let {context.getString(R.string.probe_accuracy,ceil(it.toDouble()).toInt())}.orEmpty()
        root.findViewById<TextView>(R.id.probe_route).setText(when {
            !state.running->R.string.probe_route_idle
            state.navigation.issue==NavigationIssue.NO_DESTINATION->R.string.probe_route_missing
            state.navigation.issue==NavigationIssue.ROUTE_CONTEXT_STALE->R.string.probe_route_stale
            state.navigation.issue==NavigationIssue.INVALID_DESTINATION->R.string.probe_route_coordinates
            state.navigation.issue!=null->R.string.probe_route_error
            state.navigation.phase==NavigationPhase.READY->R.string.probe_route_ready
            else->R.string.probe_route_reading
        })
        root.findViewById<TextView>(R.id.probe_preparation).setText(when(state.preparation.issue){
            TripPreparationIssue.POSITION_REQUIRED,TripPreparationIssue.POSITION_STALE->R.string.probe_prepare_position
            TripPreparationIssue.ROUTE_REQUIRED,TripPreparationIssue.ROUTE_STALE->R.string.probe_prepare_route
            TripPreparationIssue.COORDINATE_UNAVAILABLE->R.string.probe_route_coordinates
            TripPreparationIssue.WAYPOINT_LIMIT->R.string.probe_prepare_limit
            TripPreparationIssue.INVALID_DESTINATION->R.string.probe_prepare_destination
            TripPreparationIssue.PREFERENCE_REQUIRED->R.string.probe_prepare_preference
            null->if(state.preparation.draft!=null)R.string.probe_prepared else R.string.probe_prepare_position
        })
        val selected=preferences.indexOf(state.preference)
        if(spinner.selectedItemPosition!=selected)spinner.setSelection(selected)
        spinner.isEnabled=state.canInteract
        root.findViewById<Button>(R.id.probe_start).isEnabled=state.canInteract&&!state.running
        root.findViewById<Button>(R.id.probe_stop).isEnabled=state.running
        root.findViewById<Button>(R.id.probe_route_refresh).isEnabled=state.canInteract&&state.running&&!state.navigation.busy
        for(id in listOf(R.id.probe_start,R.id.probe_stop,R.id.probe_route_refresh)) {
            root.findViewById<Button>(id).apply {alpha=if(isEnabled)1f else 0.45f}
        }
    }
}
