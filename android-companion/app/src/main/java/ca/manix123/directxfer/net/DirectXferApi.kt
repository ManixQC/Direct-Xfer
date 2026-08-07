package ca.manix123.directxfer.net

import ca.manix123.directxfer.security.SecureStore
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

class DirectXferApi(private val store: SecureStore) {
    data class LoginResult(val server: String, val token: String, val csrf: String, val deviceName: String)
    data class ImageResult(val token: String, val fullUrl: String, val thumbUrl: String, val microUrl: String)

    fun login(serverInput: String, username: String, password: String, totp: String, deviceName: String): LoginResult {
        val server = normalizeServer(serverInput)
        val body = JSONObject().apply {
            put("username", username)
            put("password", password)
            put("totp", totp)
            put("deviceName", deviceName)
        }.toString().toByteArray(StandardCharsets.UTF_8)
        val conn = open("$server/app/companion/login", "POST", authorized = false)
        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
        conn.setFixedLengthStreamingMode(body.size)
        conn.doOutput = true
        BufferedOutputStream(conn.outputStream).use { it.write(body) }
        val json = readJson(conn)
        if (conn.responseCode !in 200..299) throw ApiException(conn.responseCode, json.optString("error", "login-failed"))
        return LoginResult(
            server = normalizeServer(json.optString("server", server)),
            token = json.getString("deviceToken"),
            csrf = json.getString("csrf"),
            deviceName = json.optJSONObject("device")?.optString("name", deviceName) ?: deviceName
        )
    }

    fun status(): JSONObject {
        val conn = open("${requiredServer()}/app/device/status", "GET", authorized = true)
        return readJsonChecked(conn)
    }

    fun revokeThisDevice(revokeShares: Boolean = false) {
        val body = JSONObject().put("revokeShares", revokeShares).toString().toByteArray(StandardCharsets.UTF_8)
        val conn = open("${requiredServer()}/app/device/revoke", "POST", authorized = true, mutating = true)
        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
        conn.setFixedLengthStreamingMode(body.size)
        conn.doOutput = true
        conn.outputStream.use { it.write(body) }
        readJsonChecked(conn)
    }

    fun findImageByUploadId(uploadId: String): ImageResult? {
        val conn = open("${requiredServer()}/app/image/upload/${enc(uploadId)}", "GET", authorized = true)
        val json = readJson(conn)
        if (conn.responseCode == 404) return null
        if (conn.responseCode !in 200..299) throw ApiException(conn.responseCode, json.optString("error", "image-lookup-failed"))
        return ImageResult(
            token = json.getString("token"),
            fullUrl = json.getString("imgUrl"),
            thumbUrl = json.getString("thumbUrl"),
            microUrl = json.getString("microUrl")
        )
    }

    fun createImage(file: File, uploadName: String, width: Int, height: Int, uploadId: String, metadataRemoved: Boolean, onProgress: (Long, Long) -> Unit): ImageResult {
        val query = "name=${enc(uploadName)}&w=$width&h=$height&uploadId=${enc(uploadId)}" + if (metadataRemoved) "&metadataRemoved=1" else ""
        val json = uploadRaw("${requiredServer()}/app/image?$query", file, "application/octet-stream", onProgress)
        return ImageResult(
            token = json.getString("token"),
            fullUrl = json.getString("imgUrl"),
            thumbUrl = json.getString("thumbUrl"),
            microUrl = json.getString("microUrl")
        )
    }

    fun uploadImageVariant(token: String, variant: String, file: File, onProgress: (Long, Long) -> Unit = { _, _ -> }) {
        require(variant == "thumb" || variant == "micro")
        uploadRaw("${requiredServer()}/app/image/${enc(token)}/$variant", file, "image/jpeg", onProgress)
    }

    fun receptionOffset(server: String, token: String, uploadId: String): Long {
        val conn = open("${normalizeServer(server)}/u/${enc(token)}/upload-status?id=${enc(uploadId)}", "GET", authorized = false)
        val json = readJson(conn)
        if (conn.responseCode !in 200..299) throw ApiException(conn.responseCode, json.optString("error", "upload-status-failed"))
        return json.optLong("offset", 0L).coerceAtLeast(0L)
    }

    fun uploadReceptionChunk(
        server: String,
        token: String,
        uploadId: String,
        file: File,
        offset: Long,
        chunkSize: Int,
        onProgress: (Long, Long) -> Unit
    ): JSONObject {
        val total = file.length()
        val toSend = minOf(chunkSize.toLong(), total - offset).coerceAtLeast(0L)
        val url = normalizeServer(server) + "/u/${enc(token)}/upload?path=${enc(file.name)}&id=${enc(uploadId)}&size=$total&offset=$offset"
        val conn = open(url, "POST", authorized = false)
        conn.setRequestProperty("Content-Type", "application/octet-stream")
        conn.setRequestProperty("Cache-Control", "no-store")
        conn.setFixedLengthStreamingMode(toSend)
        conn.doOutput = true
        file.inputStream().use { raw ->
            raw.skipFully(offset)
            BufferedInputStream(raw).use { input ->
                BufferedOutputStream(conn.outputStream).use { output ->
                    copyLimited(input, output, toSend) { sent, _ -> onProgress(offset + sent, total) }
                }
            }
        }
        val json = readJson(conn)
        if (conn.responseCode in 200..299 || conn.responseCode == 409 && json.optString("error") == "incomplete") return json
        throw ApiException(conn.responseCode, json.optString("error", "upload-failed"))
    }

