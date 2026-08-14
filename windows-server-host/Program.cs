using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

[assembly: AssemblyTitle("Direct-Xfer Server Host")]
[assembly: AssemblyDescription("Direct-Xfer background server host")]
[assembly: AssemblyCompany("Direct-Xfer")]
[assembly: AssemblyProduct("Direct-Xfer Server Host")]
[assembly: AssemblyCopyright("Copyright © Direct-Xfer 2026")]
[assembly: AssemblyVersion("1.59.2.0")]
[assembly: AssemblyFileVersion("1.59.2.0")]
[assembly: AssemblyInformationalVersion("1.59.2-serverhost1-csharp")]

namespace DirectXfer.WindowsServerHost
{
    internal static class Program
    {
        internal const string AppVersion = "1.59.2";
        internal const string RuntimeAppBuild = "1.59.2-launcher28-csharp";
        internal const string HostVersion = "1.59.2-serverhost1-csharp";
        internal const int DefaultPort = 55750;
        internal const int MaxFallbackPort = 55769;
        internal const int StartupReadyTimeoutMs = 30000;
        internal const string NodeVersion = "24.19.0";
        internal const string NodeExeSha256 = "3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237";
        internal const string MutexName = @"Local\DirectXferServerHostInstance";
        internal const string StopEventName = @"Local\DirectXferServerHostStop";

        [STAThread]
        private static int Main(string[] args)
        {
            bool createdNew;
            using (var mutex = new Mutex(true, MutexName, out createdNew))
            {
                if (!createdNew) return 0;
                try
                {
                    using (var host = new ServerHost()) return host.Run();
                }
                catch (Exception ex)
                {
                    ServerHost.WriteEmergencyLog(ex);
                    return 1;
                }
                finally { try { mutex.ReleaseMutex(); } catch { } }
            }
        }
    }

    internal sealed class LauncherConfig
    {
        public string version;
        public string dataDir;
        public string logsDir;
        public string inboxDir;
        public string hostRoot;
        public string imagesDir;
        public bool openBrowser;
        public string language;
    }

    internal sealed class HostSession
    {
        public int hostPid;
        public long hostStartedUtcTicks;
        public string hostPath;
        public int serverPid;
        public long serverStartedUtcTicks;
        public string nodePath;
        public int port;
        public string scheme;
        public string token;
        public string runtimeBuild;
        public string hostBuild;
    }

    internal sealed class ServerHost : IDisposable
    {
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
        private static readonly IDictionary<string, string> CriticalRuntimeSha256 =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                { "package.json", "2b28b057e27cab2502fc5358397d6e890daf2182b8d490fc8d8d66fe192cf757" },
                { "package-lock.json", "99273bcf7b0baea30b276673ec95d631b6c08cb5057e40b37cde4a8148ce19f2" },
                { "server.js", "7c2a8108ab4598ea519ba80f68b8e67bab60056ac6df70fe20fe7aa47c0b7b1d" },
                { "public/app.js", "3477fcd489c396a3b0d77940d72952b0c9742b778411bb31f4c9e42aad56e0b9" },
                { "pwa/app.js", "1dfd026278e2d562ffa92c7bb8ba4da2aef4aa9f8f662ddd111e18be71d1a546" },
                { "node_modules/express/package.json", "c7db3b72582355c80cdcef1ad7b2c9a8f53557550724c6bef8502e9818c2ebe7" }
            };

        private readonly EventWaitHandle _stopEvent;
        private readonly object _logSync = new object();
        private StreamWriter _logWriter;
        private Process _server;
        private LauncherConfig _config;
        private string _runtimeLogPath;
        private string _shutdownMarkerPath;
        private string _token;
        private string _scheme = "http";
        private int _port;
        private bool _expectedStop;
        private bool _disposed;

