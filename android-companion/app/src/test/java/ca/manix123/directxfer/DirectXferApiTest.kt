package ca.manix123.directxfer

import ca.manix123.directxfer.net.DirectXferApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/** Item 23: unit coverage for the pure URL/token parsing used before any upload. */
class DirectXferApiTest {

    @Test
    fun normalizeServer_addsHttpsScheme() {
        assertEquals("https://xfer.manix123.ca", DirectXferApi.normalizeServer("xfer.manix123.ca"))
    }

    @Test
    fun normalizeServer_stripsPathAndTrailingSlash() {
        assertEquals("https://example.com", DirectXferApi.normalizeServer("https://example.com/some/path/"))
    }

    @Test
    fun normalizeServer_keepsExplicitPort() {
        assertEquals("https://example.com:8443", DirectXferApi.normalizeServer("https://example.com:8443/app"))
    }

    @Test
    fun normalizeServer_rejectsNonHttps() {
        assertThrows(IllegalArgumentException::class.java) {
            DirectXferApi.normalizeServer("http://example.com")
        }
    }

    @Test
    fun parseReceptionLink_acceptsBareToken() {
        val (server, token) = DirectXferApi.parseReceptionLink("abcdEFGH1234", "https://example.com")
        assertEquals("https://example.com", server)
        assertEquals("abcdEFGH1234", token)
    }

    @Test
    fun parseReceptionLink_parsesFullUrl() {
        val (server, token) = DirectXferApi.parseReceptionLink("https://host.example/u/TokenABC123", null)
        assertEquals("https://host.example", server)
        assertEquals("TokenABC123", token)
    }

    @Test
    fun parseReceptionLink_parsesUrlWithPort() {
        val (server, token) = DirectXferApi.parseReceptionLink("https://host.example:9443/u/Zzz12345_ok", null)
        assertEquals("https://host.example:9443", server)
        assertEquals("Zzz12345_ok", token)
    }

    @Test
    fun parseReceptionLink_rejectsNonReceptionPath() {
        assertThrows(IllegalArgumentException::class.java) {
            DirectXferApi.parseReceptionLink("https://host.example/x/TokenABC123", null)
        }
    }

    @Test
    fun parseReceptionLink_rejectsGarbage() {
        assertThrows(IllegalArgumentException::class.java) {
            DirectXferApi.parseReceptionLink("not a url", null)
        }
    }
}
