using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Security;
using System.Net.Http;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;
using System.Threading.Tasks;


namespace DirectXfer.WindowsLauncher
{
    internal static class Program
    {
        internal const string AppVersion = "1.67.1";
        internal const string RuntimeAppBuild = "1.67.1-launcher87-csharp";
        internal const string ServerHostFileName = "Direct-Xfer.ServerHost.exe";
        internal const string ServerHostVersion = "1.67.1.0";
        internal const int DefaultPort = 55750;
        internal const int MaxFallbackPort = 55769;
        internal const int StartupReadyTimeoutMs = 60000;
        internal const string MutexName = @"Local\DirectXferLauncherInstance";
        internal const string OpenEventName = @"Local\DirectXferLauncherOpen";
        internal const string ServerHostBuild = "1.67.1-serverhost60-csharp";
        internal const string ServerHostReloadEventName = @"Local\DirectXferServerHostReload";
        internal const string RcloneVersion = "1.74.4";
        internal const string RcloneZipSha256 = "ef097ef9de37a57feb7d9f9c7afb34148ad3c65be8025f1d8f7f521554a701ea";
        internal const string TesseractVersion = "5.5.3";
        internal const string TesseractPackageVersion = "5.5.3.20260724";
        internal const string TesseractSetupSha256 = "bee9e3434bd94fd65387d9be28cd467a41f61b1275383b55b0f59a1331270ae4";
        internal const string TessdataFastCommit = "87416418657359cb625c412a48b6e1d6d41c29bd";
        internal const string TessdataEngGitBlobSha1 = "bbef4675053b5b468cdb477053e28b1c698ba08e";
        internal const string TessdataFraGitBlobSha1 = "d9e2b2160be0d1ca3b8f1bf2730fae476ef3b4a6";
        internal const string TessdataSpaGitBlobSha1 = "72e901f13ca52cfe34cf239a368b9ed3c0ddaf26";
        internal const string OptionalActivationMarkerFileName = ".direct-xfer-enabled";

