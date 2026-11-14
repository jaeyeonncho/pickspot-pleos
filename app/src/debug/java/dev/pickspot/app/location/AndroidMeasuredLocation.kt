package dev.pickspot.app.location

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Looper
import androidx.core.content.ContextCompat
import dev.pickspot.app.domain.*
import dev.pickspot.app.navigation.PleosNavigator

class AndroidMeasuredLocation(context:Context):MeasuredLocationReader {
    private val context=context.applicationContext
    private val manager=this.context.getSystemService(LocationManager::class.java)
    private var listener:LocationListener?=null
    override fun hasPermission()=ContextCompat.checkSelfPermission(context,Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED
    override fun isAvailable()=runCatching { LocationManager.GPS_PROVIDER in manager.allProviders&&manager.isProviderEnabled(LocationManager.GPS_PROVIDER) }.getOrDefault(false)
    @SuppressLint("MissingPermission")
    override fun start(onSample:(MeasuredVehicleSample)->Unit,onUnavailable:()->Unit){
        stop();check(hasPermission()&&isAvailable())
        val events=object:LocationListener {
            override fun onLocationChanged(value:Location){onSample(MeasuredVehicleSample(value.latitude,value.longitude,value.time,
                value.elapsedRealtimeNanos/1_000_000,value.accuracy.takeIf { value.hasAccuracy() }))}
            override fun onProviderDisabled(provider:String){onUnavailable()}
            override fun onProviderEnabled(provider:String)=Unit
            @Deprecated("Older providers") override fun onStatusChanged(provider:String?,status:Int,extras:Bundle?)=Unit
        }
        listener=events
        manager.requestLocationUpdates(LocationManager.GPS_PROVIDER,1000,0f,events,Looper.getMainLooper())
        manager.getLastKnownLocation(LocationManager.GPS_PROVIDER)?.let(events::onLocationChanged)
    }
    override fun stop(){listener?.let { runCatching{manager.removeUpdates(it)} };listener=null}
}

/** Wraps existing serial Pleos reads. No navigation write is exposed to the screen. */
class PleosVehicleRouteReader(context:Context):VehicleRouteReader {
    private val context=context.applicationContext
    private var navigator:PleosNavigator?=null
    private var callback:((NavigationState)->Unit)?=null
    private var connected=false
    override fun start(onState:(NavigationState)->Unit){
        stop();callback=onState
        navigator=PleosNavigator(context).also { adapter ->
            adapter.onState={connected=it.connected;onState(it)}
            adapter.setInteractionAllowed(false);adapter.connect()
        }
    }
    override fun refresh(){if(connected)navigator?.refreshRoute() else callback?.let(::start)}
    override fun stop(){navigator?.onState=null;navigator?.close();navigator=null;callback=null;connected=false}
}
