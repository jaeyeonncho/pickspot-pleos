package dev.pickspot.app.sharing

import android.os.Bundle
import android.widget.Button
import androidx.activity.ComponentActivity
import androidx.activity.viewModels
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.pickspot.app.R
import dev.pickspot.app.driving.PleosDrivingAccess
import dev.pickspot.app.presentation.*
import kotlinx.coroutines.launch

class SharingActivity : ComponentActivity() {
    private val drivingAccess by lazy { PleosDrivingAccess(this) }
    private val model: SharingViewModel by viewModels { viewModelFactory { initializer { SharingViewModel(LocalSharingRepository.get(applicationContext)) } } }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); setContentView(R.layout.activity_sharing)
        findViewById<Button>(R.id.sharing_create).setOnClickListener { model.create() }
        findViewById<Button>(R.id.sharing_retry).setOnClickListener { model.retry() }
        findViewById<Button>(R.id.sharing_end).setOnClickListener { model.end() }
        findViewById<Button>(R.id.sharing_back).setOnClickListener { finish() }
        val screen = SharingScreen(this, findViewById(android.R.id.content))
        lifecycleScope.launch { repeatOnLifecycle(Lifecycle.State.STARTED) { model.state.collect(screen::render) } }
    }
    override fun onStart() { super.onStart(); drivingAccess.start(model::updateDrivingAccess); model.onForeground() }
    override fun onStop() { drivingAccess.stop(); model.onBackground(); super.onStop() }
    override fun onDestroy() { drivingAccess.stop(); super.onDestroy() }
}