        internal static string ExecutablePath
        {
            get
            {
                var processPath = Environment.ProcessPath;
                if (!string.IsNullOrWhiteSpace(processPath)) return Path.GetFullPath(processPath);
                return Path.Combine(AppContext.BaseDirectory, "Direct-Xfer.exe");
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
        private static void Main(string[] args)
        {
            // CI/runtime probe: reaching managed code while global DOTNET_ROOT paths are
            // disabled proves the launcher resolved the packaged app-relative shared runtime.
            if (args.Length == 1 && string.Equals(args[0], "--dx-runtime-probe", StringComparison.Ordinal)) return;

            using var mutex = new Mutex(true, MutexName, out var createdNew);
            if (!createdNew)
            {
                SignalExistingInstance();
                return;
            }

            try
            {
                using var context = new LauncherContext(args ?? Array.Empty<string>());
                context.Run();
            }
            catch (Exception ex)
            {
                NativeUi.Error(IntPtr.Zero, "Direct-Xfer", ex.Message);
            }
            finally
            {
                try { mutex.ReleaseMutex(); } catch { }
            }
        }

        private static void SignalExistingInstance()
        {
            try
            {
                using var evt = EventWaitHandle.OpenExisting(OpenEventName);
                evt.Set();
            }
            catch { }
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
        public bool openBrowser;
        public string language = string.Empty;
    }

    internal sealed class LauncherSession
    {
        public int hostPid { get; set; }
        public long hostStartedUtcTicks { get; set; }
        public string hostPath { get; set; } = string.Empty;
        public int serverPid { get; set; }
        public long serverStartedUtcTicks { get; set; }
        public string nodePath { get; set; } = string.Empty;
        public int port { get; set; }
        public string scheme { get; set; } = string.Empty;
        public string token { get; set; } = string.Empty;
        public string runtimeBuild { get; set; } = string.Empty;
        public string hostBuild { get; set; } = string.Empty;
    }

    internal sealed class LauncherContext : IDisposable
    {
        private static readonly JsonCompat Json = new();
        private readonly NativeTrayIcon _tray;
        private readonly EventWaitHandle _openEvent;
        private readonly CancellationTokenSource _lifetime = new();
        private readonly object _exitSync = new();
        private LauncherConfig _config;
        private string _runtimeLogPath = string.Empty;
        private string _token = string.Empty;
        private string _runtimeScheme = "http";
        private int _runtimePort;
        private bool _exiting;
        private bool _disposed;
        private bool _optionalToolBusy;
        private int _deferredMaintenanceScheduled;
        private string _lastAttachFailure = string.Empty;

        internal LauncherContext(string[] args)
        {
            _tray = new NativeTrayIcon($"Direct-Xfer {Program.AppVersion}");
            bool exists;
            _config = LoadConfig(out exists);
            if (!exists) ConfigureFolders(true);
            else EnsureConfigDirectories(_config);

            if (args.Any(a => string.Equals(a, "--configure", StringComparison.OrdinalIgnoreCase)))
                ConfigureFolders(false);

            _tray.LeftClick = OpenBrowser;
            _tray.MenuFactory = BuildTrayMenu;
            _tray.CommandInvoked = HandleTrayCommand;
            // Keep the startup path lean. Optional-component migration and stale-work
            // cleanup are housekeeping only; doing them before ServerHost attachment can
            // launch rclone/Tesseract probes and traverse old work folders before the UI
            // is usable. Run that maintenance after the backend is ready instead.
            RebuildTrayMenu();

            bool eventCreated;
            _openEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.OpenEventName, out eventCreated);
            Task.Run(() => ExistingInstanceSignalLoop(_lifetime.Token));
            try { AttachToServerHost(); }
            catch (Exception ex)
            {
                _tray.Hide();
                NativeUi.Error(_tray.WindowHandle, Tr.AppTitle, Tr.StartError + ":\r\n" + ex.Message);
                _tray.Exit();
            }
        }

        private Texts Tr { get { return Texts.For(_config != null ? _config.language : "en"); } }

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
        private static string OptionalToolsRoot { get { return Path.Combine(BaseDirectory, "tools"); } }
        private static string OptionalRcloneRoot { get { return Path.Combine(OptionalToolsRoot, "rclone", Program.RcloneVersion); } }
        private static string OptionalRclonePath { get { return Path.Combine(OptionalRcloneRoot, "rclone.exe"); } }
        private static string OptionalRcloneActivationMarker { get { return Path.Combine(OptionalRcloneRoot, Program.OptionalActivationMarkerFileName); } }
        private static string OptionalTesseractRoot { get { return Path.Combine(OptionalToolsRoot, "tesseract", Program.TesseractVersion); } }
        private static string OptionalTesseractPath { get { return Path.Combine(OptionalTesseractRoot, "tesseract.exe"); } }
        private static string OptionalTessdataPath { get { return Path.Combine(OptionalTesseractRoot, "tessdata"); } }
        private static string OptionalTesseractActivationMarker { get { return Path.Combine(OptionalTesseractRoot, Program.OptionalActivationMarkerFileName); } }
        private static string OptionalOperationLockPath { get { return Path.Combine(OptionalToolsRoot, ".operation.lock"); } }

        private static LauncherConfig DefaultConfig()
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var docs = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            if (string.IsNullOrWhiteSpace(docs)) docs = Path.Combine(home, "Documents");
            var dxDocs = Path.Combine(docs, "Direct-Xfer");
            return new LauncherConfig
            {
                version = Program.AppVersion,
                dataDir = Path.Combine(BaseDirectory, "data"),
                logsDir = Path.Combine(BaseDirectory, "logs"),
                inboxDir = Path.Combine(dxDocs, "Received"),
                hostRoot = home,
                imagesDir = Path.Combine(dxDocs, "Images"),
                openBrowser = true,
                language = DetectLanguage()
            };
        }

        private static string DetectLanguage()
        {
            var two = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName.ToLowerInvariant();
            return two == "fr" || two == "es" ? two : "en";
        }

        private static LauncherConfig LoadConfig(out bool exists)
        {
            var fallback = DefaultConfig();
            foreach (var candidate in new[] { ConfigPath, ConfigPath + ".bak" })
            {
                try
                {
                    if (!File.Exists(candidate)) continue;
                    var cfg = Json.Deserialize<LauncherConfig>(File.ReadAllText(candidate, Encoding.UTF8));
                    if (cfg == null) continue;
                    if (cfg.language != "fr" && cfg.language != "en" && cfg.language != "es") cfg.language = fallback.language;
                    if (string.IsNullOrWhiteSpace(cfg.dataDir)) cfg.dataDir = fallback.dataDir;
                    if (string.IsNullOrWhiteSpace(cfg.logsDir)) cfg.logsDir = fallback.logsDir;
                    if (string.IsNullOrWhiteSpace(cfg.inboxDir)) cfg.inboxDir = fallback.inboxDir;
                    if (string.IsNullOrWhiteSpace(cfg.hostRoot)) cfg.hostRoot = fallback.hostRoot;
                    if (string.IsNullOrWhiteSpace(cfg.imagesDir)) cfg.imagesDir = fallback.imagesDir;
                    cfg.version = Program.AppVersion;
                    exists = true;
                    if (!string.Equals(candidate, ConfigPath, StringComparison.OrdinalIgnoreCase))
                    {
                        try { WriteTextAtomic(ConfigPath, Json.Serialize(cfg)); } catch { }
                    }
                    return cfg;
                }
                catch { }
            }
            exists = false;
            return fallback;
        }

        private void SaveConfig()
        {
            _config.version = Program.AppVersion;
            Directory.CreateDirectory(BaseDirectory);
            WriteTextAtomic(ConfigPath, Json.Serialize(_config));
        }

        private static void WriteTextAtomic(string path, string content)
        {
            var directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrWhiteSpace(directory)) Directory.CreateDirectory(directory);
            var temp = path + ".tmp." + Guid.NewGuid().ToString("N");
            var backup = path + ".bak";
            File.WriteAllText(temp, content, new UTF8Encoding(false));
            try
            {
                if (File.Exists(path)) File.Replace(temp, path, backup, true);
                else File.Move(temp, path);
            }
            finally { try { if (File.Exists(temp)) File.Delete(temp); } catch { } }
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

        private void ConfigureFolders(bool firstRun)
        {
            var tr = Tr;
            if (firstRun) NativeUi.Info(_tray.WindowHandle, tr.FirstRunTitle, tr.FirstRunBody);
            var next = CloneConfig(_config);
            next.hostRoot = PickFolder(tr.PickHost, next.hostRoot);
            next.inboxDir = PickFolder(tr.PickInbox, next.inboxDir);
            next.imagesDir = PickFolder(tr.PickImages, next.imagesDir);
            try
            {
                EnsureConfigDirectories(next);
                var previous = _config;
                _config = next;
                try { SaveConfig(); } catch { _config = previous; throw; }
                if (!firstRun)
                {
                    var running = IsServerHostRunning();
                    if (running) SignalServerHostReload();
                    NativeUi.Info(_tray.WindowHandle, tr.AppTitle, running ? tr.ConfigSavedRestart : tr.ConfigSaved);
                }
            }
            catch (Exception ex) { NativeUi.Error(_tray.WindowHandle, tr.AppTitle, ex.Message); }
        }

        private static LauncherConfig CloneConfig(LauncherConfig c)
        {
            return new LauncherConfig
            {
                version = c.version, dataDir = c.dataDir, logsDir = c.logsDir, inboxDir = c.inboxDir,
                hostRoot = c.hostRoot, imagesDir = c.imagesDir, openBrowser = c.openBrowser, language = c.language
            };
        }

        private string PickFolder(string title, string initial)
        {
            return NativeUi.PickFolder(_tray.WindowHandle, title, Directory.Exists(initial) ? initial : string.Empty);
        }

        private static string PortableRoot
        {
            get
            {
                var overridden = Environment.GetEnvironmentVariable("DX_WINDOWS_PORTABLE_ROOT");
                if (!string.IsNullOrWhiteSpace(overridden))
                {
                    try { return Path.GetFullPath(overridden.Trim()); }
                    catch { /* Invalid optional override: fall back to the packaged executable directory. */ }
                }
                return Program.ExecutableDirectory;
            }
        }

        private string? LocalCaCertificatePath
        {
            get { return string.IsNullOrWhiteSpace(_config.dataDir) ? null : Path.Combine(_config.dataDir, "tls", "local-ca-cert.pem"); }
        }

        private static string ExpectedServerHostPath
        {
            get { return Path.Combine(PortableRoot, Program.ServerHostFileName); }
        }

        private static bool ServerHostFileMatchesSession(LauncherSession? session)
        {
            if (session == null || string.IsNullOrWhiteSpace(session.hostPath) ||
                !string.Equals(session.hostBuild, Program.ServerHostBuild, StringComparison.Ordinal)) return false;
            try
            {
                var expected = Path.GetFullPath(ExpectedServerHostPath);
                var reported = Path.GetFullPath(session.hostPath);
                if (!string.Equals(expected, reported, StringComparison.OrdinalIgnoreCase) || !File.Exists(expected)) return false;
                if ((File.GetAttributes(expected) & FileAttributes.ReparsePoint) != 0 || !IsAmd64Pe(expected)) return false;
                // The SDK-generated Win32 version resource of a published single-file
                // apphost is not a stable runtime identity boundary across
                // .NET SDK servicing releases. The session is already authenticated by
                // the exact expected path/build plus the per-process token and PID in
                // /__dx_launcher/ready, so do not reject a healthy ServerHost only because
                // FileVersionInfo metadata is missing or formatted differently.
                return true;
            }
            catch { return false; }
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

        private void AttachToServerHost()
        {
            EnsureConfigDirectories(_config);
            _runtimeLogPath = Path.Combine(_config.logsDir, "Direct-Xfer-Windows.log");
            var existing = ReadSession();
            if (TryAttachReadySession(existing))
            {
                CompleteStartup();
                return;
            }

            // Do not depend solely on the Startup-folder shortcut or the installer post-run.
            // Starting the expected ServerHost is safe even when one is already running: its
            // named single-instance mutex makes the duplicate process exit immediately. This
            // makes Direct-Xfer self-healing when Windows Startup was disabled, delayed or lost.
            StartExpectedServerHost();
            Task.Run(() => WaitForServerHostReady(_lifetime.Token));
        }

        private void StartExpectedServerHost()
        {
            try
            {
                var expected = Path.GetFullPath(ExpectedServerHostPath);
                if (!File.Exists(expected))
                {
                    _lastAttachFailure = "ServerHost executable not found: " + expected;
                    return;
                }
                if ((File.GetAttributes(expected) & FileAttributes.ReparsePoint) != 0 || !IsAmd64Pe(expected))
                {
                    _lastAttachFailure = "ServerHost executable failed local validation: " + expected;
                    return;
                }
                using var process = Process.Start(new ProcessStartInfo
                {
                    FileName = expected,
                    WorkingDirectory = PortableRoot,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                });
                if (process == null) _lastAttachFailure = "Windows did not start Direct-Xfer.ServerHost.exe.";
            }
            catch (Exception ex)
            {
                _lastAttachFailure = "ServerHost start failed: " + ex.GetType().Name + ": " + ex.Message;
            }
        }

        private bool TryAttachReadySession(LauncherSession? session)
        {
            if (session == null)
            {
                _lastAttachFailure = "No usable launcher-session.json has been published by ServerHost yet.";
                return false;
            }
            if (!string.Equals(session.runtimeBuild, Program.RuntimeAppBuild, StringComparison.Ordinal))
            {
                _lastAttachFailure = "Runtime build mismatch: session=" + session.runtimeBuild + ", expected=" + Program.RuntimeAppBuild + ".";
                return false;
            }
            if (!ServerHostFileMatchesSession(session))
            {
                _lastAttachFailure = "ServerHost path/build validation failed for the published session.";
                return false;
            }
            string usedScheme;
            if (!TryReady(session.port, session.token, session.scheme, session.serverPid, out usedScheme)) return false;
            _runtimePort = session.port;
            _runtimeScheme = usedScheme;
            _token = session.token;
            _lastAttachFailure = string.Empty;
            return true;
        }

        private void WaitForServerHostReady(CancellationToken token)
        {
            var watch = Stopwatch.StartNew();
            while (!token.IsCancellationRequested && !_exiting && watch.ElapsedMilliseconds < Program.StartupReadyTimeoutMs)
            {
                var session = ReadSession();
                if (TryAttachReadySession(session))
                {
                    Ui(CompleteStartup);
                    return;
                }
                Thread.Sleep(100);
            }
            if (token.IsCancellationRequested || _exiting) return;
            var details = TailFile(_runtimeLogPath, 4096);
            var hostErrorPath = Path.Combine(BaseDirectory, "Direct-Xfer-ServerHost-error.log");
            var hostError = TailFile(hostErrorPath, 4096);
            var body = Tr.ServerHostUnavailable + "\r\n" + Tr.LogLabel + ": " + _runtimeLogPath;
            if (!string.IsNullOrWhiteSpace(_lastAttachFailure)) body += "\r\n\r\nDiagnostic: " + _lastAttachFailure;
            if (!string.IsNullOrWhiteSpace(hostError)) body += "\r\n\r\nServerHost error log:\r\n" + hostError;
            if (!string.IsNullOrWhiteSpace(details)) body += "\r\n\r\nRuntime log:\r\n" + details;
            Ui(() =>
            {
                if (_exiting) return;
                NativeUi.Error(_tray.WindowHandle, Tr.AppTitle, body);
                RequestExit();
            });
        }

        private void CompleteStartup()
        {
            if (_exiting) return;
            if (_runtimePort != Program.DefaultPort)
                NativeUi.Info(_tray.WindowHandle, Tr.AppTitle, string.Format(Tr.PortFallback, Program.DefaultPort, _runtimePort));
            ShowInitialAdminPassword();
            // Readiness was just authenticated above; do not immediately perform a
            // second session read + HTTP readiness probe only to open the same URL.
            if (_config.openBrowser && !_exiting) OpenRuntimeUrl();
            ScheduleDeferredMaintenance();
        }

        private void ScheduleDeferredMaintenance()
        {
            if (Interlocked.Exchange(ref _deferredMaintenanceScheduled, 1) != 0) return;
            _ = Task.Run(async () =>
            {
                try
                {
                    // Give the first browser/navigation requests priority over optional
                    // component housekeeping and antivirus-visible filesystem scans.
                    await Task.Delay(1500, _lifetime.Token).ConfigureAwait(false);
                    if (_lifetime.IsCancellationRequested || _exiting) return;
                    CleanupStaleOptionalWorkDirectories();
                    if (_lifetime.IsCancellationRequested || _exiting) return;
                    if (MigrateLegacyOptionalActivationState()) SignalServerHostReload();
                }
                catch (OperationCanceledException) { }
                catch { /* Deferred housekeeping is best-effort and must never break startup. */ }
            });
        }

        private bool TryReady(int port, string token, string preferredScheme, int expectedPid, out string usedScheme)
        {
            usedScheme = preferredScheme;
            if (port <= 0 || expectedPid <= 0 || string.IsNullOrEmpty(token))
            {
                _lastAttachFailure = "Published ServerHost session is incomplete (port/PID/token).";
                return false;
            }
            var lastFailure = string.Empty;
            foreach (var scheme in SchemeCandidates(preferredScheme))
            {
                try
                {
                    var response = LauncherRequest("GET", port, "/__dx_launcher/ready", token, scheme, 2000, LocalCaCertificatePath);
                    var payload = Json.Deserialize<Dictionary<string, object?>>(response.Body);
                    var ready = response.StatusCode == HttpStatusCode.OK && GetBool(payload, "ok") &&
                        string.Equals(GetString(payload, "app"), "Direct-Xfer", StringComparison.Ordinal) &&
                        GetInt32(payload, "pid") == expectedPid;
                    if (ready)
                    {
                        usedScheme = scheme;
                        _lastAttachFailure = string.Empty;
                        return true;
                    }
                    lastFailure = scheme + " readiness returned HTTP " + ((int)response.StatusCode).ToString(CultureInfo.InvariantCulture) +
                        " for PID " + expectedPid.ToString(CultureInfo.InvariantCulture) + ".";
                }
                catch (Exception ex)
                {
                    lastFailure = scheme + " readiness failed: " + ex.GetType().Name + ": " + ex.Message;
                }
            }
            if (!string.IsNullOrWhiteSpace(lastFailure)) _lastAttachFailure = lastFailure;
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
                    ValidateLauncherServerCertificate(certificate, errors, localCaCertificatePath);
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

        private static bool ValidateLauncherServerCertificate(X509Certificate? certificate, SslPolicyErrors errors,
            string? localCaCertificatePath)
        {
            if (certificate == null) return false;
            if (errors == SslPolicyErrors.None) return true;
            if ((errors & (SslPolicyErrors.RemoteCertificateNameMismatch | SslPolicyErrors.RemoteCertificateNotAvailable)) != 0) return false;
            if ((errors & ~SslPolicyErrors.RemoteCertificateChainErrors) != 0) return false;
            X509Certificate2? localCa = null, leaf = null;
            X509Chain? localChain = null;
            try
            {
                localCa = LoadPemCertificate(localCaCertificatePath);
                if (localCa == null) return false;
                leaf = X509CertificateLoader.LoadCertificate(certificate.GetRawCertData());
                localChain = new X509Chain();
                localChain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
                localChain.ChainPolicy.DisableCertificateDownloads = true;
                localChain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
                localChain.ChainPolicy.CustomTrustStore.Add(localCa);
                localChain.ChainPolicy.VerificationFlags = X509VerificationFlags.NoFlag;
                if (!localChain.Build(leaf) || localChain.ChainElements.Count == 0) return false;
                var root = localChain.ChainElements[localChain.ChainElements.Count - 1].Certificate;
                return string.Equals(root.Thumbprint, localCa.Thumbprint, StringComparison.OrdinalIgnoreCase);
            }
            catch { return false; }
            finally
            {
                if (localChain != null) localChain.Dispose();
                if (leaf != null) leaf.Dispose();
                if (localCa != null) localCa.Dispose();
            }
        }

        private static X509Certificate2? LoadPemCertificate(string? path)
        {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return null;
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) return null;
            var info = new FileInfo(path);
            if (info.Length <= 0 || info.Length > 2L * 1024 * 1024) return null;
            var pem = File.ReadAllText(path, Encoding.ASCII);
            const string begin = "-----BEGIN CERTIFICATE-----", end = "-----END CERTIFICATE-----";
            var first = pem.IndexOf(begin, StringComparison.Ordinal);
            var last = pem.IndexOf(end, first >= 0 ? first + begin.Length : 0, StringComparison.Ordinal);
            if (first < 0 || last <= first) return null;
            var compact = new string(pem.Substring(first + begin.Length, last - first - begin.Length).Where(c => !char.IsWhiteSpace(c)).ToArray());
            return X509CertificateLoader.LoadCertificate(Convert.FromBase64String(compact));
        }

        private LauncherHttpResponse LauncherRequestAnyScheme(string method, int port, string route, string token,
            string preferred, int timeoutMs, out string usedScheme)
        {
            Exception? last = null;
            foreach (var scheme in SchemeCandidates(preferred))
            {
                try
                {
                    var response = LauncherRequest(method, port, route, token, scheme, timeoutMs, LocalCaCertificatePath);
                    if (!response.IsSuccessStatusCode && response.StatusCode != HttpStatusCode.Conflict)
                    {
                        last = new HttpRequestException("Direct-Xfer launcher endpoint returned HTTP " +
                            ((int)response.StatusCode).ToString(CultureInfo.InvariantCulture) + ".");
                        continue;
                    }
                    usedScheme = scheme;
                    return response;
                }
                catch (Exception ex) { last = ex; }
            }
            usedScheme = preferred;
            throw last ?? new HttpRequestException("Direct-Xfer launcher endpoint unavailable.");
        }

        private void ShowInitialAdminPassword()
        {
            var token = _token;
            if (_exiting || string.IsNullOrEmpty(token)) return;
            try
            {
                string scheme;
                var response = LauncherRequestAnyScheme("POST", _runtimePort,
                    "/__dx_launcher/initial-admin-password", token, _runtimeScheme, 1500, out scheme);
                _runtimeScheme = scheme;
                if (response.StatusCode == HttpStatusCode.NoContent) return;
                if (response.StatusCode != HttpStatusCode.OK) throw new InvalidDataException();
                var payload = Json.Deserialize<Dictionary<string, object?>>(response.Body);
                if (!GetBool(payload, "ok") || !GetBool(payload, "fresh")) return;
                var username = GetString(payload, "username");
                var password = GetString(payload, "password");
                if (string.IsNullOrEmpty(username) || string.IsNullOrEmpty(password)) throw new InvalidDataException();
                var tr = Tr;
                NativeUi.ShowPasswordDialog(_tray.WindowHandle, _tray.IconHandle, tr.InitialPasswordTitle,
                    tr.InitialPasswordIntro, string.Format(tr.InitialPasswordAccount, username), tr.InitialPasswordLabel,
                    password, tr.InitialPasswordSave, tr.InitialPasswordCopy, tr.InitialPasswordOK);
            }
            catch
            {
                NativeUi.Warning(_tray.WindowHandle, Tr.InitialPasswordTitle, Tr.InitialPasswordError);
            }
        }

        private void OpenPasswordReset()
        {
            var token = _token;
            if (_exiting || string.IsNullOrEmpty(token)) return;
            try
            {
                string scheme;
                var response = LauncherRequestAnyScheme("POST", _runtimePort,
                    "/__dx_launcher/reset-admin-password-ticket", token, _runtimeScheme, 1500, out scheme);
                if (response.StatusCode == HttpStatusCode.Conflict)
                {
                    NativeUi.Warning(_tray.WindowHandle, Tr.AppTitle, Tr.ResetPasswordEnvManaged);
                    return;
                }
                if (response.StatusCode != HttpStatusCode.OK) throw new HttpRequestException();
                _runtimeScheme = scheme;
                var payload = Json.Deserialize<Dictionary<string, object?>>(response.Body);
                var ticket = GetString(payload, "ticket");
                if (!GetBool(payload, "ok") || string.IsNullOrEmpty(ticket)) throw new InvalidDataException();
                var url = scheme + "://127.0.0.1:" + _runtimePort.ToString(CultureInfo.InvariantCulture) +
                    "/__dx_launcher/reset-admin-password?ticket=" + Uri.EscapeDataString(ticket) +
                    "&lang=" + Uri.EscapeDataString(_config.language);
                OpenUrl(url);
            }
            catch { NativeUi.Error(_tray.WindowHandle, Tr.AppTitle, Tr.ResetPasswordError); }
        }

        private static bool GetBool(IDictionary<string, object?>? payload, string key)
        {
            object? value;
            if (payload == null || !payload.TryGetValue(key, out value) || value == null) return false;
            if (value is bool) return (bool)value;
            bool parsed;
            return bool.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), out parsed) && parsed;
        }

