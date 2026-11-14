package dev.pickspot.app.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.util.AttributeSet
import android.view.View
import dev.pickspot.app.R
import dev.pickspot.app.domain.*

/** A replaceable illustration component, not a road map. Geometry is prepared outside onDraw. */
class MeetingSketchView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {
    private data class Marker(val id: String, val x: Float, val y: Float)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val density = resources.displayMetrics.density
    private val dash = DashPathEffect(floatArrayOf(8 * density, 8 * density), 0f)
    private val ink = context.getColor(R.color.accent)
    private val backgroundInk = context.getColor(R.color.sketch_surface)
    private val gridInk = context.getColor(R.color.sketch_grid)
    private val markerInk = context.getColor(R.color.sketch_marker)
    private val white = context.getColor(R.color.on_surface)
    private val muted = context.getColor(R.color.muted)
    private val passengerLabel = context.getString(R.string.passenger)
    private val caption = context.getString(R.string.sketch_caption)
    private var session: PickupSession? = null
    private var selected: PickupCandidate? = null
    private var markers = emptyList<Marker>()
    private var passenger = Marker("", 0f, 0f)

    fun bind(session: PickupSession, selected: PickupCandidate) {
        this.session = session
        this.selected = selected
        prepareGeometry()
        invalidate()
    }
    fun clear() { session = null; selected = null; markers = emptyList(); passenger = Marker("", 0f, 0f); invalidate() }
    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) { prepareGeometry() }
    private fun prepareGeometry() {
        val session = session ?: return
        val passengerPoint = session.passengerPoint ?: return
        val candidates = session.candidates.filter { it.curbStatus != CurbStatus.RESTRICTED }
        val points = candidates.map { it.point } + passengerPoint
        val minLat = points.minOf { it.latitude }; val maxLat = points.maxOf { it.latitude }
        val minLon = points.minOf { it.longitude }; val maxLon = points.maxOf { it.longitude }
        val pad = minOf(70f * density, width / 4f, height / 3f)
        fun marker(id: String, point: GeoPoint): Marker {
            val x = if (maxLon == minLon) 0.5 else (point.longitude - minLon) / (maxLon - minLon)
            val y = if (maxLat == minLat) 0.5 else (point.latitude - minLat) / (maxLat - minLat)
            return Marker(id, (pad + x * (width - pad * 2)).toFloat(), (height - pad - y * (height - pad * 2)).toFloat())
        }
        markers = candidates.map { marker(it.id.uppercase(), it.point) }
        passenger = marker("", passengerPoint)
    }
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.drawColor(backgroundInk)
        paint.color = gridInk; paint.strokeWidth = density
        for (i in 1..6) canvas.drawLine(width * i / 7f, 0f, width * i / 7f, height.toFloat(), paint)
        for (i in 1..4) canvas.drawLine(0f, height * i / 5f, width.toFloat(), height * i / 5f, paint)
        val active = selected ?: return
        val pickup = markers.firstOrNull { it.id.equals(active.id, ignoreCase = true) } ?: return
        paint.color = ink; paint.strokeWidth = 3 * density; paint.pathEffect = dash
        canvas.drawLine(passenger.x, passenger.y, pickup.x, pickup.y, paint)
        paint.pathEffect = null
        for (marker in markers) {
            paint.color = if (marker === pickup) ink else markerInk
            canvas.drawCircle(marker.x, marker.y, 15 * density, paint)
            paint.textSize = 18 * density; paint.textAlign = Paint.Align.CENTER
            canvas.drawText(marker.id, marker.x, marker.y - 23 * density, paint)
        }
        paint.color = white
        canvas.drawCircle(passenger.x, passenger.y, 10 * density, paint)
        paint.textAlign = Paint.Align.CENTER; paint.textSize = 18 * density
        canvas.drawText(passengerLabel, passenger.x, passenger.y - 22 * density, paint)
        paint.color = muted; paint.textAlign = Paint.Align.LEFT; paint.textSize = 14 * density
        canvas.drawText(caption, 14 * density, height - 14 * density, paint)
    }
}
