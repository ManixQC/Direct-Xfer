using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
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
[assembly: AssemblyVersion("1.59.0.0")]
[assembly: AssemblyFileVersion("1.59.0.0")]
[assembly: AssemblyInformationalVersion("1.59.0-launcher26-csharp")]

namespace DirectXfer.WindowsLauncher
{
    internal static class Program
    {
        internal const string AppVersion = "1.59.0";
        internal const string RuntimeAppBuild = "1.59.0-launcher26-csharp";
        internal const int DefaultPort = 55750;
        internal const int MaxFallbackPort = 55769;
        internal const int StartupReadyTimeoutMs = 30000;
        internal const string NodeVersion = "24.19.0";
        internal const string NodeExeSha256 = "3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237";
        internal const string MutexName = @"Local\DirectXferLauncherInstance";
        internal const string OpenEventName = @"Local\DirectXferLauncherOpen";

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
                    {
                        Application.Run(context);
                    }
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
                using (var evt = EventWaitHandle.OpenExisting(OpenEventName))
                {
                    evt.Set();
                }
            }
            catch
            {
                // A second launch must never attempt to manipulate another process.
                // If the first instance is still starting, the user can retry shortly.
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

    internal sealed class LauncherSession
    {
        public int pid;
        public int port;
        public string scheme;
        public string token;
        public string nodePath;
        public string runtimeBuild;
        public long startedUtcTicks;
    }

    internal sealed class LauncherContext : ApplicationContext, IDisposable
    {
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };

        private static readonly IDictionary<string, string> CriticalRuntimeSha256 =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                { "package.json", "bb3486f7caaf97ed0736f582e429571235c6b99ec9ebc60076ccdcdb1bc392f1" },
                { "package-lock.json", "647cf8e243cdf72e25e5611011625b9b6204da1f73ab9fdd7036b1b1a941e903" },
                { "server.js", "7c2a8108ab4598ea519ba80f68b8e67bab60056ac6df70fe20fe7aa47c0b7b1d" },
                { "public/app.js", "3477fcd489c396a3b0d77940d72952b0c9742b778411bb31f4c9e42aad56e0b9" },
                { "pwa/app.js", "3d2b24d0a5af74990c293acf2c846f477305e0c1549b5e87e54bdd0235b41df6" },
                { "node_modules/express/package.json", "c7db3b72582355c80cdcef1ad7b2c9a8f53557550724c6bef8502e9818c2ebe7" }
            };

        private readonly Control _dispatcher;
        private readonly NotifyIcon _tray;
        private readonly EventWaitHandle _openEvent;
        private readonly CancellationTokenSource _lifetime = new CancellationTokenSource();
        private readonly object _logSync = new object();
        private readonly object _exitSync = new object();
        private StreamWriter _logWriter;
        private Process _server;
        private LauncherConfig _config;
        private LauncherConfig _runtimeConfig;
        private string _runtimeLogPath;
        private string _token;
        private string _runtimeScheme = "http";
        private int _runtimePort = Program.DefaultPort;
        private bool _exiting;
        private bool _expectedServerStop;
        private bool _disposed;
        private string _shutdownMarkerPath;

        internal LauncherContext(string[] args)
        {
            _dispatcher = new Control();
            _dispatcher.CreateControl();

            bool exists;
            _config = LoadConfig(out exists);
            if (!exists)
            {
                ConfigureFolders(true);
            }
            else
            {
                EnsureConfigDirectories(_config);
            }

            if (args.Any(a => string.Equals(a, "--configure", StringComparison.OrdinalIgnoreCase)))
                ConfigureFolders(false);

            _tray = new NotifyIcon
            {
                Icon = LoadApplicationIcon(),
                Text = "Direct-Xfer " + Program.AppVersion,
                Visible = true
            };
            _tray.MouseClick += (s, e) =>
            {
                if (e.Button == MouseButtons.Left)
                    OpenBrowser();
            };
            _tray.MouseDoubleClick += (s, e) =>
            {
                if (e.Button == MouseButtons.Left)
                    OpenBrowser();
            };
            RebuildTrayMenu();

            bool eventCreated;
            _openEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.OpenEventName, out eventCreated);
            Task.Run(() => ExistingInstanceSignalLoop(_lifetime.Token));