        private static string? GetString(IDictionary<string, object?>? payload, string key)
        {
            object? value;
            return payload != null && payload.TryGetValue(key, out value) && value != null
                ? Convert.ToString(value, CultureInfo.InvariantCulture) : null;
        }

        private static int GetInt32(IDictionary<string, object?>? payload, string key)
        {
            object? value;
            if (payload == null || !payload.TryGetValue(key, out value) || value == null) return 0;
            try { return Convert.ToInt32(value, CultureInfo.InvariantCulture); }
            catch { return 0; }
        }

        private void OpenBrowser()
        {
            var session = ReadSession();
            if (!TryAttachReadySession(session))
            {
                NativeUi.Warning(_tray.WindowHandle, Tr.AppTitle, Tr.ServerHostUnavailable);
                return;
            }
            OpenRuntimeUrl();
        }

        private void OpenRuntimeUrl()
        {
            if (_runtimePort <= 0) return;
            OpenUrl(_runtimeScheme + "://127.0.0.1:" + _runtimePort.ToString(CultureInfo.InvariantCulture) + "/");
        }

        private void OpenLogs()
        {
            var dir = !string.IsNullOrWhiteSpace(_runtimeLogPath) ? Path.GetDirectoryName(_runtimeLogPath) : _config.logsDir;
            if (!string.IsNullOrWhiteSpace(dir) && Directory.Exists(dir)) OpenUrl(dir);
        }

