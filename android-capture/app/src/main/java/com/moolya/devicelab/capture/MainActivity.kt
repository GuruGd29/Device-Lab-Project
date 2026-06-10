package com.moolya.devicelab.capture

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat

/**
 * Home + config screen (spec §3: "Simple config screen ... SFU_SIGNALING_URL and camera_id").
 *
 * Responsibilities:
 *   · Edit + persist [CaptureConfig] (SFU base URL + camera_id) to SharedPreferences.
 *   · Request CAMERA (and, on API 33+, POST_NOTIFICATIONS for the FGS notification).
 *   · Start / stop the [PublisherService] foreground publisher.
 *   · Launch the fullscreen [QrOverlayActivity] aid on command.
 *   · Keep screen on + immersive while this mounted-phone UI is foreground.
 */
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        keepScreenOnAndImmersive(window)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Surface(modifier = Modifier.fillMaxSize()) {
                    CaptureScreen()
                }
            }
        }
    }
}

@Composable
private fun CaptureScreen() {
    val context = LocalContext.current
    val saved = remember { CaptureConfig.load(context) }

    var sfuUrl by rememberSaveable { mutableStateOf(saved.sfuSignalingUrl) }
    var cameraId by rememberSaveable { mutableStateOf(saved.cameraId) }
    var publishing by rememberSaveable { mutableStateOf(false) }
    var status by rememberSaveable { mutableStateOf("Idle") }

    // Permission launcher: request CAMERA (+ POST_NOTIFICATIONS on 33+) before publishing.
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { grants ->
        val cameraGranted = grants[Manifest.permission.CAMERA] == true ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        if (cameraGranted) {
            CaptureConfig.save(context, CaptureConfig(sfuUrl, cameraId))
            PublisherService.start(context)
            publishing = true
            status = "Publishing $cameraId → $sfuUrl"
        } else {
            status = "CAMERA permission denied — cannot publish"
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Device Lab Capture", style = MaterialTheme.typography.headlineSmall)
        Text(
            "Mounted capture phone — publishes the rear camera to the lab agent's SFU over WHIP.",
            style = MaterialTheme.typography.bodySmall,
        )
        Spacer(Modifier.height(8.dp))

        OutlinedTextField(
            value = sfuUrl,
            onValueChange = { sfuUrl = it },
            label = { Text("SFU_SIGNALING_URL (lab agent, local LAN)") },
            placeholder = { Text("http://192.168.1.50:8089") },
            singleLine = true,
            enabled = !publishing,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = cameraId,
            onValueChange = { cameraId = it },
            label = { Text("camera_id (matches registry Camera.camera_id)") },
            placeholder = { Text("cam-rack-A-03") },
            singleLine = true,
            enabled = !publishing,
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(Modifier.height(8.dp))

        if (!publishing) {
            Button(
                onClick = {
                    val config = CaptureConfig(sfuUrl, cameraId)
                    if (!config.isComplete) {
                        status = "Enter a valid http(s) URL and a real camera_id first"
                        return@Button
                    }
                    permissionLauncher.launch(requiredPermissions())
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Start publishing") }
        } else {
            Button(
                onClick = {
                    PublisherService.stop(context)
                    publishing = false
                    status = "Stopped"
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Stop publishing") }
        }

        OutlinedButton(
            onClick = {
                // Persist first so the overlay defaults to the current camera_id.
                CaptureConfig.save(context, CaptureConfig(sfuUrl, cameraId))
                context.startActivity(
                    Intent(context, QrOverlayActivity::class.java)
                        .putExtra(QrOverlayActivity.EXTRA_PAYLOAD, cameraId),
                )
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Show fullscreen QR (camera self-ID aid)") }

        Spacer(Modifier.height(16.dp))
        Text("Status", style = MaterialTheme.typography.labelLarge)
        Text(status, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
    }
}

/** CAMERA always; POST_NOTIFICATIONS too on API 33+ (foreground-service notification). */
private fun requiredPermissions(): Array<String> {
    val perms = mutableListOf(Manifest.permission.CAMERA)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        perms += Manifest.permission.POST_NOTIFICATIONS
    }
    return perms.toTypedArray()
}
