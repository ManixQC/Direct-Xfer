using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Security;
using System.Net.Http;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;
using Microsoft.Win32;


namespace DirectXfer.WindowsServerHost
{
    internal static class Program
    {
        internal const string AppVersion = "1.65.1";
        internal const string RuntimeAppBuild = "1.65.1-launcher62-csharp";
        internal const string HostVersion = "1.65.1-serverhost35-csharp";
        internal const int DefaultPort = 55750;
        internal const int MaxFallbackPort = 55769;
        internal const int StartupReadyTimeoutMs = 30000;
        internal const int HealthProbeIntervalMs = 5000;
        internal const int HealthProbeFailureThreshold = 3;
        internal const long EmergencyLogMaxBytes = 2L * 1024 * 1024;
        internal const string NodeVersion = "24.19.0";
        internal const string NodeExeSha256 = "3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237";
        internal const string MutexName = @"Local\DirectXferServerHostInstance";
        internal const string StopEventName = @"Local\DirectXferServerHostStop";
        internal const string ReloadEventName = @"Local\DirectXferServerHostReload";

        internal static string ExecutablePath
        {
            get
            {
                var processPath = Environment.ProcessPath;
                if (!string.IsNullOrWhiteSpace(processPath)) return Path.GetFullPath(processPath);
                return Path.Combine(AppContext.BaseDirectory, "Direct-Xfer.ServerHost.exe");
            }
        }

        internal static string ExecutableDirectory
        {
            get
            {
                var directory = Path.GetDirectoryName(ExecutablePath);
                return !string.IsNullOrWhiteSpace(directory) ? directory : AppContext.BaseDirectory;
            }
        }

        [STAThread]
        private static int Main(string[] args)
        {
            using var mutex = new Mutex(true, MutexName, out var createdNew);
            if (!createdNew) return 0;
            try
            {
                using var host = new ServerHost();
                return host.Run();
            }
            catch (Exception ex)
            {
                ServerHost.WriteEmergencyLog(ex);
                return 1;
            }
            finally { try { mutex.ReleaseMutex(); } catch { } }
        }
    }

    internal sealed class LauncherConfig
    {
        public string version = string.Empty;
        public string dataDir = string.Empty;
        public string logsDir = string.Empty;
        public string inboxDir = string.Empty;
        public string hostRoot = string.Empty;
        public string imagesDir = string.Empty;
        public string language = string.Empty;
    }

    internal sealed class HostSession
    {
        public int hostPid;
        public long hostStartedUtcTicks;
        public string hostPath = string.Empty;
        public int serverPid;
        public long serverStartedUtcTicks;
        public string nodePath = string.Empty;
        public int port;
        public string scheme = string.Empty;
        public string token = string.Empty;
        public string runtimeBuild = string.Empty;
        public string hostBuild = string.Empty;
    }

    internal sealed class ServerHost : IDisposable
    {
        private static readonly JsonCompat Json = new();
        private static readonly IDictionary<string, string> CriticalRuntimeSha256 =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                { "package.json", "32409797a0ee0fe10efccf6ba695144dbe80de7c3fcc93275e76a74d9048792f" },
                { "package-lock.json", "09ebb7e9dbf3386a7b6fef4eeedff8cd5ec1d5a400d1680081874f804be1d65a" },
                { "server.js", "7b429f14563a3f6c5a0edc17c9155521c07c2b16e08189a728c53988c7c4f2c8" },
                { "lib/server/public-pages.js", "96954ccf1705f068c5579806c69f4f1d56916c2a803d1fc160be874c908f0615" },
                { "lib/server/tls-manager.js", "f71b5a70188948204ba6baef2e0e3d59c4433b15c86bfeb744451a53d4817881" },
                { "lib/server/network-services.js", "fd4a119ca1a75127b82c758c3d3555c12384c01b487bee3b3150a398217e4bdf" },
                { "lib/server/backup-service.js", "65cb07c147b326475a833be6cbc668db733fc8183ec0b4eec919a876b3f04bc2" },
                { "lib/server/notification-service.js", "a55beb8d5fdb09754eeb7f7d01974896efaad20dde3b9cf00e83bf4f7a7b9baa" },
                { "public/app.js", "d50010dbae1548634d8bf1f711d301cd1d20d6ca2e2b5b2f76dee5ae632e6350" },
                { "pwa/app.js", "f93da59d7d108176af39ba22b36d5d4700a31c55f55c61724d93aba3e9941e5b" },
                { "lib/dlp-utils.js", "dd4d15a3ebb1cc2e7183e9b68434cf69d50532f54fcbb9e90b5ffeb0cfdad086" },
                { "lib/fd-utils.js", "322abf15ce7a15310d6d27ac1b0ca40892658d5f21198510f7e84b78b0070b13" },
                { "pwa/dlp-local.js", "246267542621fc92f759438b2295b87f777ba6d6aa88b3c4d23dea25aebe7390" },
                { "node_modules/express/package.json", "c7db3b72582355c80cdcef1ad7b2c9a8f53557550724c6bef8502e9818c2ebe7" }
            };

