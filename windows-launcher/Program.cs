using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Security;
using System.Reflection;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("Direct-Xfer")]
[assembly: AssemblyDescription("Direct-Xfer Windows launcher")]
[assembly: AssemblyCompany("Direct-Xfer")]
[assembly: AssemblyProduct("Direct-Xfer")]
[assembly: AssemblyCopyright("Copyright © Direct-Xfer 2026")]
[assembly: AssemblyVersion("1.64.0.0")]
[assembly: AssemblyFileVersion("1.64.0.0")]
[assembly: AssemblyInformationalVersion("1.64.0-launcher53-csharp")]

namespace DirectXfer.WindowsLauncher
{
    internal static class Program
    {
        internal const string AppVersion = "1.64.0";
        internal const string RuntimeAppBuild = "1.64.0-launcher53-csharp";
        internal const string ServerHostFileName = "Direct-Xfer.ServerHost.exe";
        internal const string ServerHostVersion = "1.64.0.0";
        internal const int DefaultPort = 55750;
        internal const int StartupReadyTimeoutMs = 30000;
        internal const string MutexName = @"Local\DirectXferLauncherInstance";
        internal const string OpenEventName = @"Local\DirectXferLauncherOpen";
        internal const string ServerHostBuild = "1.64.0-serverhost26-csharp";
        internal const string ServerHostReloadEventName = @"Local\DirectXferServerHostReload";

