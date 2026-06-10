package com.moolya.devicelab.capture

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Fullscreen, high-contrast QR overlay (spec §3: "render fullscreen QR when asked").
 *
 * IMPORTANT (spec §5.1): the CANONICAL QR-handshake calibration renders the TV's `tv_id`
 * as a QR onto the TV's OWN screen (pushed via its control channel) and the lab agent scans
 * the camera feeds. This phone-side overlay is a SECONDARY aid / camera self-identification:
 * it lets the camera display its own `camera_id` (or an operator-supplied payload) so a human
 * or a feed scanner can confirm WHICH phone is which while racking/debugging.
 *
 * Launch with an optional EXTRA_PAYLOAD; defaults to the configured camera_id.
 * Tap anywhere to dismiss.
 */
class QrOverlayActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        keepScreenOnAndImmersive(window)

        val payload = intent.getStringExtra(EXTRA_PAYLOAD)
            ?.takeIf { it.isNotBlank() }
            ?: CaptureConfig.load(this).cameraId

        setContent { QrOverlay(payload = payload, onDismiss = { finish() }) }
    }

    companion object {
        const val EXTRA_PAYLOAD = "qr_payload"
    }
}

@Composable
private fun QrOverlay(payload: String, onDismiss: () -> Unit) {
    val configuration = LocalConfiguration.current
    val density = LocalDensity.current
    // Square QR sized to ~80% of the shorter screen dimension for a big, clean target.
    val shorterDp = minOf(configuration.screenWidthDp, configuration.screenHeightDp)
    val qrSideDp = (shorterDp * 0.8f).dp
    val qrSidePx = with(density) { qrSideDp.roundToPx() }.coerceAtLeast(256)

    val bitmap = remember(payload, qrSidePx) {
        QrEncoder.encode(payload, qrSidePx).asImageBitmap()
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.White) // pure white field maximises contrast for the scanner
            .clickable(onClick = onDismiss),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Image(
                bitmap = bitmap,
                contentDescription = "QR for $payload",
                contentScale = ContentScale.Fit,
                modifier = Modifier.size(qrSideDp),
            )
            Text(
                text = payload,
                color = Color.Black,
                fontSize = 18.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 16.dp),
            )
            Text(
                text = "Tap to dismiss",
                color = Color(0xFF666666),
                fontSize = 12.sp,
                modifier = Modifier.padding(top = 8.dp),
            )
        }
    }
}