        private static void OpenUrl(string value)
        {
            try
            {
                Process.Start(new ProcessStartInfo { FileName = value, UseShellExecute = true });
            }
            catch { }
        }

        private static bool OptionalRcloneInstalled()
        {
            try
            {
                return File.Exists(OptionalRcloneActivationMarker) &&
                    RcloneBinaryMatchesPinnedVersion(OptionalRclonePath);
            }
            catch { return false; }
        }

        private static bool OptionalTesseractInstalled()
        {
            try
            {
                return File.Exists(OptionalTesseractActivationMarker) &&
                    TesseractBinaryMatchesPinnedVersion(OptionalTesseractPath) &&
                    Directory.Exists(OptionalTessdataPath) && LegacyTessdataMatchesPinnedBlobs();
            }
            catch { return false; }
        }

        private static bool RcloneBinaryMatchesPinnedVersion(string path)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(path) || !File.Exists(path) ||
                    new FileInfo(path).Length <= 1024 * 1024 || !IsAmd64Pe(path)) return false;
                var output = RunToolCapture(path, new[] { "version" }, 2500);
                return output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                    .Any(line => string.Equals(line.Trim(), "rclone v" + Program.RcloneVersion, StringComparison.OrdinalIgnoreCase));
            }
            catch { return false; }
        }

        private static bool TesseractBinaryMatchesPinnedVersion(string path)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(path) || !File.Exists(path) ||
                    new FileInfo(path).Length <= 1024 * 1024 || !IsAmd64Pe(path)) return false;
                var output = RunToolCapture(path, new[] { "--version" }, 2500);
                var first = output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? string.Empty;
                first = first.TrimStart();
                return first.StartsWith("tesseract v" + Program.TesseractVersion, StringComparison.OrdinalIgnoreCase) ||
                    first.StartsWith("tesseract " + Program.TesseractVersion, StringComparison.OrdinalIgnoreCase);
            }
            catch { return false; }
        }

        private static bool MigrateLegacyOptionalActivationState()
        {
            // 1.66.4 was the first on-demand build and had no explicit activation marker.
            // Preserve a component only when its Direct-Xfer receipt proves it came from that
            // explicit activation flow. Manually dropped executables are never auto-activated.
            // Serialize migration too: another RDP/session may currently be installing or
            // repairing the same per-user component tree.
            var operationLock = TryAcquireOptionalOperationLock();
            if (operationLock == null) return false;
            try
            {
                var migrated = false;
                migrated |= TryMigrateLegacyActivationReceipt(
                    OptionalRcloneRoot,
                    OptionalRcloneActivationMarker,
                    "Direct-Xfer optional rclone v" + Program.RcloneVersion,
                    "Archive SHA-256: " + Program.RcloneZipSha256,
                    () => RcloneBinaryMatchesPinnedVersion(OptionalRclonePath));
                migrated |= TryMigrateLegacyActivationReceipt(
                    OptionalTesseractRoot,
                    OptionalTesseractActivationMarker,
                    "Direct-Xfer optional Tesseract OCR " + Program.TesseractVersion,
                    "Setup SHA-256: " + Program.TesseractSetupSha256,
                    () => TesseractBinaryMatchesPinnedVersion(OptionalTesseractPath) && Directory.Exists(OptionalTessdataPath) &&
                        LegacyTessdataMatchesPinnedBlobs());
                return migrated;
            }
            finally { ReleaseOptionalOperationLock(operationLock); }
        }

        private static bool LegacyTessdataMatchesPinnedBlobs()
        {
            foreach (var model in new[]
            {
                (Language: "eng", GitBlobSha1: Program.TessdataEngGitBlobSha1),
                (Language: "fra", GitBlobSha1: Program.TessdataFraGitBlobSha1),
                (Language: "spa", GitBlobSha1: Program.TessdataSpaGitBlobSha1)
            })
            {
                var path = Path.Combine(OptionalTessdataPath, model.Language + ".traineddata");
                if (!File.Exists(path) || new FileInfo(path).Length < 100 * 1024 ||
                    !string.Equals(FileGitBlobSha1(path), model.GitBlobSha1, StringComparison.OrdinalIgnoreCase)) return false;
            }
            return true;
        }

        private static bool TryMigrateLegacyActivationReceipt(string root, string marker, string receiptPrefix, string receiptHash, Func<bool> filesLookComplete)
        {
            try
            {
                if (File.Exists(marker) || !Directory.Exists(root) || !filesLookComplete()) return false;
                var receipt = Path.Combine(root, "DIRECT-XFER-README.txt");
                if (!File.Exists(receipt)) return false;
                var info = new FileInfo(receipt);
                if (info.Length <= 0 || info.Length > 64 * 1024) return false;
                var content = File.ReadAllText(receipt, Encoding.UTF8);
                if (!content.Contains(receiptPrefix, StringComparison.Ordinal) ||
                    !content.Contains(receiptHash, StringComparison.OrdinalIgnoreCase) ||
                    !content.Contains("Downloaded only after user activation.", StringComparison.Ordinal)) return false;
                WriteActivationMarker(marker, "migrated-from-1.66.4");
                return true;
            }
            catch { return false; }
        }

        private static void WriteActivationMarker(string marker, string source)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(marker) ?? throw new InvalidOperationException("Invalid activation marker path."));
            var temp = marker + ".tmp-" + Guid.NewGuid().ToString("N");
            try
            {
                File.WriteAllText(temp,
                    "Direct-Xfer optional component activation" + Environment.NewLine +
                    "app=" + Program.AppVersion + Environment.NewLine +
                    "source=" + source + Environment.NewLine,
                    new UTF8Encoding(false));
                File.Move(temp, marker, true);
            }
            finally { try { if (File.Exists(temp)) File.Delete(temp); } catch { } }
        }

        private static bool DeactivateOptionalTool(string tool)
        {
            var marker = string.Equals(tool, "rclone", StringComparison.OrdinalIgnoreCase)
                ? OptionalRcloneActivationMarker
                : OptionalTesseractActivationMarker;
            if (!File.Exists(marker)) return false;
            File.Delete(marker);
            if (File.Exists(marker)) throw new IOException("Direct-Xfer could not deactivate the optional component before replacement or removal.");
            return true;
        }

        private static FileStream? TryAcquireOptionalOperationLock()
        {
            try
            {
                Directory.CreateDirectory(OptionalToolsRoot);
                return new FileStream(OptionalOperationLockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.None);
            }
            catch (IOException) { return null; }
            catch (UnauthorizedAccessException) { return null; }
        }

        private static void ReleaseOptionalOperationLock(FileStream? operationLock)
        {
            if (operationLock == null) return;
            try { operationLock.Dispose(); } catch { }
            try { if (File.Exists(OptionalOperationLockPath)) File.Delete(OptionalOperationLockPath); } catch { }
        }

        private async Task InstallOptionalToolAsync(string tool)
        {
            if (_optionalToolBusy) return;
            var tr = Tr;
            var displayName = string.Equals(tool, "rclone", StringComparison.OrdinalIgnoreCase)
                ? "rclone " + Program.RcloneVersion
                : "Tesseract OCR " + Program.TesseractVersion;
            if (!NativeUi.Confirm(_tray.WindowHandle, tr.AppTitle,
                string.Format(CultureInfo.CurrentCulture, tr.OptionalInstallConfirm, displayName), false)) return;

            var operationLock = TryAcquireOptionalOperationLock();
            if (operationLock == null)
            {
                NativeUi.Warning(_tray.WindowHandle, tr.AppTitle, tr.OptionalBusyOtherSession);
                return;
            }
            _optionalToolBusy = true;
            RebuildTrayMenu();
            try
            {
                _tray.ShowBalloon(tr.OptionalComponents,
                    string.Format(CultureInfo.CurrentCulture, tr.OptionalInstalling, displayName), NativeBalloonIcon.Info);

                // Repair/re-activation can be requested when an existing optional component is
                // incomplete or damaged. Deactivate it and stop the backend before replacing
                // files so Windows cannot keep rclone.exe/tesseract.exe locked or keep spawning
                // jobs with a path that is being replaced.
                var existingRoot = string.Equals(tool, "rclone", StringComparison.OrdinalIgnoreCase)
                    ? OptionalRcloneRoot
                    : OptionalTesseractRoot;
                var previousSession = ReadSession();
                var replacingExistingFiles = Directory.Exists(existingRoot);
                var wasActive = DeactivateOptionalTool(tool);
                if (wasActive || replacingExistingFiles)
                {
                    SignalServerHostReload();
                    await Task.Run(() =>
                    {
                        if (previousSession != null && previousSession.serverPid > 0)
                            StopPreviousBackend(previousSession, 9000);
                        StopOptionalToolProcesses(tool);
                    });
                }

                await Task.Run(() =>
                {
                    if (string.Equals(tool, "rclone", StringComparison.OrdinalIgnoreCase)) InstallRcloneCore();
                    else InstallTesseractCore();
                });
                SignalServerHostReload();
                NativeUi.Info(_tray.WindowHandle, tr.AppTitle, string.Format(CultureInfo.CurrentCulture, tr.OptionalInstalled, displayName));
            }
            catch (Exception ex)
            {
                NativeUi.Error(_tray.WindowHandle, tr.AppTitle, string.Format(CultureInfo.CurrentCulture, tr.OptionalFailed, displayName, ex.Message));
            }
            finally
            {
                _optionalToolBusy = false;
                ReleaseOptionalOperationLock(operationLock);
                RebuildTrayMenu();
            }
        }

        private async Task RemoveOptionalToolAsync(string tool)
        {
            if (_optionalToolBusy) return;
            var tr = Tr;
            var displayName = string.Equals(tool, "rclone", StringComparison.OrdinalIgnoreCase)
                ? "rclone " + Program.RcloneVersion
                : "Tesseract OCR " + Program.TesseractVersion;
            if (!NativeUi.Confirm(_tray.WindowHandle, tr.AppTitle,
                string.Format(CultureInfo.CurrentCulture, tr.OptionalRemoveConfirm, displayName), true)) return;

            var operationLock = TryAcquireOptionalOperationLock();
            if (operationLock == null)
            {
                NativeUi.Warning(_tray.WindowHandle, tr.AppTitle, tr.OptionalBusyOtherSession);
                return;
            }
            _optionalToolBusy = true;
            var deactivated = false;
            RebuildTrayMenu();
            try
            {
                var previousSession = ReadSession();
                deactivated = DeactivateOptionalTool(tool);
                SignalServerHostReload();
                await Task.Run(() =>
                {
                    if (previousSession != null && previousSession.serverPid > 0)
                        StopPreviousBackend(previousSession, 9000);
                    StopOptionalToolProcesses(tool);
                    if (string.Equals(tool, "rclone", StringComparison.OrdinalIgnoreCase)) RemoveRcloneCore();
                    else RemoveTesseractCore();
                });
                NativeUi.Info(_tray.WindowHandle, tr.AppTitle, string.Format(CultureInfo.CurrentCulture, tr.OptionalRemoved, displayName));
            }
            catch (Exception ex)
            {
                var message = deactivated
                    ? string.Format(CultureInfo.CurrentCulture, tr.OptionalCleanupFailed, displayName, ex.Message)
                    : string.Format(CultureInfo.CurrentCulture, tr.OptionalFailed, displayName, ex.Message);
                NativeUi.Error(_tray.WindowHandle, tr.AppTitle, message);
            }
            finally
            {
                _optionalToolBusy = false;
                ReleaseOptionalOperationLock(operationLock);
                RebuildTrayMenu();
            }
        }

        private static void CleanupStaleOptionalWorkDirectories()
        {
            FileStream? operationLock = null;
            try
            {
                if (!Directory.Exists(OptionalToolsRoot)) return;
                operationLock = TryAcquireOptionalOperationLock();
                if (operationLock == null) return; // Another Windows session is actively modifying optional tools.
                var cutoff = DateTime.UtcNow - TimeSpan.FromHours(12);
                foreach (var directory in Directory.EnumerateDirectories(OptionalToolsRoot, ".work-*", SearchOption.TopDirectoryOnly))
                {
                    try
                    {
                        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) continue;
                        var info = new DirectoryInfo(directory);
                        if (info.LastWriteTimeUtc > cutoff) continue;
                        Directory.Delete(directory, true);
                    }
                    catch { }
                }
            }
            catch { }
            finally { ReleaseOptionalOperationLock(operationLock); }
        }

        private static string CreateToolWorkDirectory(string name)
        {
            Directory.CreateDirectory(OptionalToolsRoot);
            var root = Path.Combine(OptionalToolsRoot, ".work-" + name + "-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            return root;
        }

        private static void DownloadOptionalFile(string url, string destination, string? expectedSha256, long minimumBytes, long maximumBytes)
        {
            Exception? last = null;
            for (var attempt = 1; attempt <= 3; attempt++)
            {
                try
                {
                    DownloadOptionalFileOnce(url, destination, expectedSha256, minimumBytes, maximumBytes);
                    return;
                }
                catch (Exception ex) when (ex is HttpRequestException || ex is TaskCanceledException ||
                    (ex is IOException && ex is not InvalidDataException))
                {
                    last = ex;
                    try { if (File.Exists(destination)) File.Delete(destination); } catch { }
                    if (attempt >= 3) break;
                    Thread.Sleep(750 * attempt);
                }
            }
            throw new InvalidOperationException("Optional component download failed after 3 attempts.", last);
        }

        private static void DownloadOptionalFileOnce(string url, string destination, string? expectedSha256, long minimumBytes, long maximumBytes)
        {
            var uri = new Uri(url, UriKind.Absolute);
            if (!string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Optional component downloads require HTTPS.");
            Directory.CreateDirectory(Path.GetDirectoryName(destination) ?? throw new InvalidOperationException("Invalid download path."));

            using var handler = new HttpClientHandler { AllowAutoRedirect = true, MaxAutomaticRedirections = 8 };
            using var client = new HttpClient(handler) { Timeout = TimeSpan.FromMinutes(5) };
            client.DefaultRequestHeaders.UserAgent.ParseAdd("Direct-Xfer/" + Program.AppVersion);
            using var response = client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead).GetAwaiter().GetResult();
            response.EnsureSuccessStatusCode();
            var finalUri = response.RequestMessage?.RequestUri;
            if (finalUri == null || !string.Equals(finalUri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Optional component download was redirected outside HTTPS.");
            var declared = response.Content.Headers.ContentLength;
            if (declared.HasValue && declared.Value > maximumBytes)
                throw new InvalidDataException("Optional component download is larger than the allowed limit.");

            using (var input = response.Content.ReadAsStream())
            using (var output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                var buffer = new byte[1024 * 128];
                long total = 0;
                while (true)
                {
                    var read = input.Read(buffer, 0, buffer.Length);
                    if (read <= 0) break;
                    total += read;
                    if (total > maximumBytes) throw new InvalidDataException("Optional component download exceeded the allowed limit.");
                    output.Write(buffer, 0, read);
                }
            }

            var length = new FileInfo(destination).Length;
            if (length < minimumBytes || length > maximumBytes)
                throw new InvalidDataException("Optional component download has an invalid size.");
            if (!string.IsNullOrWhiteSpace(expectedSha256))
            {
                var actual = FileSha256(destination);
                if (!string.Equals(actual, expectedSha256.Trim(), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Optional component SHA-256 verification failed.");
            }
        }

        private static string FileSha256(string path)
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            using var sha = SHA256.Create();
            return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", string.Empty).ToLowerInvariant();
        }

        private static string FileGitBlobSha1(string path)
        {
            var info = new FileInfo(path);
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA1);
            hash.AppendData(Encoding.ASCII.GetBytes("blob " + info.Length.ToString(CultureInfo.InvariantCulture) + "\0"));
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            var buffer = new byte[1024 * 128];
            int read;
            while ((read = stream.Read(buffer, 0, buffer.Length)) > 0) hash.AppendData(buffer, 0, read);
            return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
        }

        private static void VerifyGitBlobSha1(string path, string expected)
        {
            var actual = FileGitBlobSha1(path);
            if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Optional OCR language data failed pinned Git blob verification.");
        }

        private static string RunToolCapture(string fileName, IEnumerable<string> arguments, int timeoutMs)
        {
            using var process = new Process();
            var start = new ProcessStartInfo
            {
                FileName = fileName,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            foreach (var argument in arguments) start.ArgumentList.Add(argument);
            process.StartInfo = start;
            if (!process.Start()) throw new InvalidOperationException("Windows could not start the optional component.");
            var stdout = process.StandardOutput.ReadToEndAsync();
            var stderr = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(timeoutMs))
            {
                try { process.Kill(true); } catch { }
                throw new TimeoutException("Optional component validation timed out.");
            }
            Task.WaitAll(new Task[] { stdout, stderr }, 2000);
            var output = (stdout.IsCompleted ? stdout.Result : string.Empty) + "\n" + (stderr.IsCompleted ? stderr.Result : string.Empty);
            if (process.ExitCode != 0) throw new InvalidOperationException("Optional component validation failed with exit code " + process.ExitCode.ToString(CultureInfo.InvariantCulture) + ".");
            return output.Trim();
        }

        private static void InstallRcloneCore()
        {
            var work = CreateToolWorkDirectory("rclone");
            try
            {
                var zip = Path.Combine(work, "rclone.zip");
                var extract = Path.Combine(work, "extract");
                var url = "https://downloads.rclone.org/v" + Program.RcloneVersion + "/rclone-v" + Program.RcloneVersion + "-windows-amd64.zip";
                DownloadOptionalFile(url, zip, Program.RcloneZipSha256, 1024 * 1024, 100L * 1024 * 1024);
                Directory.CreateDirectory(extract);
                ZipFile.ExtractToDirectory(zip, extract, true);
                var candidates = Directory.GetFiles(extract, "rclone.exe", SearchOption.AllDirectories);
                if (candidates.Length != 1) throw new InvalidDataException("The verified rclone archive did not contain exactly one rclone.exe.");
                var source = Path.GetFullPath(candidates[0]);
                if (!IsAmd64Pe(source)) throw new InvalidDataException("The downloaded rclone executable is not Windows x64.");
                if (!RcloneBinaryMatchesPinnedVersion(source))
                    throw new InvalidDataException("The downloaded rclone version does not match Direct-Xfer's pinned version.");

                var stage = Path.Combine(work, "stage");
                Directory.CreateDirectory(stage);
                File.Copy(source, Path.Combine(stage, "rclone.exe"), true);
                File.WriteAllText(Path.Combine(stage, "DIRECT-XFER-README.txt"),
                    "Direct-Xfer optional rclone v" + Program.RcloneVersion + Environment.NewLine +
                    "Downloaded only after user activation." + Environment.NewLine +
                    "Archive SHA-256: " + Program.RcloneZipSha256 + Environment.NewLine,
                    new UTF8Encoding(false));
                WriteActivationMarker(Path.Combine(stage, Program.OptionalActivationMarkerFileName), "rclone-verified-download");
                Directory.CreateDirectory(Path.GetDirectoryName(OptionalRcloneRoot) ?? OptionalToolsRoot);
                if (Directory.Exists(OptionalRcloneRoot)) Directory.Delete(OptionalRcloneRoot, true);
                Directory.Move(stage, OptionalRcloneRoot);
            }
            finally
            {
                try { if (Directory.Exists(work)) Directory.Delete(work, true); } catch { }
            }
        }

        private static void InstallTesseractCore()
        {
            var work = CreateToolWorkDirectory("tesseract");
            try
            {
                var setup = Path.Combine(work, "tesseract-setup.exe");
                var url = "https://github.com/tesseract-ocr/tesseract/releases/download/" + Program.TesseractVersion +
                    "/tesseract-ocr-w64-setup-" + Program.TesseractPackageVersion + ".exe";
                DownloadOptionalFile(url, setup, Program.TesseractSetupSha256, 20L * 1024 * 1024, 250L * 1024 * 1024);

                Directory.CreateDirectory(Path.GetDirectoryName(OptionalTesseractRoot) ?? OptionalToolsRoot);
                if (Directory.Exists(OptionalTesseractRoot)) Directory.Delete(OptionalTesseractRoot, true);
                using (var install = new Process())
                {
                    install.StartInfo = new ProcessStartInfo
                    {
                        FileName = setup,
                        Arguments = "/CurrentUser /S /D=" + OptionalTesseractRoot,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        WindowStyle = ProcessWindowStyle.Hidden
                    };
                    if (!install.Start()) throw new InvalidOperationException("Windows could not start the Tesseract installer.");
                    if (!install.WaitForExit(240000))
                    {
                        try { install.Kill(true); } catch { }
                        throw new TimeoutException("Tesseract installation timed out.");
                    }
                    if (install.ExitCode != 0) throw new InvalidOperationException("Tesseract installation failed with exit code " + install.ExitCode.ToString(CultureInfo.InvariantCulture) + ".");
                }

                if (!File.Exists(OptionalTesseractPath) || !IsAmd64Pe(OptionalTesseractPath))
                    throw new InvalidDataException("Tesseract did not install a valid Windows x64 executable.");
                Directory.CreateDirectory(OptionalTessdataPath);
                foreach (var model in new[]
                {
                    (Language: "eng", GitBlobSha1: Program.TessdataEngGitBlobSha1),
                    (Language: "fra", GitBlobSha1: Program.TessdataFraGitBlobSha1),
                    (Language: "spa", GitBlobSha1: Program.TessdataSpaGitBlobSha1)
                })
                {
                    var modelPath = Path.Combine(OptionalTessdataPath, model.Language + ".traineddata");
                    var modelUrl = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/" + Program.TessdataFastCommit + "/" + model.Language + ".traineddata";
                    DownloadOptionalFile(modelUrl, modelPath, null, 100 * 1024, 50L * 1024 * 1024);
                    VerifyGitBlobSha1(modelPath, model.GitBlobSha1);
                }

                if (!TesseractBinaryMatchesPinnedVersion(OptionalTesseractPath))
                    throw new InvalidDataException("The downloaded Tesseract version does not match Direct-Xfer's pinned version.");
                var langsOutput = RunToolCapture(OptionalTesseractPath,
                    new[] { "--list-langs", "--tessdata-dir", OptionalTessdataPath }, 10000);
                var languages = langsOutput.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                    .Select(line => line.Trim()).ToHashSet(StringComparer.OrdinalIgnoreCase);
                if (!new[] { "eng", "fra", "spa" }.All(languages.Contains))
                    throw new InvalidDataException("Tesseract did not expose all Direct-Xfer OCR languages after installation.");
                File.WriteAllText(Path.Combine(OptionalTesseractRoot, "DIRECT-XFER-README.txt"),
                    "Direct-Xfer optional Tesseract OCR " + Program.TesseractVersion + Environment.NewLine +
                    "Downloaded only after user activation." + Environment.NewLine +
                    "Setup SHA-256: " + Program.TesseractSetupSha256 + Environment.NewLine +
                    "tessdata_fast commit: " + Program.TessdataFastCommit + Environment.NewLine +
                    "OCR languages: eng, fra, spa" + Environment.NewLine,
                    new UTF8Encoding(false));
                WriteActivationMarker(OptionalTesseractActivationMarker, "tesseract-verified-download");
            }
            catch
            {
                // If the upstream installer created registry/uninstall metadata before a
                // later model/probe failure, use its own uninstaller when available before
                // deleting any remaining partial files.
                try { RemoveTesseractCore(); } catch { }
                throw;
            }
            finally
            {
                try { if (Directory.Exists(work)) Directory.Delete(work, true); } catch { }
            }
        }

        private static void StopPreviousBackend(LauncherSession? session, int timeoutMs)
        {
            if (session == null || session.serverPid <= 0 || session.serverStartedUtcTicks <= 0 ||
                string.IsNullOrWhiteSpace(session.nodePath) || !Path.IsPathRooted(session.nodePath)) return;
            try
            {
                using var process = Process.GetProcessById(session.serverPid);
                // launcher-session.json survives crashes. PID reuse must never let an old session
                // terminate an unrelated process, so validate both process creation time and the
                // exact Node executable path published by ServerHost before waiting or killing.
                var started = GetProcessStartUtcTicks(process);
                if (started <= 0 || started != session.serverStartedUtcTicks) return;
                var actualPath = process.MainModule?.FileName;
                if (string.IsNullOrWhiteSpace(actualPath) ||
                    !string.Equals(Path.GetFullPath(actualPath), Path.GetFullPath(session.nodePath), StringComparison.OrdinalIgnoreCase)) return;
                if (process.WaitForExit(timeoutMs)) return;
                try { process.Kill(true); }
                catch (Exception ex) { throw new InvalidOperationException("Direct-Xfer could not stop the previous backend before optional component replacement or removal.", ex); }
                if (!process.WaitForExit(5000))
                    throw new TimeoutException("Direct-Xfer backend did not stop before optional component replacement or removal.");
            }
            catch (ArgumentException) { }
        }

        private static long GetProcessStartUtcTicks(Process? process)
        {
            try { return process != null ? process.StartTime.ToUniversalTime().Ticks : 0L; }
            catch { return 0L; }
        }

        private static void StopOptionalToolProcesses(string tool)
        {
            var expectedPath = string.Equals(tool, "rclone", StringComparison.OrdinalIgnoreCase)
                ? OptionalRclonePath
                : OptionalTesseractPath;
            var processName = string.Equals(tool, "rclone", StringComparison.OrdinalIgnoreCase) ? "rclone" : "tesseract";
            string expectedFull;
            try { expectedFull = Path.GetFullPath(expectedPath); }
            catch { return; }
            foreach (var process in Process.GetProcessesByName(processName))
            {
                using (process)
                {
                    try
                    {
                        var actual = process.MainModule?.FileName;
                        if (string.IsNullOrWhiteSpace(actual) ||
                            !string.Equals(Path.GetFullPath(actual), expectedFull, StringComparison.OrdinalIgnoreCase)) continue;
                        process.Kill(true);
                        process.WaitForExit(5000);
                    }
                    catch { }
                }
            }
        }

        private static void RemoveRcloneCore()
        {
            if (Directory.Exists(OptionalRcloneRoot)) Directory.Delete(OptionalRcloneRoot, true);
            DeleteParentIfEmpty(Path.GetDirectoryName(OptionalRcloneRoot));
        }

        private static void RemoveTesseractCore()
        {
            var uninstaller = Path.Combine(OptionalTesseractRoot, "tesseract-uninstall.exe");
            if (File.Exists(uninstaller))
            {
                using var process = Process.Start(new ProcessStartInfo
                {
                    FileName = uninstaller,
                    // NSIS normally spawns a temporary copy of an uninstaller and lets the
                    // original process exit early. _?= keeps this process as the real uninstaller,
                    // making WaitForExit/ExitCode authoritative and preventing a delete race.
                    Arguments = "/CurrentUser /S _?=" + OptionalTesseractRoot,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                });
                if (process == null) throw new InvalidOperationException("Windows could not start the Tesseract uninstaller.");
                if (!process.WaitForExit(120000))
                {
                    try { process.Kill(true); } catch { }
                    throw new TimeoutException("Tesseract removal timed out.");
                }
                if (process.ExitCode != 0)
                    throw new InvalidOperationException("Tesseract removal failed with exit code " + process.ExitCode.ToString(CultureInfo.InvariantCulture) + ".");
            }
            if (Directory.Exists(OptionalTesseractRoot)) Directory.Delete(OptionalTesseractRoot, true);
            DeleteParentIfEmpty(Path.GetDirectoryName(OptionalTesseractRoot));
        }

        private static void DeleteParentIfEmpty(string? directory)
        {
            try
            {
                if (!string.IsNullOrWhiteSpace(directory) && Directory.Exists(directory) && !Directory.EnumerateFileSystemEntries(directory).Any())
                    Directory.Delete(directory, false);
            }
            catch { }
        }

        private const int TrayOpen = 1001;
        private const int TrayLogs = 1002;
        private const int TrayConfigure = 1003;
        private const int TrayResetPassword = 1004;
        private const int TrayRcloneStatus = 1101;
        private const int TrayRcloneRemove = 1102;
        private const int TrayRcloneInstall = 1103;
        private const int TrayTesseractStatus = 1201;
        private const int TrayTesseractRemove = 1202;
        private const int TrayTesseractInstall = 1203;
        private const int TrayLanguageFr = 1301;
        private const int TrayLanguageEn = 1302;
        private const int TrayLanguageEs = 1303;
        private const int TrayStop = 1401;

        private NativeMenuBuilder BuildTrayMenu()
        {
            var tr = Tr;
            var menu = new NativeMenuBuilder();
            menu.AddItem(TrayOpen, tr.Open);
            menu.AddItem(TrayLogs, tr.Logs);
            menu.AddItem(TrayConfigure, tr.Configure);
            menu.AddItem(TrayResetPassword, tr.ResetAdminPassword);

            var optional = menu.AddSubMenu(tr.OptionalComponents, !_optionalToolBusy);
            if (OptionalRcloneInstalled())
            {
                optional.AddItem(TrayRcloneStatus, tr.RcloneActive, false);
                optional.AddItem(TrayRcloneRemove, tr.RemoveRclone);
            }
            else optional.AddItem(TrayRcloneInstall, tr.ActivateRclone);
            optional.AddSeparator();
            if (OptionalTesseractInstalled())
            {
                optional.AddItem(TrayTesseractStatus, tr.TesseractActive, false);
                optional.AddItem(TrayTesseractRemove, tr.RemoveTesseract);
            }
            else optional.AddItem(TrayTesseractInstall, tr.ActivateTesseract);

            menu.AddSeparator();
            var languages = menu.AddSubMenu(tr.Language);
            languages.AddItem(TrayLanguageFr, "Français");
            languages.AddItem(TrayLanguageEn, "English");
            languages.AddItem(TrayLanguageEs, "Español");
            menu.AddSeparator();
            menu.AddItem(TrayStop, tr.Stop, !_optionalToolBusy);
            return menu;
        }

        private void HandleTrayCommand(int command)
        {
            switch (command)
            {
                case TrayOpen: OpenBrowser(); break;
                case TrayLogs: OpenLogs(); break;
                case TrayConfigure: ConfigureFolders(false); break;
                case TrayResetPassword: OpenPasswordReset(); break;
                case TrayRcloneRemove: _ = RemoveOptionalToolAsync("rclone"); break;
                case TrayRcloneInstall: _ = InstallOptionalToolAsync("rclone"); break;
                case TrayTesseractRemove: _ = RemoveOptionalToolAsync("tesseract"); break;
                case TrayTesseractInstall: _ = InstallOptionalToolAsync("tesseract"); break;
                case TrayLanguageFr: SetLanguage("fr"); break;
                case TrayLanguageEn: SetLanguage("en"); break;
                case TrayLanguageEs: SetLanguage("es"); break;
                case TrayStop: if (!_optionalToolBusy) RequestExit(); break;
            }
        }

        private void RebuildTrayMenu()
        {
            _tray.UpdateTooltip($"Direct-Xfer {Program.AppVersion}");
        }

        private void SetLanguage(string language)
        {
            if (language != "fr" && language != "en" && language != "es") return;
            var previous = _config.language;
            _config.language = language;
            try { SaveConfig(); RebuildTrayMenu(); }
            catch (Exception ex)
            {
                _config.language = previous;
                NativeUi.Error(_tray.WindowHandle, Tr.AppTitle, ex.Message);
            }
        }

        private void ExistingInstanceSignalLoop(CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                try { if (_openEvent.WaitOne(500)) Ui(OpenBrowser); }
                catch { return; }
            }
        }

        private void Ui(Action action)
        {
            if (_disposed) return;
            _tray.Post(action);
        }

        private void RequestExit()
        {
            lock (_exitSync)
            {
                if (_exiting) return;
                _exiting = true;
                _tray.Hide();
            }
            _tray.Exit();
        }

        private static void SignalServerHostReload()
        {
            try { using (var evt = EventWaitHandle.OpenExisting(Program.ServerHostReloadEventName)) evt.Set(); }
            catch { }
        }

        private bool IsServerHostRunning()
        {
            return TryAttachReadySession(ReadSession());
        }

        private static LauncherSession? ReadSession()
        {
            try
            {
                if (!File.Exists(SessionPath)) return null;
                var info = new FileInfo(SessionPath);
                if (info.Length <= 0 || info.Length > 64 * 1024) return null;
                if ((File.GetAttributes(SessionPath) & FileAttributes.ReparsePoint) != 0) return null;
                var session = Json.Deserialize<LauncherSession>(File.ReadAllText(SessionPath, Encoding.UTF8));
                if (session == null || session.hostPid <= 0 || session.serverPid <= 0 ||
                    session.serverStartedUtcTicks <= 0 || session.port < Program.DefaultPort || session.port > Program.MaxFallbackPort) return null;
                if (string.IsNullOrWhiteSpace(session.token) || session.token.Length != 48 ||
                    !session.token.All(IsHexDigit) || string.IsNullOrWhiteSpace(session.hostBuild)) return null;
                if (string.IsNullOrWhiteSpace(session.hostPath) || !Path.IsPathRooted(session.hostPath) ||
                    string.IsNullOrWhiteSpace(session.nodePath) || !Path.IsPathRooted(session.nodePath)) return null;
                return session;
            }
            catch { return null; }
        }

        private static bool IsHexDigit(char value)
        {
            return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f') || (value >= 'A' && value <= 'F');
        }

        private static string TailFile(string path, int maxBytes)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return string.Empty;
                using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    var length = Math.Min(stream.Length, maxBytes);
                    stream.Seek(-length, SeekOrigin.End);
                    var buffer = new byte[(int)length];
                    var read = stream.Read(buffer, 0, buffer.Length);
                    return Encoding.UTF8.GetString(buffer, 0, read).Trim();
                }
            }
            catch { return string.Empty; }
        }

        internal int Run()
        {
            return _tray.RunMessageLoop();
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            _lifetime.Cancel();
            try { _openEvent.Dispose(); } catch { }
            try { _tray.Dispose(); } catch { }
            _lifetime.Dispose();
        }
    }

    internal sealed class Texts
    {
        internal string AppTitle = string.Empty, Open = string.Empty, Logs = string.Empty, Configure = string.Empty, ResetAdminPassword = string.Empty, Language = string.Empty, Stop = string.Empty;
        internal string OptionalComponents = string.Empty, ActivateRclone = string.Empty, RemoveRclone = string.Empty, RcloneActive = string.Empty, ActivateTesseract = string.Empty, RemoveTesseract = string.Empty, TesseractActive = string.Empty;
        internal string OptionalInstallConfirm = string.Empty, OptionalRemoveConfirm = string.Empty, OptionalInstalling = string.Empty, OptionalInstalled = string.Empty, OptionalRemoved = string.Empty, OptionalFailed = string.Empty, OptionalCleanupFailed = string.Empty, OptionalBusyOtherSession = string.Empty;
        internal string FirstRunTitle = string.Empty, FirstRunBody = string.Empty, PickHost = string.Empty, PickInbox = string.Empty, PickImages = string.Empty;
        internal string ConfigSaved = string.Empty, ConfigSavedRestart = string.Empty, StartError = string.Empty, ServerStopped = string.Empty, ServerHostUnavailable = string.Empty, LogLabel = string.Empty, PortFallback = string.Empty, NoFreePort = string.Empty;
        internal string ResetPasswordError = string.Empty, ResetPasswordEnvManaged = string.Empty;
        internal string InitialPasswordTitle = string.Empty, InitialPasswordError = string.Empty, InitialPasswordIntro = string.Empty, InitialPasswordAccount = string.Empty;
        internal string InitialPasswordLabel = string.Empty, InitialPasswordSave = string.Empty, InitialPasswordCopy = string.Empty, InitialPasswordOK = string.Empty;

        internal static Texts For(string language)
        {
            switch (language)
            {
                case "fr":
                    return new Texts
                    {
                        AppTitle = "Direct-Xfer " + Program.AppVersion, Open = "Ouvrir Direct-Xfer", Logs = "Ouvrir les journaux",
                        Configure = "Configurer les dossiers…", ResetAdminPassword = "Réinitialiser le mot de passe admin…",
                        Language = "Langue", Stop = "Quitter la systray",
                        OptionalComponents = "Composants optionnels", ActivateRclone = "Activer rclone (télécharger)…", RemoveRclone = "Désactiver et supprimer rclone", RcloneActive = "✓ rclone 1.74.4 activé",
                        ActivateTesseract = "Activer Tesseract OCR (télécharger)…", RemoveTesseract = "Désactiver et supprimer Tesseract OCR", TesseractActive = "✓ Tesseract OCR 5.5.3 activé",
                        OptionalInstallConfirm = "{0} est optionnel et n’est pas inclus dans l’installateur Direct-Xfer. Le télécharger et l’activer maintenant ?",
                        OptionalRemoveConfirm = "Désactiver et supprimer {0} de cet utilisateur ?", OptionalInstalling = "Téléchargement et installation de {0}…",
                        OptionalInstalled = "{0} est installé et activé. Direct-Xfer recharge le serveur.", OptionalRemoved = "{0} a été désactivé et supprimé.", OptionalFailed = "Impossible de modifier {0}.\r\n\r\n{1}", OptionalCleanupFailed = "{0} a bien été désactivé, mais certains fichiers n’ont pas pu être supprimés.\r\n\r\n{1}", OptionalBusyOtherSession = "Une autre session Direct-Xfer modifie déjà les composants optionnels. Réessayez dans quelques instants.",
                        FirstRunTitle = "Direct-Xfer - Configuration du premier démarrage",
                        FirstRunBody = "Choisissez les dossiers utilisés par Direct-Xfer. Vous pourrez les modifier plus tard depuis l’icône près de l’heure.",
                        PickHost = "Choisir le dossier à partager / parcourir", PickInbox = "Choisir le dossier des fichiers reçus",
                        PickImages = "Choisir le dossier des images", ConfigSaved = "Configuration enregistrée.",
                        ConfigSavedRestart = "Configuration enregistrée. Le serveur recharge les nouveaux dossiers.",
                        StartError = "Impossible de démarrer Direct-Xfer", ServerStopped = "Le serveur Direct-Xfer s’est arrêté",
                        ServerHostUnavailable = "Le composant Direct-Xfer Server Host n’est pas prêt. Vérifiez son démarrage automatique Windows ou réinstallez Direct-Xfer.",
                        LogLabel = "Journal", PortFallback = "Le port {0} est déjà utilisé. Direct-Xfer utilisera le port {1} pour cette session.",
                        NoFreePort = "Aucun port libre n’a été trouvé entre {0} et {1}.",
                        ResetPasswordError = "Impossible d’ouvrir la réinitialisation du mot de passe administrateur.",
                        ResetPasswordEnvManaged = "Le mot de passe propriétaire est géré par ADMIN_PASSWORD et ne peut pas être réinitialisé depuis la systray.",
                        InitialPasswordTitle = "Mot de passe administrateur",
                        InitialPasswordError = "Le mot de passe administrateur initial a été généré, mais le launcher n’a pas pu l’afficher. Utilisez « Réinitialiser le mot de passe admin… » dans la systray pour définir un nouveau mot de passe.",
                        InitialPasswordIntro = "Un mot de passe administrateur a été généré automatiquement.",
                        InitialPasswordAccount = "Compte : {0}", InitialPasswordLabel = "Mot de passe :",
                        InitialPasswordSave = "Enregistrez-le maintenant : il ne sera affiché qu’une seule fois. Vous devrez le remplacer après votre première connexion.",
                        InitialPasswordCopy = "Copier le mot de passe", InitialPasswordOK = "OK"
                    };
                case "es":
                    return new Texts
                    {
                        AppTitle = "Direct-Xfer " + Program.AppVersion, Open = "Abrir Direct-Xfer", Logs = "Abrir registros",
                        Configure = "Configurar carpetas…", ResetAdminPassword = "Restablecer la contraseña de administrador…",
                        Language = "Idioma", Stop = "Salir de la bandeja",
                        OptionalComponents = "Componentes opcionales", ActivateRclone = "Activar rclone (descargar)…", RemoveRclone = "Desactivar y eliminar rclone", RcloneActive = "✓ rclone 1.74.4 activado",
                        ActivateTesseract = "Activar Tesseract OCR (descargar)…", RemoveTesseract = "Desactivar y eliminar Tesseract OCR", TesseractActive = "✓ Tesseract OCR 5.5.3 activado",
                        OptionalInstallConfirm = "{0} es opcional y no está incluido en el instalador de Direct-Xfer. ¿Descargarlo y activarlo ahora?",
                        OptionalRemoveConfirm = "¿Desactivar y eliminar {0} para este usuario?", OptionalInstalling = "Descargando e instalando {0}…",
                        OptionalInstalled = "{0} está instalado y activado. Direct-Xfer está recargando el servidor.", OptionalRemoved = "{0} se desactivó y eliminó.", OptionalFailed = "No se pudo modificar {0}.\r\n\r\n{1}", OptionalCleanupFailed = "{0} se desactivó correctamente, pero algunos archivos no pudieron eliminarse.\r\n\r\n{1}", OptionalBusyOtherSession = "Otra sesión de Direct-Xfer ya está modificando los componentes opcionales. Inténtalo de nuevo en unos instantes.",
                        FirstRunTitle = "Direct-Xfer - Configuración del primer inicio",
                        FirstRunBody = "Elige las carpetas que usará Direct-Xfer. Podrás cambiarlas más tarde desde el icono de la bandeja del sistema.",
                        PickHost = "Elegir la carpeta para compartir / explorar", PickInbox = "Elegir la carpeta de archivos recibidos",
                        PickImages = "Elegir la carpeta de imágenes", ConfigSaved = "Configuración guardada.",
                        ConfigSavedRestart = "Configuración guardada. El servidor está recargando las nuevas carpetas.",
                        StartError = "No se pudo iniciar Direct-Xfer", ServerStopped = "El servidor Direct-Xfer se detuvo",
                        ServerHostUnavailable = "Direct-Xfer Server Host no está listo. Comprueba su inicio automático de Windows o reinstala Direct-Xfer.",
                        LogLabel = "Registro", PortFallback = "El puerto {0} ya está en uso. Direct-Xfer usará el puerto {1} durante esta sesión.",
                        NoFreePort = "No se encontró ningún puerto libre entre {0} y {1}.",
                        ResetPasswordError = "No se pudo abrir el restablecimiento de la contraseña de administrador.",
                        ResetPasswordEnvManaged = "La contraseña del propietario está gestionada por ADMIN_PASSWORD y no puede restablecerse desde la bandeja del sistema.",
                        InitialPasswordTitle = "Contraseña de administrador",
                        InitialPasswordError = "La contraseña inicial de administrador se generó, pero el launcher no pudo mostrarla. Usa « Restablecer la contraseña de administrador… » desde la bandeja del sistema para definir una nueva contraseña.",
                        InitialPasswordIntro = "Se generó automáticamente una contraseña de administrador.",
                        InitialPasswordAccount = "Cuenta: {0}", InitialPasswordLabel = "Contraseña:",
                        InitialPasswordSave = "Guárdala ahora: solo se mostrará una vez. Tendrás que reemplazarla después de iniciar sesión por primera vez.",
                        InitialPasswordCopy = "Copiar contraseña", InitialPasswordOK = "Aceptar"
                    };
                default:
                    return new Texts
                    {
                        AppTitle = "Direct-Xfer " + Program.AppVersion, Open = "Open Direct-Xfer", Logs = "Open logs",
                        Configure = "Configure folders…", ResetAdminPassword = "Reset admin password…",
                        Language = "Language", Stop = "Exit tray",
                        OptionalComponents = "Optional components", ActivateRclone = "Activate rclone (download)…", RemoveRclone = "Deactivate and remove rclone", RcloneActive = "✓ rclone 1.74.4 active",
                        ActivateTesseract = "Activate Tesseract OCR (download)…", RemoveTesseract = "Deactivate and remove Tesseract OCR", TesseractActive = "✓ Tesseract OCR 5.5.3 active",
                        OptionalInstallConfirm = "{0} is optional and is not included in the Direct-Xfer installer. Download and activate it now?",
                        OptionalRemoveConfirm = "Deactivate and remove {0} for this user?", OptionalInstalling = "Downloading and installing {0}…",
                        OptionalInstalled = "{0} is installed and active. Direct-Xfer is reloading the server.", OptionalRemoved = "{0} was deactivated and removed.", OptionalFailed = "Could not change {0}.\r\n\r\n{1}", OptionalCleanupFailed = "{0} was deactivated successfully, but some files could not be removed.\r\n\r\n{1}", OptionalBusyOtherSession = "Another Direct-Xfer session is already modifying optional components. Try again in a moment.",
                        FirstRunTitle = "Direct-Xfer - First-run setup",
                        FirstRunBody = "Choose the folders used by Direct-Xfer. You can change them later from the system tray icon.",
                        PickHost = "Choose the folder to share / browse", PickInbox = "Choose the received-files folder",
                        PickImages = "Choose the images folder", ConfigSaved = "Configuration saved.",
                        ConfigSavedRestart = "Configuration saved. The server is reloading the new folders.",
                        StartError = "Direct-Xfer could not be started", ServerStopped = "The Direct-Xfer server stopped",
                        ServerHostUnavailable = "Direct-Xfer Server Host is not ready. Check its Windows auto-start entry or reinstall Direct-Xfer.",
                        LogLabel = "Log", PortFallback = "Port {0} is already in use. Direct-Xfer will use port {1} for this session.",
                        NoFreePort = "No free port was found between {0} and {1}.",
                        ResetPasswordError = "The administrator password reset page could not be opened.",
                        ResetPasswordEnvManaged = "The owner password is managed by ADMIN_PASSWORD and cannot be reset from the system tray.",
                        InitialPasswordTitle = "Administrator password",
                        InitialPasswordError = "The initial administrator password was generated, but the launcher could not display it. Use “Reset admin password…” from the system tray to define a new password.",
                        InitialPasswordIntro = "An administrator password was generated automatically.",
                        InitialPasswordAccount = "Account: {0}", InitialPasswordLabel = "Password:",
                        InitialPasswordSave = "Save it now: it will only be displayed once. You will be required to replace it after your first sign-in.",
                        InitialPasswordCopy = "Copy password", InitialPasswordOK = "OK"
                    };
            }
        }
    }
}