        internal ServerHost()
        {
            bool created;
            _stopEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.StopEventName, out created);
        }

        private static string BaseDirectory
        {
            get
            {
                var p = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                if (string.IsNullOrWhiteSpace(p)) p = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
                if (string.IsNullOrWhiteSpace(p)) p = Path.GetTempPath();
                return Path.Combine(p, "Direct-Xfer");
            }
        }
        private static string ConfigPath { get { return Path.Combine(BaseDirectory, "launcher-config.json"); } }
        private static string SessionPath { get { return Path.Combine(BaseDirectory, "launcher-session.json"); } }

        private static string PortableRoot
        {
            get
            {
                var overridden = Environment.GetEnvironmentVariable("DX_WINDOWS_PORTABLE_ROOT");
                if (!string.IsNullOrWhiteSpace(overridden)) return Path.GetFullPath(overridden.Trim());
                var exe = Assembly.GetExecutingAssembly().Location;
                if (!string.IsNullOrWhiteSpace(exe)) return Path.GetDirectoryName(exe);
                return Environment.CurrentDirectory;
            }
        }
        private static string RuntimeRoot { get { return Path.Combine(PortableRoot, "runtime"); } }
        private static string PortableNodePath { get { return Path.Combine(RuntimeRoot, "node", "node.exe"); } }
        private string LocalCaCertificatePath
        {
            get { return _config == null || string.IsNullOrWhiteSpace(_config.dataDir) ? null : Path.Combine(_config.dataDir, "tls", "local-ca-cert.pem"); }
        }

        internal int Run()
        {
            _config = LoadConfig();
            EnsureConfigDirectories(_config);
            var appDir = EnsureApplicationRuntime();
            var node = EnsureNode();
            _runtimeLogPath = Path.Combine(_config.logsDir, "Direct-Xfer-Windows.log");
            RotateLog(_runtimeLogPath, 10L * 1024 * 1024);
            _logWriter = new StreamWriter(new FileStream(_runtimeLogPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite),
                new UTF8Encoding(false)) { AutoFlush = true };
            AppendLog("[server-host] Direct-Xfer " + Program.AppVersion + " " + Program.HostVersion + " starting.");

            RecoverSavedSession();
            _port = ChooseRuntimePort();
            _token = RandomToken();
            _scheme = "http";
            _shutdownMarkerPath = Path.Combine(_config.dataDir, ".dx-windows-clean-shutdown");
            try { if (File.Exists(_shutdownMarkerPath)) File.Delete(_shutdownMarkerPath); } catch { }

            StartNode(appDir, node);
            if (!WaitUntilReady())
            {
                if (_expectedStop)
                {
                    AppendLog("[server-host] startup cancelled by stop request.");
                    return 0;
                }
                AppendLog("[server-host] server did not become ready before timeout.");
                _expectedStop = true;
                StopNode();
                return 1;
            }

            AppendLog("[server-host] server ready on " + _scheme + "://127.0.0.1:" + _port.ToString(CultureInfo.InvariantCulture));
            while (true)
            {
                if (_stopEvent.WaitOne(250))
                {
                    _expectedStop = true;
                    StopNode();
                    return 0;
                }
                try
                {
                    if (_server == null || _server.HasExited)
                    {
                        var code = _server != null ? _server.ExitCode : 1;
                        var clean = ConsumeCleanShutdownMarker();
                        AppendLog("[server-host] server exited with code " + code + (clean ? " (clean)." : "."));
                        return clean || code == 0 ? 0 : code;
                    }
                }
                catch { return 1; }
            }
        }

        private static LauncherConfig LoadConfig()
        {
            Exception last = null;
            foreach (var candidate in new[] { ConfigPath, ConfigPath + ".bak" })
            {
                try
                {
                    if (!File.Exists(candidate)) continue;
                    var cfg = Json.Deserialize<LauncherConfig>(File.ReadAllText(candidate, Encoding.UTF8));
                    if (cfg != null) return cfg;
                }
                catch (Exception ex) { last = ex; }
            }
            throw new InvalidDataException("Direct-Xfer launcher configuration is missing or invalid.", last);
        }

        private static void EnsureConfigDirectories(LauncherConfig cfg)
        {
            if (cfg == null) throw new InvalidDataException("Missing launcher configuration.");
            foreach (var path in new[] { cfg.dataDir, cfg.logsDir, cfg.inboxDir, cfg.imagesDir })
            {
                if (string.IsNullOrWhiteSpace(path)) throw new InvalidDataException("Empty folder path.");
                Directory.CreateDirectory(path);
            }
            if (string.IsNullOrWhiteSpace(cfg.hostRoot) || !Directory.Exists(cfg.hostRoot))
                throw new DirectoryNotFoundException("Invalid host root.");
        }

        private static IEnumerable<string> AppCandidates()
        {
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var env = Environment.GetEnvironmentVariable("DX_WINDOWS_APP_DIR");
            foreach (var value in new[] { env, Path.Combine(RuntimeRoot, "app") })
            {
                if (string.IsNullOrWhiteSpace(value)) continue;
                var full = Path.GetFullPath(value.Trim());
                if (seen.Add(full)) yield return full;
            }
        }

        private static string EnsureApplicationRuntime()
        {
            var failures = new List<string>();
            foreach (var candidate in AppCandidates())
            {
                string reason;
                if (TryValidateApplicationRuntime(candidate, out reason)) return candidate;
                failures.Add(candidate + " -> " + reason);
            }
            throw new InvalidDataException("Direct-Xfer application runtime is missing or invalid. " + string.Join("; ", failures.ToArray()));
        }

        private static bool TryValidateApplicationRuntime(string root, out string reason)
        {
            try
            {
                if (!Directory.Exists(root)) { reason = "folder not found"; return false; }
                var marker = Path.Combine(root, ".dx-runtime-build");
                if (!File.Exists(marker)) { reason = "missing runtime marker"; return false; }
                var markerValue = File.ReadAllText(marker, Encoding.ASCII).Trim();
                if (!string.Equals(markerValue, Program.RuntimeAppBuild, StringComparison.Ordinal))
                { reason = "runtime build mismatch"; return false; }

                foreach (var required in new[] { "package.json", "server.js", Path.Combine("public", "app.js"), Path.Combine("node_modules", "express", "package.json") })
                {
                    var file = Path.Combine(root, required);
                    if (!File.Exists(file) || new FileInfo(file).Length == 0) { reason = "missing or empty " + required; return false; }
                }
                var package = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(root, "package.json"), Encoding.UTF8));
                object value;
                var version = package != null && package.TryGetValue("version", out value) ? Convert.ToString(value, CultureInfo.InvariantCulture) : string.Empty;
                if (!string.Equals(version, Program.AppVersion, StringComparison.Ordinal)) { reason = "package version mismatch"; return false; }

                foreach (var pair in CriticalRuntimeSha256)
                {
                    var file = Path.Combine(root, pair.Key.Replace('/', Path.DirectorySeparatorChar));
                    if (!File.Exists(file)) { reason = "missing integrity file " + pair.Key; return false; }
                    var actual = TextFileSha256Normalized(file);
                    if (!string.Equals(actual, pair.Value, StringComparison.OrdinalIgnoreCase))
                    { reason = "integrity check failed for " + pair.Key + " (" + actual + ")"; return false; }
                }
                reason = string.Empty;
                return true;
            }
            catch (Exception ex) { reason = ex.GetType().Name + ": " + ex.Message; return false; }
        }

        private static string TextFileSha256Normalized(string path)
        {
            var text = File.ReadAllText(path, new UTF8Encoding(false, true)).Replace("\r\n", "\n").Replace("\r", "\n");
            using (var sha = SHA256.Create())
            {
                var hash = sha.ComputeHash(new UTF8Encoding(false).GetBytes(text));
                return BitConverter.ToString(hash).Replace("-", string.Empty).ToLowerInvariant();
            }
        }

        private static string FileSha256(string path)
        {
            using (var sha = SHA256.Create())
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
                return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", string.Empty).ToLowerInvariant();
        }

        private static IEnumerable<string> NodeCandidates()
        {
            yield return PortableNodePath;
            var external = Environment.GetEnvironmentVariable("DX_WINDOWS_NODE");
            if (!string.IsNullOrWhiteSpace(external))
            {
                string full = null;
                try { full = Path.GetFullPath(external.Trim()); } catch { }
                if (!string.IsNullOrWhiteSpace(full) && !string.Equals(full, Path.GetFullPath(PortableNodePath), StringComparison.OrdinalIgnoreCase))
                    yield return full;
            }
        }

        private static string EnsureNode()
        {
            foreach (var candidate in NodeCandidates()) if (NodeUsable(candidate)) return candidate;
            throw new FileNotFoundException("Valid pinned x64 Node.js runtime not found.");
        }

        private static bool NodeUsable(string path)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(path) || !Path.IsPathRooted(path) || !File.Exists(path)) return false;
                var full = Path.GetFullPath(path);
                if ((File.GetAttributes(full) & FileAttributes.ReparsePoint) != 0) return false;
                var length = new FileInfo(full).Length;
                if (length < 1024 * 1024 || length > 200L * 1024 * 1024 || !IsAmd64Pe(full)) return false;
                var bundled = string.Equals(full, Path.GetFullPath(PortableNodePath), StringComparison.OrdinalIgnoreCase);
                if (bundled)
                {
                    if (!string.Equals(FileSha256(full), Program.NodeExeSha256, StringComparison.OrdinalIgnoreCase)) return false;
                }
                else
                {
                    var expected = (Environment.GetEnvironmentVariable("DX_WINDOWS_NODE_SHA256") ?? string.Empty).Trim();
                    if (expected.Length != 64 || !expected.All(IsHexDigit) || !string.Equals(FileSha256(full), expected, StringComparison.OrdinalIgnoreCase)) return false;
                }
                using (var process = new Process())
                {
                    process.StartInfo = new ProcessStartInfo
                    {
                        FileName = full, Arguments = "--version", UseShellExecute = false, CreateNoWindow = true,
                        RedirectStandardOutput = true, RedirectStandardError = true, WindowStyle = ProcessWindowStyle.Hidden
                    };
                    if (!process.Start()) return false;
                    var stdout = process.StandardOutput.ReadToEndAsync();
                    var stderr = process.StandardError.ReadToEndAsync();
                    if (!process.WaitForExit(3000))
                    {
                        try { process.Kill(); } catch { }
                        try { process.WaitForExit(1000); } catch { }
                        return false;
                    }
                    if (!stdout.Wait(500)) return false;
                    try { stderr.Wait(100); } catch { }
                    var output = (stdout.Result ?? string.Empty).Trim().TrimStart('v');
                    Version parsed;
                    if (process.ExitCode != 0 || !Version.TryParse(output, out parsed)) return false;
                    if (!(parsed.Major == 20 || parsed.Major >= 22)) return false;
                    return !bundled || string.Equals(parsed.ToString(), Program.NodeVersion, StringComparison.Ordinal);
                }
            }
            catch { return false; }
        }

        private static bool IsHexDigit(char value)
        {
            return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f') || (value >= 'A' && value <= 'F');
        }

        private static bool IsAmd64Pe(string path)
        {
            try
            {
                using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
                using (var reader = new BinaryReader(stream))
                {
                    if (stream.Length < 0x100 || reader.ReadUInt16() != 0x5A4D) return false;
                    stream.Position = 0x3C;
                    var peOffset = reader.ReadInt32();
                    if (peOffset < 0x40 || peOffset > stream.Length - 24) return false;
                    stream.Position = peOffset;
                    if (reader.ReadUInt32() != 0x00004550) return false;
                    return reader.ReadUInt16() == 0x8664;
                }
            }
            catch { return false; }
        }

        private static int ChooseRuntimePort()
        {
            for (var port = Program.DefaultPort; port <= Program.MaxFallbackPort; port++)
            {
                TcpListener listener = null;
                try { listener = new TcpListener(IPAddress.Any, port); listener.Start(); return port; }
                catch (SocketException) { }
                finally { try { if (listener != null) listener.Stop(); } catch { } }
            }
            throw new InvalidOperationException("No free Direct-Xfer port was found.");
        }

        private static string RandomToken()
        {
            var bytes = new byte[24];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
            return BitConverter.ToString(bytes).Replace("-", string.Empty).ToLowerInvariant();
        }

        private void StartNode(string appDir, string node)
        {
            var start = new ProcessStartInfo
            {
                FileName = node, Arguments = "server.js", WorkingDirectory = appDir, UseShellExecute = false,
                CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            start.EnvironmentVariables["PORT"] = _port.ToString(CultureInfo.InvariantCulture);
            start.EnvironmentVariables["BIND"] = "0.0.0.0";
            start.EnvironmentVariables["DATA_DIR"] = _config.dataDir;
            start.EnvironmentVariables["INBOX_DIR"] = _config.inboxDir;
            start.EnvironmentVariables["HOST_ROOT"] = _config.hostRoot;
            start.EnvironmentVariables["IMAGES_DIR"] = _config.imagesDir;
            start.EnvironmentVariables["NO_COLOR"] = "1";
            start.EnvironmentVariables["DX_WINDOWS_LAUNCHER_TOKEN"] = _token;
            start.EnvironmentVariables["DX_WINDOWS_SHUTDOWN_MARKER"] = _shutdownMarkerPath;

            _server = new Process { StartInfo = start, EnableRaisingEvents = true };
            _server.OutputDataReceived += (s, e) => AppendLog(e.Data);
            _server.ErrorDataReceived += (s, e) => AppendLog(e.Data);
            if (!_server.Start()) throw new InvalidOperationException("Node.js did not start.");
            _server.BeginOutputReadLine();
            _server.BeginErrorReadLine();
            WriteSession(node);
        }

        private void WriteSession(string nodePath)
        {
            var host = Process.GetCurrentProcess();
            WriteSessionAtomic(new HostSession
            {
                hostPid = host.Id,
                hostStartedUtcTicks = GetProcessStartUtcTicks(host),
                hostPath = Assembly.GetExecutingAssembly().Location,
                serverPid = _server != null ? _server.Id : 0,
                serverStartedUtcTicks = GetProcessStartUtcTicks(_server),
                nodePath = nodePath,
                port = _port,
                scheme = _scheme,
                token = _token,
                runtimeBuild = Program.RuntimeAppBuild,
                hostBuild = Program.HostVersion
            });
        }

        private bool WaitUntilReady()
        {
            var watch = Stopwatch.StartNew();
            while (watch.ElapsedMilliseconds < Program.StartupReadyTimeoutMs)
            {
                try { if (_server == null || _server.HasExited) return false; } catch { return false; }
                string used;
                if (TryReady(_port, _token, _scheme, _server.Id, out used))
                {
                    _scheme = used;
                    WriteSession(_server.StartInfo.FileName);
                    return true;
                }
                if (_stopEvent.WaitOne(100)) { _expectedStop = true; StopNode(); return false; }
            }
            return false;
        }

        private bool TryReady(int port, string token, string preferredScheme, int expectedPid, out string usedScheme)
        {
            usedScheme = preferredScheme;
            foreach (var scheme in SchemeCandidates(preferredScheme))
            {
                try
                {
                    using (var response = LauncherRequest("GET", port, "/__dx_launcher/ready", token, scheme, 900, LocalCaCertificatePath))
                    using (var reader = new StreamReader(response.GetResponseStream() ?? Stream.Null))
                    {
                        var body = reader.ReadToEnd();
                        if ((int)response.StatusCode == 200 && body.Contains("\"ok\":true") && body.Contains("\"pid\":" + expectedPid.ToString(CultureInfo.InvariantCulture)))
                        { usedScheme = scheme; return true; }
                    }
                }
                catch { }
            }
            return false;
        }

        private static IEnumerable<string> SchemeCandidates(string preferred)
        {
            if (string.Equals(preferred, "https", StringComparison.OrdinalIgnoreCase)) { yield return "https"; yield return "http"; }
            else { yield return "http"; yield return "https"; }
        }

        private static HttpWebResponse LauncherRequest(string method, int port, string route, string token,
            string scheme, int timeoutMs, string localCaCertificatePath)
        {
            var request = (HttpWebRequest)WebRequest.Create(scheme + "://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture) + route);
            request.Method = method; request.Timeout = timeoutMs; request.ReadWriteTimeout = timeoutMs;
            request.AllowAutoRedirect = false; request.Proxy = null; request.KeepAlive = false;
            if (!string.IsNullOrEmpty(token)) request.Headers["X-Direct-Xfer-Launcher-Token"] = token;
            if (string.Equals(scheme, "https", StringComparison.OrdinalIgnoreCase))
                request.ServerCertificateValidationCallback = (sender, certificate, chain, errors) => ValidateServerCertificate(certificate, errors, localCaCertificatePath);
            return (HttpWebResponse)request.GetResponse();
        }

        private static bool ValidateServerCertificate(X509Certificate certificate, SslPolicyErrors errors, string localCaCertificatePath)
        {
            if (certificate == null) return false;
            if (errors == SslPolicyErrors.None) return true;
            if ((errors & (SslPolicyErrors.RemoteCertificateNameMismatch | SslPolicyErrors.RemoteCertificateNotAvailable)) != 0) return false;
            if ((errors & ~SslPolicyErrors.RemoteCertificateChainErrors) != 0) return false;
            X509Certificate2 localCa = null, leaf = null; X509Chain localChain = null;
            try
            {
                localCa = LoadPemCertificate(localCaCertificatePath); if (localCa == null) return false;
                leaf = new X509Certificate2(certificate); localChain = new X509Chain();
                localChain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
                localChain.ChainPolicy.VerificationFlags = X509VerificationFlags.AllowUnknownCertificateAuthority;
                localChain.ChainPolicy.ExtraStore.Add(localCa);
                if (!localChain.Build(leaf) || localChain.ChainElements.Count == 0) return false;
                var root = localChain.ChainElements[localChain.ChainElements.Count - 1].Certificate;
                return string.Equals(root.Thumbprint, localCa.Thumbprint, StringComparison.OrdinalIgnoreCase);
            }
            catch { return false; }
            finally { if (localChain != null) localChain.Dispose(); if (leaf != null) leaf.Dispose(); if (localCa != null) localCa.Dispose(); }
        }

        private static X509Certificate2 LoadPemCertificate(string path)
        {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return null;
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) return null;
            var info = new FileInfo(path); if (info.Length <= 0 || info.Length > 2L * 1024 * 1024) return null;
            var pem = File.ReadAllText(path, Encoding.ASCII);
            const string begin = "-----BEGIN CERTIFICATE-----", end = "-----END CERTIFICATE-----";
            var first = pem.IndexOf(begin, StringComparison.Ordinal);
            var last = pem.IndexOf(end, first >= 0 ? first + begin.Length : 0, StringComparison.Ordinal);
            if (first < 0 || last <= first) return null;
            var compact = new string(pem.Substring(first + begin.Length, last - first - begin.Length).Where(c => !char.IsWhiteSpace(c)).ToArray());
            return new X509Certificate2(Convert.FromBase64String(compact));
        }

        private void StopNode()
        {
            var server = _server;
            if (server == null) return;
            try { if (server.HasExited) return; } catch { return; }
            try
            {
                foreach (var scheme in SchemeCandidates(_scheme))
                {
                    try { using (LauncherRequest("POST", _port, "/__dx_launcher/shutdown", _token, scheme, 900, LocalCaCertificatePath)) { } break; }
                    catch { }
                }
            }
            catch { }
            try { if (server.WaitForExit(6500)) return; } catch { return; }
            try { server.Kill(); } catch { }
            try { server.WaitForExit(1200); } catch { }
        }

        private void RecoverSavedSession()
        {
            var session = ReadSession();
            if (session == null) return;
            string used;
            if (TryReady(session.port, session.token, session.scheme, session.serverPid, out used))
            {
                try { using (LauncherRequest("POST", session.port, "/__dx_launcher/shutdown", session.token, used, 800, LocalCaCertificatePath)) { } } catch { }
                if (WaitForProcessExit(session.serverPid, 3000)) { ClearSession(session.hostPid, session.serverPid); return; }
            }
            try
            {
                using (var process = Process.GetProcessById(session.serverPid))
                {
                    var actual = process.MainModule != null ? process.MainModule.FileName : null;
                    var sameExecutable = !string.IsNullOrWhiteSpace(actual) && !string.IsNullOrWhiteSpace(session.nodePath) &&
                        string.Equals(Path.GetFullPath(actual), Path.GetFullPath(session.nodePath), StringComparison.OrdinalIgnoreCase);
                    var sameStart = session.serverStartedUtcTicks > 0 && GetProcessStartUtcTicks(process) == session.serverStartedUtcTicks;
                    if (sameExecutable && sameStart) { process.Kill(); process.WaitForExit(1800); }
                }
            }
            catch { }
            ClearSession(session.hostPid, session.serverPid);
        }

        private static HostSession ReadSession()
        {
            try
            {
                if (!File.Exists(SessionPath)) return null;
                var session = Json.Deserialize<HostSession>(File.ReadAllText(SessionPath, Encoding.UTF8));
                return session != null && session.serverPid > 0 && session.port > 0 && !string.IsNullOrEmpty(session.token) ? session : null;
            }
            catch { return null; }
        }

        private static void WriteSessionAtomic(HostSession session)
        {
            Directory.CreateDirectory(BaseDirectory);
            var temp = SessionPath + ".tmp." + Guid.NewGuid().ToString("N");
            File.WriteAllText(temp, Json.Serialize(session), new UTF8Encoding(false));
            try
            {
                if (File.Exists(SessionPath)) File.Replace(temp, SessionPath, null, true); else File.Move(temp, SessionPath);
            }
            finally { try { if (File.Exists(temp)) File.Delete(temp); } catch { } }
        }

        private static void ClearSession(int hostPid, int serverPid)
        {
            try
            {
                var current = ReadSession();
                if (current != null)
                {
                    if (hostPid > 0 && current.hostPid != hostPid) return;
                    if (serverPid > 0 && current.serverPid != serverPid) return;
                }
                if (File.Exists(SessionPath)) File.Delete(SessionPath);
            }
            catch { }
        }

        private static long GetProcessStartUtcTicks(Process process)
        {
            try { return process != null ? process.StartTime.ToUniversalTime().Ticks : 0L; }
            catch { return 0L; }
        }

        private static bool WaitForProcessExit(int pid, int timeoutMs)
        {
            if (pid <= 0) return true;
            try { using (var process = Process.GetProcessById(pid)) return process.WaitForExit(timeoutMs); }
            catch { return true; }
        }

        private bool ConsumeCleanShutdownMarker()
        {
            try
            {
                if (string.IsNullOrWhiteSpace(_shutdownMarkerPath) || !File.Exists(_shutdownMarkerPath)) return false;
                File.Delete(_shutdownMarkerPath); return true;
            }
            catch { return false; }
        }

        private void AppendLog(string line)
        {
            if (line == null) return;
            lock (_logSync) { try { if (_logWriter != null) _logWriter.WriteLine(line); } catch { } }
        }

        internal static void WriteEmergencyLog(Exception ex)
        {
            try
            {
                Directory.CreateDirectory(BaseDirectory);
                File.AppendAllText(Path.Combine(BaseDirectory, "Direct-Xfer-ServerHost-error.log"),
                    DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) + " " + ex + Environment.NewLine, new UTF8Encoding(false));
            }
            catch { }
        }

        private static void RotateLog(string path, long maxBytes)
        {
            if (!File.Exists(path) || new FileInfo(path).Length < maxBytes) return;
            try { if (File.Exists(path + ".3")) File.Delete(path + ".3"); } catch { }
            TryMove(path + ".2", path + ".3"); TryMove(path + ".1", path + ".2"); TryMove(path, path + ".1");
        }

        private static void TryMove(string source, string destination)
        {
            try { if (File.Exists(source)) { if (File.Exists(destination)) File.Delete(destination); File.Move(source, destination); } } catch { }
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            try { if (_server != null && !_server.HasExited) { _expectedStop = true; StopNode(); } } catch { }
            try { ClearSession(Process.GetCurrentProcess().Id, _server != null ? _server.Id : 0); } catch { }
            try { if (_server != null) _server.Dispose(); } catch { }
            lock (_logSync)
            {
                try { if (_logWriter != null) _logWriter.Flush(); } catch { }
                try { if (_logWriter != null) _logWriter.Dispose(); } catch { }
                _logWriter = null;
            }
            try { _stopEvent.Dispose(); } catch { }
        }
    }
}