            Microsoft.Win32.SystemEvents.SessionEnding += OnSessionEnding;

            try
            {
                StartServer();
            }
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
                if (string.IsNullOrWhiteSpace(p))
                    p = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
                if (string.IsNullOrWhiteSpace(p))
                    p = Path.GetTempPath();
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
                    var raw = File.ReadAllText(candidate, Encoding.UTF8);
                    var cfg = Json.Deserialize<LauncherConfig>(raw);
                    if (cfg == null) continue;
                    if (cfg.language != "fr" && cfg.language != "en" && cfg.language != "es")
                        cfg.language = DetectLanguage();
                    cfg.version = Program.AppVersion;

                    // A .bak can remain if Windows stops between the atomic replace and
                    // cleanup. If it is the first valid copy, heal the primary file.
                    if (!string.Equals(candidate, ConfigPath, StringComparison.OrdinalIgnoreCase))
                    {
                        try { WriteTextAtomic(ConfigPath, Json.Serialize(cfg)); } catch { }
                    }
                    exists = true;
                    return cfg;
                }
                catch { }
            }

            exists = false;
            return fallback;
        }

        private void SaveConfig()
        {
            Directory.CreateDirectory(BaseDirectory);
            _config.version = Program.AppVersion;
            WriteTextAtomic(ConfigPath, Json.Serialize(_config));
        }

        private static void WriteTextAtomic(string path, string content)
        {
            var directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            var temp = path + ".tmp-" + Guid.NewGuid().ToString("N");
            var backup = path + ".bak";
            try
            {
                File.WriteAllText(temp, content, new UTF8Encoding(false));
                if (!File.Exists(path))
                {
                    File.Move(temp, path);
                    return;
                }

                try
                {
                    File.Replace(temp, path, backup, true);
                    try { if (File.Exists(backup)) File.Delete(backup); } catch { }
                }
                catch (PlatformNotSupportedException)
                {
                    File.Copy(temp, path, true);
                }
                catch (IOException)
                {
                    File.Copy(temp, path, true);
                }
            }
            finally
            {
                try { if (File.Exists(temp)) File.Delete(temp); } catch { }
            }
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
            if (firstRun)
                MessageBox.Show(tr.FirstRunBody, tr.FirstRunTitle, MessageBoxButtons.OK, MessageBoxIcon.Information);

            var next = CloneConfig(_config);
            next.hostRoot = PickFolder(tr.PickHost, next.hostRoot);
            next.inboxDir = PickFolder(tr.PickInbox, next.inboxDir);
            next.imagesDir = PickFolder(tr.PickImages, next.imagesDir);

            try
            {
                EnsureConfigDirectories(next);
                var previous = _config;
                _config = next;
                try { SaveConfig(); }
                catch { _config = previous; throw; }

                if (!firstRun)
                {
                    MessageBox.Show(_server != null && !_server.HasExited ? tr.ConfigSavedRestart : tr.ConfigSaved,
                        tr.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, tr.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static LauncherConfig CloneConfig(LauncherConfig c)
        {
            return new LauncherConfig
            {
                version = c.version,
                dataDir = c.dataDir,
                logsDir = c.logsDir,
                inboxDir = c.inboxDir,
                hostRoot = c.hostRoot,
                imagesDir = c.imagesDir,
                openBrowser = c.openBrowser,
                language = c.language
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
                    ? dlg.SelectedPath
                    : initial;
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

        private static string RuntimeRoot { get { return Path.Combine(PortableRoot, "runtime"); } }
        private static string PortableNodePath { get { return Path.Combine(RuntimeRoot, "node", "node.exe"); } }

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

            var expected = Path.Combine(RuntimeRoot, "app");
            throw new InvalidDataException(
                "Direct-Xfer application runtime is missing or invalid.\r\n\r\n" +
                "Expected runtime folder:\r\n" + expected + "\r\n\r\n" +
                string.Join("\r\n", failures.ToArray()) + "\r\n\r\n" +
                "Extract the complete GitHub Actions artifact before launching Direct-Xfer.exe. " +
                "Do not run the EXE directly from inside a ZIP and do not move the EXE away from its runtime folder.");
        }

        private static bool ApplicationRuntimeValid(string root)
        {
            string reason;
            return TryValidateApplicationRuntime(root, out reason);
        }

        private static bool TryValidateApplicationRuntime(string root, out string reason)
        {
            try
            {
                if (!Directory.Exists(root))
                {
                    reason = "folder not found";
                    return false;
                }

                var marker = Path.Combine(root, ".dx-runtime-build");
                if (!File.Exists(marker))
                {
                    reason = "missing .dx-runtime-build marker";
                    return false;
                }

                var markerValue = File.ReadAllText(marker, Encoding.ASCII).Trim();
                if (!string.Equals(markerValue, Program.RuntimeAppBuild, StringComparison.Ordinal))
                {
                    reason = "runtime build mismatch (found " + markerValue + ", expected " + Program.RuntimeAppBuild + ")";
                    return false;
                }

                foreach (var required in new[]
                {
                    "package.json", "server.js", Path.Combine("public", "app.js"),
                    Path.Combine("node_modules", "express", "package.json")
                })
                {
                    var file = Path.Combine(root, required);
                    if (!File.Exists(file))
                    {
                        reason = "missing " + required;
                        return false;
                    }
                    if (new FileInfo(file).Length == 0)
                    {
                        reason = "empty " + required;
                        return false;
                    }
                }

                var packagePath = Path.Combine(root, "package.json");
                var package = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(packagePath, Encoding.UTF8));
                object versionValue;
                var packageVersion = package != null && package.TryGetValue("version", out versionValue)
                    ? Convert.ToString(versionValue, CultureInfo.InvariantCulture)
                    : string.Empty;
                if (!string.Equals(packageVersion, Program.AppVersion, StringComparison.Ordinal))
                {
                    reason = "package.json version mismatch (found " + packageVersion + ", expected " + Program.AppVersion + ")";
                    return false;
                }

                foreach (var pair in CriticalRuntimeSha256)
                {
                    var file = Path.Combine(root, pair.Key.Replace('/', Path.DirectorySeparatorChar));
                    if (!File.Exists(file))
                    {
                        reason = "missing integrity file " + pair.Key;
                        return false;
                    }

                    // Every file in CriticalRuntimeSha256 is text. Normalize CRLF/CR to LF so
                    // a Windows Git checkout cannot invalidate an otherwise identical runtime.
                    var actual = TextFileSha256Normalized(file);
                    if (!string.Equals(actual, pair.Value, StringComparison.OrdinalIgnoreCase))
                    {
                        reason = "integrity check failed for " + pair.Key + " (SHA-256 " + actual + ")";
                        return false;
                    }
                }

                reason = string.Empty;
                return true;
            }
            catch (Exception ex)
            {
                reason = ex.GetType().Name + ": " + ex.Message;
                return false;
            }
        }

        private static string TextFileSha256Normalized(string path)
        {
            var text = File.ReadAllText(path, new UTF8Encoding(false, true));
            text = text.Replace("\r\n", "\n").Replace("\r", "\n");
            var bytes = new UTF8Encoding(false).GetBytes(text);
            using (var sha = SHA256.Create())
            {
                var hash = sha.ComputeHash(bytes);
                return BitConverter.ToString(hash).Replace("-", string.Empty).ToLowerInvariant();
            }
        }

        private static string FileSha256(string path)
        {
            using (var sha = SHA256.Create())
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                var hash = sha.ComputeHash(stream);
                return BitConverter.ToString(hash).Replace("-", string.Empty).ToLowerInvariant();
            }
        }

        private static IEnumerable<string> NodeCandidates()
        {
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            // Prefer the hash-pinned Node.js runtime shipped beside Direct-Xfer.
            // Environment/system fallbacks are only used when the bundled runtime is unavailable.
            var raw = new List<string>
            {
                PortableNodePath,
                Environment.GetEnvironmentVariable("DX_WINDOWS_NODE")
            };
            var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            if (!string.IsNullOrWhiteSpace(pf)) raw.Add(Path.Combine(pf, "nodejs", "node.exe"));
            var pfx = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            if (!string.IsNullOrWhiteSpace(pfx)) raw.Add(Path.Combine(pfx, "nodejs", "node.exe"));
            raw.Add(FindOnPath("node.exe"));

            foreach (var value in raw)
            {
                if (string.IsNullOrWhiteSpace(value)) continue;
                string full;
                try { full = Path.GetFullPath(value.Trim()); } catch { continue; }
                if (seen.Add(full)) yield return full;
            }
        }

        private static string FindOnPath(string name)
        {
            var path = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
            foreach (var dir in path.Split(Path.PathSeparator))
            {
                if (string.IsNullOrWhiteSpace(dir)) continue;
                try
                {
                    var candidate = Path.Combine(dir.Trim(), name);
                    if (File.Exists(candidate)) return candidate;
                }
                catch { }
            }
            return null;
        }

        private string EnsureNode()
        {
            foreach (var candidate in NodeCandidates())
                if (NodeUsable(candidate)) return candidate;
            throw new FileNotFoundException(Tr.NodeMissing);
        }

        private static bool NodeUsable(string path)
        {
            try
            {
                if (!File.Exists(path)) return false;
                if (string.Equals(Path.GetFullPath(path), Path.GetFullPath(PortableNodePath), StringComparison.OrdinalIgnoreCase) &&
                    !string.Equals(FileSha256(path), Program.NodeExeSha256, StringComparison.OrdinalIgnoreCase)) return false;

                using (var process = new Process())
                {
                    process.StartInfo = new ProcessStartInfo
                    {
                        FileName = path,
                        Arguments = "--version",
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        WindowStyle = ProcessWindowStyle.Hidden
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
                    var dot = output.IndexOf('.');
                    if (dot >= 0) output = output.Substring(0, dot);
                    int major;
                    // Keep system fallbacks aligned with package.json and the current
                    // production dependency tree: Node 20 LTS or Node 22+ only.
                    return process.ExitCode == 0 &&
                           int.TryParse(output, NumberStyles.Integer, CultureInfo.InvariantCulture, out major) &&
                           (major == 20 || major >= 22);
                }
            }
            catch { return false; }
        }

        private static int ChooseRuntimePort()
        {
            for (var port = Program.DefaultPort; port <= Program.MaxFallbackPort; port++)
            {
                TcpListener listener = null;
                try
                {
                    listener = new TcpListener(IPAddress.Any, port);
                    listener.Start();
                    return port;
                }
                catch (SocketException) { }
                finally { try { if (listener != null) listener.Stop(); } catch { } }
            }
            throw new InvalidOperationException(string.Format(Texts.For(DetectLanguage()).NoFreePort,
                Program.DefaultPort, Program.MaxFallbackPort));
        }

        private static string RandomToken()
        {
            var bytes = new byte[24];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
            return BitConverter.ToString(bytes).Replace("-", string.Empty).ToLowerInvariant();
        }

        private void StartServer()
        {
            EnsureConfigDirectories(_config);
            var appDir = EnsureApplicationRuntime();
            var node = EnsureNode();
            _runtimeConfig = CloneConfig(_config);
            _runtimeLogPath = Path.Combine(_runtimeConfig.logsDir, "Direct-Xfer-Windows.log");
            RotateLog(_runtimeLogPath, 10L * 1024 * 1024);
            _logWriter = new StreamWriter(new FileStream(_runtimeLogPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite),
                new UTF8Encoding(false)) { AutoFlush = true };

            RecoverSavedSession();
            _runtimePort = ChooseRuntimePort();
            if (_runtimePort != Program.DefaultPort)
                MessageBox.Show(string.Format(Tr.PortFallback, Program.DefaultPort, _runtimePort), Tr.AppTitle,
                    MessageBoxButtons.OK, MessageBoxIcon.Information);

            _token = RandomToken();
            _runtimeScheme = "http";
            _shutdownMarkerPath = Path.Combine(_runtimeConfig.dataDir, ".dx-windows-clean-shutdown");
            try { if (File.Exists(_shutdownMarkerPath)) File.Delete(_shutdownMarkerPath); } catch { }

            var start = new ProcessStartInfo
            {
                FileName = node,
                Arguments = "server.js",
                WorkingDirectory = appDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            start.EnvironmentVariables["PORT"] = _runtimePort.ToString(CultureInfo.InvariantCulture);
            start.EnvironmentVariables["BIND"] = "0.0.0.0";
            start.EnvironmentVariables["DATA_DIR"] = _runtimeConfig.dataDir;
            start.EnvironmentVariables["INBOX_DIR"] = _runtimeConfig.inboxDir;
            start.EnvironmentVariables["HOST_ROOT"] = _runtimeConfig.hostRoot;
            start.EnvironmentVariables["IMAGES_DIR"] = _runtimeConfig.imagesDir;
            start.EnvironmentVariables["NO_COLOR"] = "1";
            start.EnvironmentVariables["DX_WINDOWS_LAUNCHER_TOKEN"] = _token;
            start.EnvironmentVariables["DX_WINDOWS_SHUTDOWN_MARKER"] = _shutdownMarkerPath;

            _server = new Process { StartInfo = start, EnableRaisingEvents = true };
            _server.OutputDataReceived += (s, e) => AppendServerLog(e.Data);
            _server.ErrorDataReceived += (s, e) => AppendServerLog(e.Data);
            _server.Exited += OnServerExited;
            if (!_server.Start()) throw new InvalidOperationException("Node.js did not start.");
            _server.BeginOutputReadLine();
            _server.BeginErrorReadLine();

            WriteSession(new LauncherSession
            {
                pid = _server.Id,
                port = _runtimePort,
                scheme = _runtimeScheme,
                token = _token,
                nodePath = node,
                runtimeBuild = Program.RuntimeAppBuild,
                startedUtcTicks = GetProcessStartUtcTicks(_server)
            });

            Task.Run(() => WaitForReadyAndCompleteStartup(_server.Id, _lifetime.Token));
        }

        private void AppendServerLog(string line)
        {
            if (line == null) return;
            lock (_logSync)
            {
                try { if (_logWriter != null) _logWriter.WriteLine(line); } catch { }
            }
        }

        private void WaitForReadyAndCompleteStartup(int pid, CancellationToken token)
        {
            var readyWait = Stopwatch.StartNew();
            while (!token.IsCancellationRequested && !_exiting && readyWait.ElapsedMilliseconds < Program.StartupReadyTimeoutMs)
            {
                string scheme;
                if (TryReady(_runtimePort, _token, _runtimeScheme, pid, out scheme))
                {
                    _runtimeScheme = scheme;
                    WriteSession(new LauncherSession
                    {
                        pid = pid,
                        port = _runtimePort,
                        scheme = scheme,
                        token = _token,
                        nodePath = _server.StartInfo.FileName,
                        runtimeBuild = Program.RuntimeAppBuild,
                        startedUtcTicks = GetProcessStartUtcTicks(_server)
                    });

                    Ui(() =>
                    {
                        if (_exiting) return;
                        ShowInitialAdminPassword();
                        if (_runtimeConfig.openBrowser && !_exiting) OpenBrowser();
                    });
                    return;
                }
                Thread.Sleep(100);
            }

            if (token.IsCancellationRequested || _exiting) return;
            try { if (_server == null || _server.HasExited) return; } catch { return; }

            // A live-but-never-ready child used to leave a dead tray icon indefinitely.
            // Surface the server log and shut down the exact child process instead.
            _expectedServerStop = true;
            var details = TailFile(_runtimeLogPath, 4096);
            var body = Tr.StartError + ".\r\n" + Tr.LogLabel + ": " + _runtimeLogPath;
            if (!string.IsNullOrWhiteSpace(details)) body += "\r\n\r\n" + details;
            Ui(() =>
            {
                if (_exiting) return;
                MessageBox.Show(body, Tr.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
                RequestExit();
            });
        }

        private static bool TryReady(int port, string token, string preferredScheme, int expectedPid, out string usedScheme)
        {
            usedScheme = preferredScheme;
            foreach (var scheme in SchemeCandidates(preferredScheme))
            {
                try
                {
                    using (var response = LauncherRequest("GET", port, "/__dx_launcher/ready", token, scheme, 900))
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
            if (string.Equals(preferred, "https", StringComparison.OrdinalIgnoreCase))
            {
                yield return "https";
                yield return "http";
            }
            else
            {
                yield return "http";
                yield return "https";
            }
        }

        private static HttpWebResponse LauncherRequest(string method, int port, string route, string token,
            string scheme, int timeoutMs)
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
            {
                // The HTTPS exception is scoped to this authenticated 127.0.0.1 request only.
                request.ServerCertificateValidationCallback = (sender, certificate, chain, errors) => true;
            }
            return (HttpWebResponse)request.GetResponse();
        }

        private static HttpWebResponse LauncherRequestAnyScheme(string method, int port, string route, string token,
            string preferred, int timeoutMs, out string usedScheme)
        {
            Exception last = null;
            foreach (var scheme in SchemeCandidates(preferred))
            {
                try
                {
                    var response = LauncherRequest(method, port, route, token, scheme, timeoutMs);
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
                        using (var dialog = new InitialPasswordForm(Tr, username, password))
                            dialog.ShowDialog();
                    }
                }
            }
            catch
            {
                MessageBox.Show(Tr.InitialPasswordError, Tr.InitialPasswordTitle,
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
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
                        MessageBox.Show(Tr.ResetPasswordEnvManaged, Tr.AppTitle,
                            MessageBoxButtons.OK, MessageBoxIcon.Warning);
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
            catch
            {
                MessageBox.Show(Tr.ResetPasswordError, Tr.AppTitle,
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
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
                ? Convert.ToString(value, CultureInfo.InvariantCulture)
                : null;
        }

        private void OpenBrowser()
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
            try { Process.Start(new ProcessStartInfo(value) { UseShellExecute = true }); } catch { }
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
            try
            {
                SaveConfig();
                RebuildTrayMenu();
            }
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
                try
                {
                    if (_openEvent.WaitOne(500)) Ui(OpenBrowser);
                }
                catch { return; }
            }
        }

        private void Ui(Action action)
        {
            if (_disposed || _dispatcher.IsDisposed) return;
            try
            {
                if (_dispatcher.InvokeRequired) _dispatcher.BeginInvoke(action);
                else action();
            }
            catch (ObjectDisposedException) { }
            catch (InvalidOperationException) { }
        }

        private void OnServerExited(object sender, EventArgs e)
        {
            int exitCode = -1;
            try { exitCode = _server.ExitCode; } catch { }
            if (ConsumeCleanShutdownMarker()) _expectedServerStop = true;
            CloseLogWriter();
            ClearSession(_server != null ? _server.Id : 0);

            Ui(() =>
            {
                var wasExpected = _exiting || _expectedServerStop || exitCode == 0;
                _exiting = true;
                if (!wasExpected && exitCode != 0)
                {
                    var details = TailFile(_runtimeLogPath, 4096);
                    var body = Tr.ServerStopped + " (code " + exitCode + ").\r\n" + Tr.LogLabel + ": " + _runtimeLogPath;
                    if (!string.IsNullOrWhiteSpace(details)) body += "\r\n\r\n" + details;
                    MessageBox.Show(body, Tr.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                _tray.Visible = false;
                ExitThread();
            });
        }

        private void RequestExit()
        {
            lock (_exitSync)
            {
                if (_exiting) return;
                _exiting = true;
                _tray.Visible = false;
            }

            Task.Run(() =>
            {
                StopServer();
                Ui(ExitThread);
            });
        }

        private void StopServer()
        {
            var server = _server;
            if (server == null) return;
            try { if (server.HasExited) return; } catch { return; }

            try
            {
                string scheme;
                using (var response = LauncherRequestAnyScheme("POST", _runtimePort, "/__dx_launcher/shutdown",
                    _token, _runtimeScheme, 800, out scheme))
                {
                    _runtimeScheme = scheme;
                }
            }
            catch { }

            try
            {
                if (server.WaitForExit(6000)) return;
            }
            catch { return; }

            // Last-resort fallback applies only to the exact child process created by this launcher.
            try { server.Kill(); } catch { }
            try { server.WaitForExit(1000); } catch { }
        }

        private void RecoverSavedSession()
        {
            var session = ReadSession();
            if (session == null) return;

            string usedScheme;
            if (TryReady(session.port, session.token, session.scheme, session.pid, out usedScheme))
            {
                try
                {
                    using (LauncherRequest("POST", session.port, "/__dx_launcher/shutdown", session.token, usedScheme, 700)) { }
                }
                catch { }
                if (WaitForProcessExit(session.pid, 2600))
                {
                    ClearSession(session.pid);
                    return;
                }
            }

            // If the saved server is wedged, only touch the exact saved PID when its executable
            // still resolves to the exact Node executable path and process start time recorded in this private session.
            try
            {
                using (var process = Process.GetProcessById(session.pid))
                {
                    var actual = process.MainModule != null ? process.MainModule.FileName : null;
                    var sameExecutable = !string.IsNullOrWhiteSpace(actual) && !string.IsNullOrWhiteSpace(session.nodePath) &&
                        string.Equals(Path.GetFullPath(actual), Path.GetFullPath(session.nodePath), StringComparison.OrdinalIgnoreCase);
                    var sameStart = session.startedUtcTicks > 0 &&
                        GetProcessStartUtcTicks(process) == session.startedUtcTicks;
                    if (sameExecutable && sameStart)
                    {
                        process.Kill();
                        process.WaitForExit(1800);
                    }
                }
            }
            catch { }
            ClearSession(session.pid);
        }

        private static long GetProcessStartUtcTicks(Process process)
        {
            try { return process != null ? process.StartTime.ToUniversalTime().Ticks : 0L; }
            catch { return 0L; }
        }

        private static bool WaitForProcessExit(int pid, int timeoutMs)
        {
            try
            {
                using (var process = Process.GetProcessById(pid)) return process.WaitForExit(timeoutMs);
            }
            catch { return true; }
        }

        private static LauncherSession ReadSession()
        {
            try
            {
                if (!File.Exists(SessionPath)) return null;
                var session = Json.Deserialize<LauncherSession>(File.ReadAllText(SessionPath, Encoding.UTF8));
                return session != null && session.pid > 0 && session.port > 0 && !string.IsNullOrEmpty(session.token)
                    ? session : null;
            }
            catch { return null; }
        }

        private static void WriteSession(LauncherSession session)
        {
            try
            {
                Directory.CreateDirectory(BaseDirectory);
                WriteTextAtomic(SessionPath, Json.Serialize(session));
            }
            catch { }
        }

        private static void ClearSession(int pid)
        {
            try
            {
                var current = ReadSession();
                if (current != null && pid > 0 && current.pid != pid) return;
                if (File.Exists(SessionPath)) File.Delete(SessionPath);
            }
            catch { }
        }

        private bool ConsumeCleanShutdownMarker()
        {
            try
            {
                if (string.IsNullOrWhiteSpace(_shutdownMarkerPath) || !File.Exists(_shutdownMarkerPath)) return false;
                File.Delete(_shutdownMarkerPath);
                return true;
            }
            catch { return false; }
        }

        private static void RotateLog(string path, long maxBytes)
        {
            if (!File.Exists(path) || new FileInfo(path).Length < maxBytes) return;
            try { if (File.Exists(path + ".3")) File.Delete(path + ".3"); } catch { }
            TryMove(path + ".2", path + ".3");
            TryMove(path + ".1", path + ".2");
            TryMove(path, path + ".1");
        }

        private static void TryMove(string source, string destination)
        {
            try
            {
                if (!File.Exists(source)) return;
                if (File.Exists(destination)) File.Delete(destination);
                File.Move(source, destination);
            }
            catch { }
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

        private void CloseLogWriter()
        {
            lock (_logSync)
            {
                try { if (_logWriter != null) _logWriter.Flush(); } catch { }
                try { if (_logWriter != null) _logWriter.Dispose(); } catch { }
                _logWriter = null;
            }
        }

        private void OnSessionEnding(object sender, Microsoft.Win32.SessionEndingEventArgs e)
        {
            _expectedServerStop = true;
            _exiting = true;
            StopServer();
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
            Microsoft.Win32.SystemEvents.SessionEnding -= OnSessionEnding;
            try { StopServer(); } catch { }
            try { _openEvent.Dispose(); } catch { }
            try { _tray.Visible = false; _tray.Dispose(); } catch { }
            try { _dispatcher.Dispose(); } catch { }
            try { if (_server != null) _server.Dispose(); } catch { }
            CloseLogWriter();
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
        internal string ConfigSaved, ConfigSavedRestart, StartError, ServerStopped, LogLabel, PortFallback, NoFreePort;
        internal string ResetPasswordError, ResetPasswordEnvManaged, NodeMissing;
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
                        Language = "Langue", Stop = "Arrêter Direct-Xfer",
                        FirstRunTitle = "Direct-Xfer - Configuration du premier démarrage",
                        FirstRunBody = "Choisissez les dossiers utilisés par Direct-Xfer. Vous pourrez les modifier plus tard depuis l’icône près de l’heure.",
                        PickHost = "Choisir le dossier à partager / parcourir", PickInbox = "Choisir le dossier des fichiers reçus",
                        PickImages = "Choisir le dossier des images", ConfigSaved = "Configuration enregistrée.",
                        ConfigSavedRestart = "Configuration enregistrée. Les nouveaux dossiers seront utilisés au prochain démarrage de Direct-Xfer.",
                        StartError = "Impossible de démarrer Direct-Xfer", ServerStopped = "Le serveur Direct-Xfer s’est arrêté",
                        LogLabel = "Journal", PortFallback = "Le port {0} est déjà utilisé. Direct-Xfer utilisera le port {1} pour cette session.",
                        NoFreePort = "Aucun port libre n’a été trouvé entre {0} et {1}.",
                        ResetPasswordError = "Impossible d’ouvrir la réinitialisation du mot de passe administrateur.",
                        ResetPasswordEnvManaged = "Le mot de passe propriétaire est géré par ADMIN_PASSWORD et ne peut pas être réinitialisé depuis la systray.",
                        NodeMissing = "Runtime Node.js introuvable. Installez Node.js LTS avec la méthode approuvée par votre organisation ou placez un node.exe approuvé dans runtime\node.",
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
                        Language = "Idioma", Stop = "Detener Direct-Xfer",
                        FirstRunTitle = "Direct-Xfer - Configuración del primer inicio",
                        FirstRunBody = "Elige las carpetas que usará Direct-Xfer. Podrás cambiarlas más tarde desde el icono de la bandeja del sistema.",
                        PickHost = "Elegir la carpeta para compartir / explorar", PickInbox = "Elegir la carpeta de archivos recibidos",
                        PickImages = "Elegir la carpeta de imágenes", ConfigSaved = "Configuración guardada.",
                        ConfigSavedRestart = "Configuración guardada. Las nuevas carpetas se usarán la próxima vez que se inicie Direct-Xfer.",
                        StartError = "No se pudo iniciar Direct-Xfer", ServerStopped = "El servidor Direct-Xfer se detuvo",
                        LogLabel = "Registro", PortFallback = "El puerto {0} ya está en uso. Direct-Xfer usará el puerto {1} durante esta sesión.",
                        NoFreePort = "No se encontró ningún puerto libre entre {0} y {1}.",
                        ResetPasswordError = "No se pudo abrir el restablecimiento de la contraseña de administrador.",
                        ResetPasswordEnvManaged = "La contraseña del propietario está gestionada por ADMIN_PASSWORD y no puede restablecerse desde la bandeja del sistema.",
                        NodeMissing = "No se encontró el runtime de Node.js. Instala Node.js LTS mediante el método aprobado por tu organización o coloca un node.exe aprobado en runtime\node.",
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
                        Language = "Language", Stop = "Stop Direct-Xfer",
                        FirstRunTitle = "Direct-Xfer - First-run setup",
                        FirstRunBody = "Choose the folders used by Direct-Xfer. You can change them later from the system tray icon.",
                        PickHost = "Choose the folder to share / browse", PickInbox = "Choose the received-files folder",
                        PickImages = "Choose the images folder", ConfigSaved = "Configuration saved.",
                        ConfigSavedRestart = "Configuration saved. The new folders will be used the next time Direct-Xfer starts.",
                        StartError = "Direct-Xfer could not be started", ServerStopped = "The Direct-Xfer server stopped",
                        LogLabel = "Log", PortFallback = "Port {0} is already in use. Direct-Xfer will use port {1} for this session.",
                        NoFreePort = "No free port was found between {0} and {1}.",
                        ResetPasswordError = "The administrator password reset page could not be opened.",
                        ResetPasswordEnvManaged = "The owner password is managed by ADMIN_PASSWORD and cannot be reset from the system tray.",
                        NodeMissing = "Node.js runtime not found. Install Node.js LTS using your organization-approved method or place an approved node.exe in runtime\node.",
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