    fun uploadReception(server: String, token: String, uploadId: String, file: File, onProgress: (Long, Long) -> Unit) {
        var offset = receptionOffset(server, token, uploadId).coerceAtMost(file.length())
        val chunk = 4 * 1024 * 1024
        while (offset < file.length()) {
            val response = uploadReceptionChunk(server, token, uploadId, file, offset, chunk, onProgress)
            val complete = response.optBoolean("complete", false) || response.optBoolean("ok", false) && response.optString("error").isBlank()
            if (complete && offset + chunk >= file.length()) return
            val next = response.optLong("offset", -1L)
            offset = if (next >= 0) next else receptionOffset(server, token, uploadId)
            if (offset <= 0L && file.length() > 0L && response.optString("error") != "incomplete") {
                throw ApiException(409, "upload-offset-invalid")
            }
        }
    }

    private fun uploadRaw(url: String, file: File, contentType: String, onProgress: (Long, Long) -> Unit): JSONObject {
        val conn = open(url, "POST", authorized = true, mutating = true)
        conn.setRequestProperty("Content-Type", contentType)
        conn.setRequestProperty("Cache-Control", "no-store")
        conn.setFixedLengthStreamingMode(file.length())
        conn.doOutput = true
        file.inputStream().use { input ->
            BufferedOutputStream(conn.outputStream).use { output ->
                copyLimited(input, output, file.length(), onProgress)
            }
        }
        return readJsonChecked(conn)
    }

    private fun open(url: String, method: String, authorized: Boolean, mutating: Boolean = false): HttpURLConnection {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 20_000
        conn.readTimeout = 90_000
        conn.instanceFollowRedirects = false
        conn.useCaches = false
        conn.setRequestProperty("Accept", "application/json")
        conn.setRequestProperty("User-Agent", "Direct-Xfer-Android/1.1")
        if (authorized) {
            conn.setRequestProperty("Authorization", "Bearer ${store.deviceToken ?: throw IllegalStateException("not-paired")}")
            if (mutating) conn.setRequestProperty("X-CSRF-Token", store.csrf ?: throw IllegalStateException("missing-csrf"))
        }
        return conn
    }

    private fun readJsonChecked(conn: HttpURLConnection): JSONObject {
        val json = readJson(conn)
        if (conn.responseCode !in 200..299) throw ApiException(conn.responseCode, json.optString("error", "http-${conn.responseCode}"))
        return json
    }

    private fun readJson(conn: HttpURLConnection): JSONObject {
        val stream: InputStream? = try {
            if (conn.responseCode in 200..399) conn.inputStream else conn.errorStream
        } catch (_: Exception) { conn.errorStream }
        val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
        return try { if (text.isBlank()) JSONObject() else JSONObject(text) }
        catch (_: Exception) { JSONObject().put("raw", text.take(1000)) }
    }

    private fun requiredServer() = store.serverUrl ?: throw IllegalStateException("not-paired")

    companion object {
        fun normalizeServer(input: String): String {
            val raw = input.trim().trimEnd('/')
            val withScheme = if (raw.startsWith("https://", true)) raw else "https://$raw"
            val uri = URI(withScheme)
            require(uri.scheme.equals("https", true) && !uri.host.isNullOrBlank()) { "Une URL HTTPS valide est requise." }
            val port = if (uri.port > 0) ":${uri.port}" else ""
            return "https://${uri.host}$port"
        }

        fun parseReceptionLink(input: String, defaultServer: String?): Pair<String, String> {
            val raw = input.trim()
            val tokenOnly = Regex("^[A-Za-z0-9_-]{12,128}$")
            if (tokenOnly.matches(raw)) return Pair(defaultServer ?: error("Serveur manquant"), raw)
            val uri = URI(raw)
            require(uri.scheme.equals("https", true) && !uri.host.isNullOrBlank()) { "Lien HTTPS invalide" }
            val segments = uri.path.split('/').filter { it.isNotBlank() }
            val index = segments.indexOfFirst { it == "u" }
            require(index >= 0 && index + 1 < segments.size) { "Ce n'est pas un lien de réception /u/." }
            val server = "https://${uri.host}" + if (uri.port > 0) ":${uri.port}" else ""
            return Pair(server, segments[index + 1])
        }

        private fun enc(value: String) = URLEncoder.encode(value, StandardCharsets.UTF_8.name())
        private fun InputStream.skipFully(bytes: Long) {
            var left = bytes
            while (left > 0) {
                val skipped = skip(left)
                if (skipped <= 0) {
                    if (read() < 0) throw IllegalStateException("unexpected-eof")
                    left--
                } else left -= skipped
            }
        }

        private fun copyLimited(input: InputStream, output: java.io.OutputStream, limit: Long, progress: (Long, Long) -> Unit) {
            val buffer = ByteArray(128 * 1024)
            var sent = 0L
            while (sent < limit) {
                val wanted = minOf(buffer.size.toLong(), limit - sent).toInt()
                val read = input.read(buffer, 0, wanted)
                if (read < 0) break
                output.write(buffer, 0, read)
                sent += read
                progress(sent, limit)
            }
            output.flush()
            if (sent != limit) throw IllegalStateException("unexpected-eof")
        }
    }
}

class ApiException(val status: Int, override val message: String) : Exception(message)
