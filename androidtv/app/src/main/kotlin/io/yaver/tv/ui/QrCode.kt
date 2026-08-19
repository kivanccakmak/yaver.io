package io.yaver.tv.ui

import android.graphics.Bitmap
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.BarcodeFormat

/** Render a string as a QR [ImageBitmap] (zxing core, mirror of the tvOS
 *  CIFilter.qrCodeGenerator usage). White background, black modules. */
fun renderQr(content: String, sizePx: Int = 320): ImageBitmap {
    val matrix = QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, sizePx, sizePx)
    val bitmap = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.RGB_565)
    val white = 0xFFFFFFFF.toInt()
    val black = 0xFF000000.toInt()
    for (x in 0 until sizePx) {
        for (y in 0 until sizePx) {
            bitmap.setPixel(x, y, if (matrix[x, y]) black else white)
        }
    }
    return bitmap.asImageBitmap()
}
