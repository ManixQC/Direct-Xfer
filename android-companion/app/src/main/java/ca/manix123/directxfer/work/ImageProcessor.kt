package ca.manix123.directxfer.work

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import androidx.exifinterface.media.ExifInterface
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

object ImageProcessor {
    data class Prepared(
        val full: File,
        val thumb: File,
        val micro: File,
        val width: Int,
        val height: Int,
        val uploadName: String,
        val temporaryFiles: List<File>
    )

    /** Item 13: [fullMax]/[thumbMax]/[microMax] cap each variant's longest side and
     *  [quality] drives JPEG compression (thumb/micro derive slightly lower quality). */
    fun prepare(
        source: File,
        displayName: String,
        cleanExif: Boolean,
        workDir: File,
        fullMax: Int = 4096,
        thumbMax: Int = 1280,
        microMax: Int = 640,
        quality: Int = 93
    ): Prepared {
        workDir.mkdirs()
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(source.absolutePath, bounds)
        require(bounds.outWidth > 0 && bounds.outHeight > 0) { "image-non-decodable" }

        val fullQuality = quality.coerceIn(40, 100)
        val thumbQuality = (fullQuality - 5).coerceIn(50, 100)
        val microQuality = (fullQuality - 11).coerceIn(45, 100)

        val orientation = try { ExifInterface(source).rotationDegrees } catch (_: Exception) { 0 }
        val decoded = decodeBounded(source, fullMax.coerceAtLeast(256))
        val rotated = rotate(decoded, orientation)
        if (rotated !== decoded) decoded.recycle()
        val width = rotated.width
        val height = rotated.height

        val temp = mutableListOf<File>()
        val full: File
        val uploadName: String
        if (cleanExif) {
            val hasAlpha = rotated.hasAlpha()
            val ext = if (hasAlpha) "png" else "jpg"
            full = File(workDir, "full.$ext")
            FileOutputStream(full).use {
                rotated.compress(if (hasAlpha) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, fullQuality, it)
            }
            temp += full
            uploadName = displayName.substringBeforeLast('.', displayName) + ".$ext"
        } else {
            full = source
            uploadName = displayName
        }

        val thumbBitmap = scaleInside(rotated, thumbMax.coerceAtLeast(128))
        val thumb = File(workDir, "mini.jpg")
        FileOutputStream(thumb).use { thumbBitmap.compress(Bitmap.CompressFormat.JPEG, thumbQuality, it) }
        temp += thumb
        if (thumbBitmap !== rotated) thumbBitmap.recycle()

        val microBitmap = scaleInside(rotated, microMax.coerceAtLeast(64))
        val micro = File(workDir, "micro.jpg")
        FileOutputStream(micro).use { microBitmap.compress(Bitmap.CompressFormat.JPEG, microQuality, it) }
        temp += micro
        if (microBitmap !== rotated) microBitmap.recycle()
        rotated.recycle()

        return Prepared(full, thumb, micro, width, height, uploadName, temp)
    }

    private fun decodeBounded(file: File, maxSide: Int): Bitmap {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        var sample = 1
        while (max(bounds.outWidth / sample, bounds.outHeight / sample) > maxSide * 2) sample *= 2
        val bitmap = BitmapFactory.decodeFile(file.absolutePath, BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
        })
        return requireNotNull(bitmap) { "image-non-decodable" }
    }

    private fun rotate(bitmap: Bitmap, degrees: Int): Bitmap {
        if (degrees % 360 == 0) return bitmap
        val matrix = Matrix().apply { postRotate(degrees.toFloat()) }
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    }

    private fun scaleInside(bitmap: Bitmap, maxSide: Int): Bitmap {
        val biggest = max(bitmap.width, bitmap.height)
        if (biggest <= maxSide) return bitmap
        val ratio = maxSide.toDouble() / biggest.toDouble()
        val w = (bitmap.width * ratio).roundToInt().coerceAtLeast(1)
        val h = (bitmap.height * ratio).roundToInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(bitmap, w, h, true)
    }
}