        private readonly EventWaitHandle _stopEvent;
        private readonly EventWaitHandle _reloadEvent;
        private readonly object _logSync = new();
        private StreamWriter? _logWriter;
        private Process? _server;
        private LauncherConfig? _config;
        private string _runtimeLogPath = string.Empty;
        private string? _shutdownMarkerPath;
        private string? _token;
        private string _scheme = "http";
        private int _port;
        private bool _expectedStop;
        private bool _reloadRequested;
        private bool _systemEventsSubscribed;
        private bool _disposed;
        private long _lastReadyUptimeMs;

        internal ServerHost()
        {
            _stopEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.StopEventName, out _);
            _reloadEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ReloadEventName, out _);
            try
            {
                SystemEvents.SessionEnding += OnSessionEnding;
                _systemEventsSubscribed = true;
            }
            catch { _systemEventsSubscribed = false; }
        }

        private void OnSessionEnding(object sender, SessionEndingEventArgs e)
        {
            try { _stopEvent.Set(); } catch { }
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
                return Program.ExecutableDirectory;
            }
        }
        private static string RuntimeRoot { get { return Path.Combine(PortableRoot, "runtime"); } }
        private static string PortableNodePath { get { return Path.Combine(RuntimeRoot, "node", "node.exe"); } }
        private string? LocalCaCertificatePath
        {
            get { return _config == null || string.IsNullOrWhiteSpace(_config.dataDir) ? null : Path.Combine(_config.dataDir, "tls", "local-ca-cert.pem"); }
        }

        internal int Run()
        {
            if (!WaitForInitialConfig()) return _expectedStop ? 0 : 1;
            RecoverSavedSession();

            var consecutiveFailures = 0;
            while (true)
            {
                _expectedStop = false;
                _reloadRequested = false;
                _lastReadyUptimeMs = 0;
                int result;
                try
                {
                    result = RunConfiguredCycle();
                }
                catch (Exception ex)
                {
                    WriteEmergencyLog(ex);
                    AppendLog("[server-host] runtime cycle failed: " + ex.Message);
                    result = 1;
                }

                if (_expectedStop || result == 0) return 0;
                if (result == 75)
                {
                    consecutiveFailures = 0;
                    ResetForReload();
                    continue;
                }

                if (_lastReadyUptimeMs >= 60000) consecutiveFailures = 0;
                consecutiveFailures = Math.Min(consecutiveFailures + 1, 6);
                var delayMs = Math.Min(30000, 1000 * (1 << (consecutiveFailures - 1)));
                AppendLog("[server-host] backend stopped unexpectedly; retrying in " + delayMs.ToString(CultureInfo.InvariantCulture) + " ms.");
                ResetForReload();

                var signal = WaitHandle.WaitAny(new WaitHandle[] { _stopEvent, _reloadEvent }, delayMs);
                if (signal == 0)
                {
                    _expectedStop = true;
                    return 0;
                }
                if (signal == 1) consecutiveFailures = 0;
            }
        }

        private bool WaitForInitialConfig()
        {
            var nextDiagnosticUtc = DateTime.MinValue;
            while (true)
            {
                try
                {
                    _config = LoadConfig();
                    return true;
                }
                catch (Exception ex)
                {
                    if (!IsRetryableConfigException(ex)) throw;
                    if (DateTime.UtcNow >= nextDiagnosticUtc)
                    {
                        WriteEmergencyMessage("[server-host] waiting for a usable launcher configuration: " + ex.GetType().Name + ": " + ex.Message);
                        nextDiagnosticUtc = DateTime.UtcNow.AddSeconds(30);
                    }
                }

                if (_stopEvent.WaitOne(250))
                {
                    _expectedStop = true;
                    return false;
                }
                try { _reloadEvent.WaitOne(0); } catch { }
            }
        }

        private static bool IsRetryableConfigException(Exception ex)
        {
            return ex is InvalidDataException || ex is DirectoryNotFoundException || ex is UnauthorizedAccessException ||
                ex is IOException || ex is ArgumentException || ex is NotSupportedException;
        }

        private int RunConfiguredCycle()
        {
            _config = LoadConfig();
            var appDir = EnsureApplicationRuntime();
            var node = EnsureNode();
            OpenRuntimeLog();
            AppendLog("[server-host] Direct-Xfer " + Program.AppVersion + " " + Program.HostVersion + " starting runtime cycle.");

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
                if (_reloadRequested)
                {
                    AppendLog("[server-host] startup interrupted by configuration reload request.");
                    return 75;
                }
                AppendLog("[server-host] server did not become ready before timeout; the supervised backend will be restarted.");
                StopNode();
                return 1;
            }

            AppendLog("[server-host] server ready on " + _scheme + "://127.0.0.1:" + _port.ToString(CultureInfo.InvariantCulture));
            var readyWatch = Stopwatch.StartNew();
            var nextHealthProbeMs = (long)Program.HealthProbeIntervalMs;
            var consecutiveHealthFailures = 0;
            while (true)
            {
                var signal = WaitHandle.WaitAny(new WaitHandle[] { _stopEvent, _reloadEvent }, 250);
                if (signal == 0)
                {
                    _expectedStop = true;
                    StopNode();
                    return 0;
                }
                if (signal == 1)
                {
                    _reloadRequested = true;
                    AppendLog("[server-host] configuration reload requested.");
                    StopNode();
                    return 75;
                }
                try
                {
                    if (_server == null || _server.HasExited)
                    {
                        var code = _server != null ? _server.ExitCode : 1;
                        _lastReadyUptimeMs = readyWatch.ElapsedMilliseconds;
                        var clean = ConsumeCleanShutdownMarker();
                        AppendLog("[server-host] server exited with code " + code + (clean ? " (clean)." : "."));
                        return clean ? 0 : (code == 0 ? 1 : code);
                    }
                }
                catch
                {
                    _lastReadyUptimeMs = readyWatch.ElapsedMilliseconds;
                    return 1;
                }

                if (readyWatch.ElapsedMilliseconds >= nextHealthProbeMs)
                {
                    var server = _server;
                    var token = _token;
                    string usedScheme;
                    if (server != null && !string.IsNullOrEmpty(token) && TryReady(_port, token, _scheme, server.Id, out usedScheme))
                    {
                        _scheme = usedScheme;
                        consecutiveHealthFailures = 0;
                    }
                    else
                    {
                        consecutiveHealthFailures++;
                        AppendLog("[server-host] readiness health probe failed (" + consecutiveHealthFailures.ToString(CultureInfo.InvariantCulture) + "/" + Program.HealthProbeFailureThreshold.ToString(CultureInfo.InvariantCulture) + ").");
                        if (consecutiveHealthFailures >= Program.HealthProbeFailureThreshold)
                        {
                            _lastReadyUptimeMs = readyWatch.ElapsedMilliseconds;
                            AppendLog("[server-host] backend is alive but unresponsive; restarting supervised Node.js process.");
                            StopNode();
                            return 1;
                        }
                    }
                    nextHealthProbeMs = readyWatch.ElapsedMilliseconds + Program.HealthProbeIntervalMs;
                }
            }
        }

        private void OpenRuntimeLog()
        {
            var config = _config ?? throw new InvalidOperationException("Launcher configuration is not loaded.");
            var nextPath = Path.Combine(config.logsDir, "Direct-Xfer-Windows.log");
            lock (_logSync)
            {
                try { if (_logWriter != null) _logWriter.Dispose(); } catch { }
                _logWriter = null;
                _runtimeLogPath = nextPath;
                RotateLog(_runtimeLogPath, 10L * 1024 * 1024);
                _logWriter = new StreamWriter(new FileStream(_runtimeLogPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite),
                    new UTF8Encoding(false)) { AutoFlush = true };
            }
        }

        private void ResetForReload()
        {
            var oldServerPid = 0;
            try { oldServerPid = _server != null ? _server.Id : 0; } catch { }
            try { StopNode(); } catch { }
            try { ClearSession(Process.GetCurrentProcess().Id, oldServerPid); } catch { }
            try { if (_server != null) _server.Dispose(); } catch { }
            _server = null;
            _token = null;
            _scheme = "http";
            _port = 0;
            _shutdownMarkerPath = null;
        }

        private static LauncherConfig LoadConfig()
        {
            Exception? last = null;
            foreach (var candidate in new[] { ConfigPath, ConfigPath + ".bak" })
            {
                try
                {
                    if (!File.Exists(candidate)) continue;
                    var info = new FileInfo(candidate);
                    if (info.Length <= 0 || info.Length > 1024 * 1024) throw new InvalidDataException("Launcher configuration size is invalid.");
                    if ((File.GetAttributes(candidate) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Launcher configuration cannot be a reparse point.");
                    var cfg = Json.Deserialize<LauncherConfig>(File.ReadAllText(candidate, Encoding.UTF8))
                        ?? throw new InvalidDataException("Launcher configuration JSON is empty or invalid.");
                    NormalizeAndValidateConfig(cfg);
                    EnsureConfigDirectories(cfg);
                    if (!string.Equals(candidate, ConfigPath, StringComparison.OrdinalIgnoreCase)) RestorePrimaryConfigAtomic(cfg);
                    return cfg;
                }
                catch (Exception ex)
                {
                    if (!IsRetryableConfigException(ex)) throw;
                    last = ex;
                }
            }
            throw new InvalidDataException("Direct-Xfer launcher configuration is missing or invalid.", last);
        }

        private static void NormalizeAndValidateConfig(LauncherConfig? cfg)
        {
            if (cfg == null) throw new InvalidDataException("Missing launcher configuration.");
            cfg.dataDir = RequireAbsolutePath(cfg.dataDir, "dataDir");
            cfg.logsDir = RequireAbsolutePath(cfg.logsDir, "logsDir");
            cfg.inboxDir = RequireAbsolutePath(cfg.inboxDir, "inboxDir");
            cfg.imagesDir = RequireAbsolutePath(cfg.imagesDir, "imagesDir");
            cfg.hostRoot = RequireAbsolutePath(cfg.hostRoot, "hostRoot");
        }

        private static string RequireAbsolutePath(string value, string name)
        {
            if (string.IsNullOrWhiteSpace(value)) throw new InvalidDataException("Empty folder path: " + name + ".");
            var full = Path.GetFullPath(value.Trim());
            if (!Path.IsPathRooted(full)) throw new InvalidDataException("Folder path must be absolute: " + name + ".");
            return full;
        }

        private static void EnsureConfigDirectories(LauncherConfig cfg)
        {
            foreach (var path in new[] { cfg.dataDir, cfg.logsDir, cfg.inboxDir, cfg.imagesDir })
            {
                Directory.CreateDirectory(path);
                ProbeDirectoryWritable(path);
            }
            if (!Directory.Exists(cfg.hostRoot)) throw new DirectoryNotFoundException("Invalid host root.");
        }

        private static void ProbeDirectoryWritable(string path)
        {
            var probe = Path.Combine(path, ".dx-write-probe-" + Guid.NewGuid().ToString("N"));
            try
            {
                using (var stream = new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.None))
                    stream.WriteByte(0x44);
            }
            finally
            {
                try { if (File.Exists(probe)) File.Delete(probe); } catch { }
            }
        }

        private static void RestorePrimaryConfigAtomic(LauncherConfig cfg)
        {
            try
            {
                Directory.CreateDirectory(BaseDirectory);
                var temp = ConfigPath + ".restore." + Guid.NewGuid().ToString("N");
                File.WriteAllText(temp, Json.Serialize(cfg), new UTF8Encoding(false));
                try
                {
                    if (File.Exists(ConfigPath)) File.Replace(temp, ConfigPath, null, true);
                    else File.Move(temp, ConfigPath);
                }
                finally { try { if (File.Exists(temp)) File.Delete(temp); } catch { } }
                WriteEmergencyMessage("[server-host] restored launcher-config.json from the validated backup.");
            }
            catch (Exception ex)
            {
                WriteEmergencyMessage("[server-host] validated backup configuration is usable but primary restoration failed: " + ex.Message);
            }
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
                var package = Json.Deserialize<Dictionary<string, object?>>(File.ReadAllText(Path.Combine(root, "package.json"), Encoding.UTF8));
                object? value;
                var version = package != null && package.TryGetValue("version", out value)
                    ? Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty
                    : string.Empty;
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
                string? full = null;
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

        private static void SanitizeNodeEnvironment(ProcessStartInfo start)
        {
            if (start == null) return;
            foreach (var inheritedName in new[] { "NODE_OPTIONS", "NODE_PATH", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_REPL_EXTERNAL_MODULE" })
            {
                try { if (start.EnvironmentVariables.ContainsKey(inheritedName)) start.EnvironmentVariables.Remove(inheritedName); } catch { }
            }
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
                    SanitizeNodeEnvironment(process.StartInfo);
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
                    if (process.ExitCode != 0 || !Version.TryParse(output, out var parsed) || parsed == null) return false;
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
                TcpListener? listener = null;
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
            var config = _config ?? throw new InvalidOperationException("Launcher configuration is not loaded.");
            var token = _token ?? throw new InvalidOperationException("Launcher token is not initialized.");
            var shutdownMarkerPath = _shutdownMarkerPath ?? throw new InvalidOperationException("Shutdown marker path is not initialized.");
            var start = new ProcessStartInfo
            {
                FileName = node, Arguments = "server.js", WorkingDirectory = appDir, UseShellExecute = false,
                CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            SanitizeNodeEnvironment(start);
            start.EnvironmentVariables["PORT"] = _port.ToString(CultureInfo.InvariantCulture);
            start.EnvironmentVariables["BIND"] = "0.0.0.0";
            start.EnvironmentVariables["DATA_DIR"] = config.dataDir;
            start.EnvironmentVariables["INBOX_DIR"] = config.inboxDir;
            start.EnvironmentVariables["HOST_ROOT"] = config.hostRoot;
            start.EnvironmentVariables["IMAGES_DIR"] = config.imagesDir;
            start.EnvironmentVariables["NO_COLOR"] = "1";
            start.EnvironmentVariables["DX_WINDOWS_LAUNCHER_TOKEN"] = token;
            start.EnvironmentVariables["DX_WINDOWS_SHUTDOWN_MARKER"] = shutdownMarkerPath;

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
            var server = _server ?? throw new InvalidOperationException("Node.js process is not initialized.");
            var token = _token ?? throw new InvalidOperationException("Launcher token is not initialized.");
            using var host = Process.GetCurrentProcess();
            WriteSessionAtomic(new HostSession
            {
                hostPid = host.Id,
                hostStartedUtcTicks = GetProcessStartUtcTicks(host),
                hostPath = Program.ExecutablePath,
                serverPid = server.Id,
                serverStartedUtcTicks = GetProcessStartUtcTicks(server),
                nodePath = nodePath,
                port = _port,
                scheme = _scheme,
                token = token,
                runtimeBuild = Program.RuntimeAppBuild,
                hostBuild = Program.HostVersion
            });
        }

        private bool WaitUntilReady()
        {
            var watch = Stopwatch.StartNew();
            while (watch.ElapsedMilliseconds < Program.StartupReadyTimeoutMs)
            {
                Process server;
                string token;
                try
                {
                    server = _server ?? throw new InvalidOperationException("Node.js process is not initialized.");
                    if (server.HasExited) return false;
                    token = _token ?? throw new InvalidOperationException("Launcher token is not initialized.");
                }
                catch { return false; }
                string used;
                if (TryReady(_port, token, _scheme, server.Id, out used))
                {
                    _scheme = used;
                    WriteSession(server.StartInfo.FileName);
                    return true;
                }
                var signal = WaitHandle.WaitAny(new WaitHandle[] { _stopEvent, _reloadEvent }, 100);
                if (signal == 0) { _expectedStop = true; StopNode(); return false; }
                if (signal == 1) { _reloadRequested = true; StopNode(); return false; }
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
                    var response = LauncherRequest("GET", port, "/__dx_launcher/ready", token, scheme, 900, LocalCaCertificatePath);
                    var payload = Json.Deserialize<Dictionary<string, object?>>(response.Body);
                    object? okValue, appValue, pidValue;
                    var ok = payload != null && payload.TryGetValue("ok", out okValue) && Convert.ToBoolean(okValue, CultureInfo.InvariantCulture);
                    var app = payload != null && payload.TryGetValue("app", out appValue) ? Convert.ToString(appValue, CultureInfo.InvariantCulture) : string.Empty;
                    var pid = payload != null && payload.TryGetValue("pid", out pidValue) ? Convert.ToInt32(pidValue, CultureInfo.InvariantCulture) : 0;
                    if (response.StatusCode == HttpStatusCode.OK && ok && string.Equals(app, "Direct-Xfer", StringComparison.Ordinal) && pid == expectedPid)
                    { usedScheme = scheme; return true; }
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

        private sealed record LauncherHttpResponse(HttpStatusCode StatusCode, string Body)
        {
            internal bool IsSuccessStatusCode => (int)StatusCode is >= 200 and <= 299;
        }

        private static LauncherHttpResponse LauncherRequest(string method, int port, string route, string token,
            string scheme, int timeoutMs, string? localCaCertificatePath)
        {
            var url = scheme + "://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture) + route;
            using var handler = new HttpClientHandler
            {
                AllowAutoRedirect = false,
                UseProxy = false,
                UseCookies = false
            };
            if (string.Equals(scheme, "https", StringComparison.OrdinalIgnoreCase))
                handler.ServerCertificateCustomValidationCallback = (_, certificate, _, errors) =>
                    ValidateServerCertificate(certificate, errors, localCaCertificatePath);
            using var client = new HttpClient(handler)
            {
                Timeout = TimeSpan.FromMilliseconds(Math.Max(100, timeoutMs))
            };
            using var request = new HttpRequestMessage(new HttpMethod(method), url);
            request.Headers.ConnectionClose = true;
            if (!string.IsNullOrEmpty(token)) request.Headers.TryAddWithoutValidation("X-Direct-Xfer-Launcher-Token", token);
            using var response = client.SendAsync(request, HttpCompletionOption.ResponseContentRead).GetAwaiter().GetResult();
            var body = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
            return new LauncherHttpResponse(response.StatusCode, body);
        }

        private static bool ValidateServerCertificate(X509Certificate? certificate, SslPolicyErrors errors, string? localCaCertificatePath)
        {
            if (certificate == null) return false;
            if (errors == SslPolicyErrors.None) return true;
            if ((errors & (SslPolicyErrors.RemoteCertificateNameMismatch | SslPolicyErrors.RemoteCertificateNotAvailable)) != 0) return false;
            if ((errors & ~SslPolicyErrors.RemoteCertificateChainErrors) != 0) return false;
            X509Certificate2? localCa = null, leaf = null; X509Chain? localChain = null;
            try
            {
                localCa = LoadPemCertificate(localCaCertificatePath); if (localCa == null) return false;
                leaf = X509CertificateLoader.LoadCertificate(certificate.GetRawCertData()); localChain = new X509Chain();
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

        private static X509Certificate2? LoadPemCertificate(string? path)
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
            return X509CertificateLoader.LoadCertificate(Convert.FromBase64String(compact));
        }

        private void StopNode()
        {
            var server = _server;
            if (server == null) return;
            try { if (server.HasExited) return; } catch { return; }
            try
            {
                var token = _token;
                if (!string.IsNullOrWhiteSpace(token))
                {
                    foreach (var scheme in SchemeCandidates(_scheme))
                    {
                        try
                        {
                            var response = LauncherRequest("POST", _port, "/__dx_launcher/shutdown", token, scheme, 900, LocalCaCertificatePath);
                            if (response.IsSuccessStatusCode) break;
                        }
                        catch { }
                    }
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
                try { LauncherRequest("POST", session.port, "/__dx_launcher/shutdown", session.token, used, 800, LocalCaCertificatePath); } catch { }
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

        private static HostSession? ReadSession()
        {
            try
            {
                if (!File.Exists(SessionPath)) return null;
                var info = new FileInfo(SessionPath);
                if (info.Length <= 0 || info.Length > 64 * 1024) return null;
                if ((File.GetAttributes(SessionPath) & FileAttributes.ReparsePoint) != 0) return null;
                var session = Json.Deserialize<HostSession>(File.ReadAllText(SessionPath, Encoding.UTF8));
                if (session == null || session.hostPid <= 0 || session.serverPid <= 0) return null;
                if (session.port < Program.DefaultPort || session.port > Program.MaxFallbackPort) return null;
                if (!string.Equals(session.scheme, "http", StringComparison.OrdinalIgnoreCase) && !string.Equals(session.scheme, "https", StringComparison.OrdinalIgnoreCase)) return null;
                if (string.IsNullOrWhiteSpace(session.token) || session.token.Length != 48 || !session.token.All(IsHexDigit)) return null;
                if (string.IsNullOrWhiteSpace(session.nodePath) || !Path.IsPathRooted(session.nodePath)) return null;
                if (string.IsNullOrWhiteSpace(session.hostPath) || !Path.IsPathRooted(session.hostPath)) return null;
                return session;
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

        private static long GetProcessStartUtcTicks(Process? process)
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

        private void AppendLog(string? line)
        {
            if (line == null) return;
            lock (_logSync) { try { if (_logWriter != null) _logWriter.WriteLine(line); } catch { } }
        }

        internal static void WriteEmergencyLog(Exception ex)
        {
            WriteEmergencyMessage(ex == null ? "Unknown ServerHost error." : ex.ToString());
        }

        internal static void WriteEmergencyMessage(string message)
        {
            try
            {
                Directory.CreateDirectory(BaseDirectory);
                var path = Path.Combine(BaseDirectory, "Direct-Xfer-ServerHost-error.log");
                RotateLog(path, Program.EmergencyLogMaxBytes);
                File.AppendAllText(path, DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) + " " + (message ?? string.Empty) + Environment.NewLine, new UTF8Encoding(false));
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
            if (_systemEventsSubscribed)
            {
                try { SystemEvents.SessionEnding -= OnSessionEnding; } catch { }
                _systemEventsSubscribed = false;
            }
            try { _stopEvent.Dispose(); } catch { }
            try { _reloadEvent.Dispose(); } catch { }
        }
    }
}