        [STAThread]
        private static void Main(string[] args)
        {
            bool createdNew;
            using (var mutex = new Mutex(true, MutexName, out createdNew))
            {
                if (!createdNew)
                {
                    SignalExistingInstance();
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                try
                {
                    using (var context = new LauncherContext(args ?? new string[0]))
                        Application.Run(context);
                }
                catch (Exception ex)
                {
                    MessageBox.Show(ex.Message, "Direct-Xfer", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                finally
                {
                    try { mutex.ReleaseMutex(); } catch { }
                }
            }
        }

        private static void SignalExistingInstance()
        {
            try
            {
                using (var evt = EventWaitHandle.OpenExisting(OpenEventName)) evt.Set();
            }
            catch { }
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

    internal sealed class LauncherSession
    {
        public int hostPid { get; set; }
        public long hostStartedUtcTicks { get; set; }
        public string hostPath { get; set; }
        public int serverPid { get; set; }
        public int port { get; set; }
        public string scheme { get; set; }
        public string token { get; set; }
        public string runtimeBuild { get; set; }
        public string hostBuild { get; set; }
    }

    internal sealed class LauncherContext : ApplicationContext, IDisposable
    {
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
        private readonly Control _dispatcher;
        private readonly NotifyIcon _tray;
        private readonly EventWaitHandle _openEvent;
        private readonly CancellationTokenSource _lifetime = new CancellationTokenSource();
        private readonly object _exitSync = new object();
        private LauncherConfig _config;
        private string _runtimeLogPath;
        private string _token;
        private string _runtimeScheme = "http";
        private int _runtimePort;
        private bool _exiting;
        private bool _disposed;

        internal LauncherContext(string[] args)
        {
            _dispatcher = new Control();
            _dispatcher.CreateControl();

            bool exists;
            _config = LoadConfig(out exists);
            if (!exists) ConfigureFolders(true);
            else EnsureConfigDirectories(_config);

            if (args.Any(a => string.Equals(a, "--configure", StringComparison.OrdinalIgnoreCase)))
                ConfigureFolders(false);

            _tray = new NotifyIcon
            {
                Icon = LoadApplicationIcon(),
                Text = "Direct-Xfer " + Program.AppVersion,
                Visible = true
            };
            _tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) OpenBrowser(); };
            _tray.MouseDoubleClick += (s, e) => { if (e.Button == MouseButtons.Left) OpenBrowser(); };
            RebuildTrayMenu();

            bool eventCreated;
            _openEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.OpenEventName, out eventCreated);
            Task.Run(() => ExistingInstanceSignalLoop(_lifetime.Token));
            try { AttachToServerHost(); }
            catch (Exception ex)
            {
                _tray.Visible = false;
                MessageBox.Show(Tr.StartError + ":\r\n" + ex.Message, Tr.AppTitle,
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                _dispatcher.BeginInvoke(new Action(ExitThread));
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
            if (firstRun) MessageBox.Show(tr.FirstRunBody, tr.FirstRunTitle, MessageBoxButtons.OK, MessageBoxIcon.Information);
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
                    MessageBox.Show(running ? tr.ConfigSavedRestart : tr.ConfigSaved,
                        tr.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            }
            catch (Exception ex) { MessageBox.Show(ex.Message, tr.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error); }
        }

        private static LauncherConfig CloneConfig(LauncherConfig c)
        {
            return new LauncherConfig
            {
                version = c.version, dataDir = c.dataDir, logsDir = c.logsDir, inboxDir = c.inboxDir,
                hostRoot = c.hostRoot, imagesDir = c.imagesDir, openBrowser = c.openBrowser, language = c.language
            };
        }

        private static string PickFolder(string title, string initial)
        {
            using (var dlg = new FolderBrowserDialog
            {
                Description = title,
                SelectedPath = Directory.Exists(initial) ? initial : string.Empty,
                ShowNewFolderButton = true
            })
            {
                return dlg.ShowDialog() == DialogResult.OK && !string.IsNullOrWhiteSpace(dlg.SelectedPath)
                    ? dlg.SelectedPath : initial;
            }
        }

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

        private string LocalCaCertificatePath
        {
            get { return string.IsNullOrWhiteSpace(_config.dataDir) ? null : Path.Combine(_config.dataDir, "tls", "local-ca-cert.pem"); }
        }

        private static string ExpectedServerHostPath
        {
            get { return Path.Combine(PortableRoot, Program.ServerHostFileName); }
        }

        private static bool ServerHostFileMatchesSession(LauncherSession session)
        {
            if (session == null || string.IsNullOrWhiteSpace(session.hostPath) ||
                !string.Equals(session.hostBuild, Program.ServerHostBuild, StringComparison.Ordinal)) return false;
            try
            {
                var expected = Path.GetFullPath(ExpectedServerHostPath);
                var reported = Path.GetFullPath(session.hostPath);
                if (!string.Equals(expected, reported, StringComparison.OrdinalIgnoreCase) || !File.Exists(expected)) return false;
                if ((File.GetAttributes(expected) & FileAttributes.ReparsePoint) != 0 || !IsAmd64Pe(expected)) return false;
                var info = FileVersionInfo.GetVersionInfo(expected);
                return string.Equals(info.FileVersion, Program.ServerHostVersion, StringComparison.Ordinal) &&
                    string.Equals(info.ProductName, "Direct-Xfer Server Host", StringComparison.Ordinal);
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

            Task.Run(() => WaitForServerHostReady(_lifetime.Token));
        }

        private bool TryAttachReadySession(LauncherSession session)
        {
            if (session == null || !string.Equals(session.runtimeBuild, Program.RuntimeAppBuild, StringComparison.Ordinal)) return false;
            if (!ServerHostFileMatchesSession(session) || !IsServerHostIpcAlive()) return false;
            string usedScheme;
            if (!TryReady(session.port, session.token, session.scheme, session.serverPid, out usedScheme)) return false;
            _runtimePort = session.port;
            _runtimeScheme = usedScheme;
            _token = session.token;
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
            var body = Tr.ServerHostUnavailable + "\r\n" + Tr.LogLabel + ": " + _runtimeLogPath;
            if (!string.IsNullOrWhiteSpace(details)) body += "\r\n\r\n" + details;
            Ui(() =>
            {
                if (_exiting) return;
                MessageBox.Show(body, Tr.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
                RequestExit();
            });
        }

        private void CompleteStartup()
        {
            if (_exiting) return;
            if (_runtimePort != Program.DefaultPort)
                MessageBox.Show(string.Format(Tr.PortFallback, Program.DefaultPort, _runtimePort), Tr.AppTitle,
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
            ShowInitialAdminPassword();
            if (_config.openBrowser && !_exiting) OpenBrowser();
        }

        private static bool IsServerHostIpcAlive()
        {
            try
            {
                using (var evt = EventWaitHandle.OpenExisting(Program.ServerHostReloadEventName)) return true;
            }
            catch (WaitHandleCannotBeOpenedException) { return false; }
            catch (UnauthorizedAccessException) { return false; }
        }

        private bool TryReady(int port, string token, string preferredScheme, int expectedPid, out string usedScheme)
        {
            usedScheme = preferredScheme;
            if (port <= 0 || expectedPid <= 0 || string.IsNullOrEmpty(token)) return false;
            foreach (var scheme in SchemeCandidates(preferredScheme))
            {
                try
                {
                    using (var response = LauncherRequest("GET", port, "/__dx_launcher/ready", token, scheme, 900, LocalCaCertificatePath))
                    using (var reader = new StreamReader(response.GetResponseStream() ?? Stream.Null))
                    {
                        var body = reader.ReadToEnd();
                        if ((int)response.StatusCode == 200 && body.Contains("\"ok\":true") &&
                            body.Contains("\"pid\":" + expectedPid.ToString(CultureInfo.InvariantCulture)))
                        {
                            usedScheme = scheme;
                            return true;
                        }
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
            var url = scheme + "://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture) + route;
            var request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = method;
            request.Timeout = timeoutMs;
            request.ReadWriteTimeout = timeoutMs;
            request.AllowAutoRedirect = false;
            request.Proxy = null;
            request.KeepAlive = false;
            if (!string.IsNullOrEmpty(token)) request.Headers["X-Direct-Xfer-Launcher-Token"] = token;
            if (string.Equals(scheme, "https", StringComparison.OrdinalIgnoreCase))
                request.ServerCertificateValidationCallback = (sender, certificate, chain, errors) =>
                    ValidateLauncherServerCertificate(certificate, errors, localCaCertificatePath);
            return (HttpWebResponse)request.GetResponse();
        }

        private static bool ValidateLauncherServerCertificate(X509Certificate certificate, SslPolicyErrors errors,
            string localCaCertificatePath)
        {
            if (certificate == null) return false;
            if (errors == SslPolicyErrors.None) return true;
            if ((errors & (SslPolicyErrors.RemoteCertificateNameMismatch | SslPolicyErrors.RemoteCertificateNotAvailable)) != 0) return false;
            if ((errors & ~SslPolicyErrors.RemoteCertificateChainErrors) != 0) return false;
            X509Certificate2 localCa = null, leaf = null;
            X509Chain localChain = null;
            try
            {
                localCa = LoadPemCertificate(localCaCertificatePath);
                if (localCa == null) return false;
                leaf = new X509Certificate2(certificate);
                localChain = new X509Chain();
                localChain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
                localChain.ChainPolicy.VerificationFlags = X509VerificationFlags.AllowUnknownCertificateAuthority;
                localChain.ChainPolicy.ExtraStore.Add(localCa);
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

        private static X509Certificate2 LoadPemCertificate(string path)
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
            return new X509Certificate2(Convert.FromBase64String(compact));
        }

        private HttpWebResponse LauncherRequestAnyScheme(string method, int port, string route, string token,
            string preferred, int timeoutMs, out string usedScheme)
        {
            Exception last = null;
            foreach (var scheme in SchemeCandidates(preferred))
            {
                try
                {
                    var response = LauncherRequest(method, port, route, token, scheme, timeoutMs, LocalCaCertificatePath);
                    usedScheme = scheme;
                    return response;
                }
                catch (Exception ex) { last = ex; }
            }
            usedScheme = preferred;
            throw last ?? new WebException("Direct-Xfer launcher endpoint unavailable.");
        }

        private void ShowInitialAdminPassword()
        {
            if (_exiting || string.IsNullOrEmpty(_token)) return;
            try
            {
                string scheme;
                using (var response = LauncherRequestAnyScheme("POST", _runtimePort,
                    "/__dx_launcher/initial-admin-password", _token, _runtimeScheme, 1500, out scheme))
                {
                    _runtimeScheme = scheme;
                    if (response.StatusCode == HttpStatusCode.NoContent) return;
                    if (response.StatusCode != HttpStatusCode.OK) throw new InvalidDataException();
                    using (var reader = new StreamReader(response.GetResponseStream() ?? Stream.Null))
                    {
                        var payload = Json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                        if (!GetBool(payload, "ok") || !GetBool(payload, "fresh")) return;
                        var username = GetString(payload, "username");
                        var password = GetString(payload, "password");
                        if (string.IsNullOrEmpty(username) || string.IsNullOrEmpty(password)) throw new InvalidDataException();
                        using (var dialog = new InitialPasswordForm(Tr, username, password)) dialog.ShowDialog();
                    }
                }
            }
            catch
            {
                MessageBox.Show(Tr.InitialPasswordError, Tr.InitialPasswordTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void OpenPasswordReset()
        {
            if (_exiting || string.IsNullOrEmpty(_token)) return;
            try
            {
                string scheme;
                HttpWebResponse response = null;
                try
                {
                    response = LauncherRequestAnyScheme("POST", _runtimePort,
                        "/__dx_launcher/reset-admin-password-ticket", _token, _runtimeScheme, 1500, out scheme);
                }
                catch (WebException ex)
                {
                    response = ex.Response as HttpWebResponse;
                    if (response == null) throw;
                    scheme = _runtimeScheme;
                }
                using (response)
                {
                    if (response == null) throw new WebException();
                    if (response.StatusCode == HttpStatusCode.Conflict)
                    {
                        MessageBox.Show(Tr.ResetPasswordEnvManaged, Tr.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        return;
                    }
                    if (response.StatusCode != HttpStatusCode.OK) throw new WebException();
                    _runtimeScheme = scheme;
                    using (var reader = new StreamReader(response.GetResponseStream() ?? Stream.Null))
                    {
                        var payload = Json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                        var ticket = GetString(payload, "ticket");
                        if (!GetBool(payload, "ok") || string.IsNullOrEmpty(ticket)) throw new InvalidDataException();
                        var url = scheme + "://127.0.0.1:" + _runtimePort.ToString(CultureInfo.InvariantCulture) +
                            "/__dx_launcher/reset-admin-password?ticket=" + Uri.EscapeDataString(ticket) +
                            "&lang=" + Uri.EscapeDataString(_config.language);
                        OpenUrl(url);
                    }
                }
            }
            catch { MessageBox.Show(Tr.ResetPasswordError, Tr.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error); }
        }

        private static bool GetBool(IDictionary<string, object> payload, string key)
        {
            object value;
            if (payload == null || !payload.TryGetValue(key, out value) || value == null) return false;
            if (value is bool) return (bool)value;
            bool parsed;
            return bool.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), out parsed) && parsed;
        }

        private static string GetString(IDictionary<string, object> payload, string key)
        {
            object value;
            return payload != null && payload.TryGetValue(key, out value) && value != null
                ? Convert.ToString(value, CultureInfo.InvariantCulture) : null;
        }

        private void OpenBrowser()
        {
            var session = ReadSession();
            if (!TryAttachReadySession(session))
            {
                MessageBox.Show(Tr.ServerHostUnavailable, Tr.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            OpenUrl(_runtimeScheme + "://127.0.0.1:" + _runtimePort.ToString(CultureInfo.InvariantCulture) + "/");
        }

        private void OpenLogs()
        {
            var dir = !string.IsNullOrWhiteSpace(_runtimeLogPath) ? Path.GetDirectoryName(_runtimeLogPath) : _config.logsDir;
            if (!string.IsNullOrWhiteSpace(dir) && Directory.Exists(dir)) OpenUrl(dir);
        }

        private static void OpenUrl(string value)
        {
            try { Process.Start(value); } catch { }
        }

        private void RebuildTrayMenu()
        {
            var tr = Tr;
            var menu = new ContextMenuStrip();
            menu.Items.Add(tr.Open, null, (s, e) => OpenBrowser());
            menu.Items.Add(tr.Logs, null, (s, e) => OpenLogs());
            menu.Items.Add(tr.Configure, null, (s, e) => ConfigureFolders(false));
            menu.Items.Add(tr.ResetAdminPassword, null, (s, e) => OpenPasswordReset());
            menu.Items.Add(new ToolStripSeparator());
            var languages = new ToolStripMenuItem(tr.Language);
            languages.DropDownItems.Add("Français", null, (s, e) => SetLanguage("fr"));
            languages.DropDownItems.Add("English", null, (s, e) => SetLanguage("en"));
            languages.DropDownItems.Add("Español", null, (s, e) => SetLanguage("es"));
            menu.Items.Add(languages);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(tr.Stop, null, (s, e) => RequestExit());
            if (_tray.ContextMenuStrip != null) _tray.ContextMenuStrip.Dispose();
            _tray.ContextMenuStrip = menu;
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
                MessageBox.Show(ex.Message, Tr.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static Icon LoadApplicationIcon()
        {
            try
            {
                var icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location);
                if (icon != null) return icon;
            }
            catch { }
            return SystemIcons.Application;
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
            if (_disposed || _dispatcher.IsDisposed) return;
            try
            {
                if (_dispatcher.InvokeRequired) _dispatcher.BeginInvoke(action); else action();
            }
            catch (ObjectDisposedException) { }
            catch (InvalidOperationException) { }
        }

        private void RequestExit()
        {
            lock (_exitSync)
            {
                if (_exiting) return;
                _exiting = true;
                _tray.Visible = false;
            }
            Ui(ExitThread);
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

        private static LauncherSession ReadSession()
        {
            try
            {
                if (!File.Exists(SessionPath)) return null;
                var session = Json.Deserialize<LauncherSession>(File.ReadAllText(SessionPath, Encoding.UTF8));
                return session != null && session.hostPid > 0 && session.serverPid > 0 && session.port > 0 &&
                    !string.IsNullOrEmpty(session.token) && !string.IsNullOrEmpty(session.hostBuild)
                    ? session : null;
            }
            catch { return null; }
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

        protected override void ExitThreadCore()
        {
            try { _tray.Visible = false; } catch { }
            base.ExitThreadCore();
        }

        public new void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            _lifetime.Cancel();
            try { _openEvent.Dispose(); } catch { }
            try { _tray.Visible = false; _tray.Dispose(); } catch { }
            try { _dispatcher.Dispose(); } catch { }
            _lifetime.Dispose();
            try { base.Dispose(); } catch { }
        }
    }

    internal sealed class InitialPasswordForm : Form
    {
        internal InitialPasswordForm(Texts tr, string username, string password)
        {
            Text = tr.InitialPasswordTitle;
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = true;
            ClientSize = new Size(660, 255);
            Font = SystemFonts.MessageBoxFont;
            Icon = TryApplicationIcon();

            var intro = new Label { Left = 20, Top = 18, Width = 620, Height = 34, Text = tr.InitialPasswordIntro };
            var account = new Label { Left = 20, Top = 56, Width = 620, Height = 24, Text = string.Format(tr.InitialPasswordAccount, username) };
            var label = new Label { Left = 20, Top = 86, Width = 620, Height = 22, Text = tr.InitialPasswordLabel };
            var passwordBox = new TextBox
            {
                Left = 20,
                Top = 108,
                Width = 620,
                Height = 26,
                ReadOnly = true,
                Text = password,
                TabIndex = 0
            };
            var save = new Label { Left = 20, Top = 145, Width = 620, Height = 42, Text = tr.InitialPasswordSave };
            var copy = new Button { Left = 20, Top = 204, Width = 210, Height = 32, Text = tr.InitialPasswordCopy, TabIndex = 1 };
            var ok = new Button { Left = 540, Top = 204, Width = 100, Height = 32, Text = tr.InitialPasswordOK, DialogResult = DialogResult.OK, TabIndex = 2 };

            copy.Click += (s, e) =>
            {
                passwordBox.Focus();
                passwordBox.SelectAll();
                try { Clipboard.SetText(password); } catch { }
            };
            Shown += (s, e) =>
            {
                passwordBox.Focus();
                passwordBox.SelectAll();
            };

            AcceptButton = ok;
            Controls.AddRange(new Control[] { intro, account, label, passwordBox, save, copy, ok });
        }

        private static Icon TryApplicationIcon()
        {
            try { return Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); }
            catch { return null; }
        }
    }

    internal sealed class Texts
    {
        internal string AppTitle, Open, Logs, Configure, ResetAdminPassword, Language, Stop;
        internal string FirstRunTitle, FirstRunBody, PickHost, PickInbox, PickImages;
        internal string ConfigSaved, ConfigSavedRestart, StartError, ServerStopped, ServerHostUnavailable, LogLabel, PortFallback, NoFreePort;
        internal string ResetPasswordError, ResetPasswordEnvManaged;
        internal string InitialPasswordTitle, InitialPasswordError, InitialPasswordIntro, InitialPasswordAccount;
        internal string InitialPasswordLabel, InitialPasswordSave, InitialPasswordCopy, InitialPasswordOK;

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
