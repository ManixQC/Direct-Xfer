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
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;


namespace DirectXfer.WindowsServerHost
{
    internal static class Program
    {
        internal const string AppVersion = "1.70.0";
        internal const string RuntimeAppBuild = "1.70.0-launcher148-csharp";
        internal const string HostVersion = "1.70.0-serverhost121-csharp";
        internal const int DefaultPort = 55750;
        internal const int MaxFallbackPort = 55769;
        internal const int StartupReadyTimeoutMs = 60000;
        internal const int HealthProbeIntervalMs = 5000;
        internal const int HealthProbeFailureThreshold = 3;
        internal const long EmergencyLogMaxBytes = 2L * 1024 * 1024;
        internal const string NodeVersion = "24.19.0";
        internal const string RcloneVersion = "1.75.0";
        internal const string TesseractVersion = "5.5.3";
        internal const string OptionalActivationMarkerFileName = ".direct-xfer-enabled";
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
            // CI/runtime probe: reaching managed code while global DOTNET_ROOT paths are
            // disabled proves ServerHost resolved the packaged app-relative shared runtime.
            if (args.Length == 1 && string.Equals(args[0], "--dx-runtime-probe", StringComparison.Ordinal)) return 0;

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
                { "package.json", "7868a76397971fe81cd89ccc7254178c5fce23458590b39fd5c2943193a2359e" },
                { "package-lock.json", "9300351af26425d3d24a785e6651712cce8c015e7bbe428ca2f0b1c517bc0647" },
                { "server.js", "fee8647ed95b2c9f6f71a943d634b55bfe70adc2cd55607fef2489df1da54a8e" },
                { "lib/core-utils.js", "850ca4c2f187a170035c73ad6301c64a746f7d7cf7ef6d15aadc767f26144f0c" },
                { "lib/server/config.js", "4d7b3f5fed8ec4749fc8768dfdcc6ec246ca1b0f51519ecc0d91b42fdc51d89c" },
                { "lib/server/bootstrap.js", "cb8ab7efada6b7be1d9983bd1ae4d1c8817bf401cfdd60e70537fa39df1aabb9" },
                { "lib/server/lifecycle-service.js", "018c1a1485c5bdec89d52814f9cc52f8b93582ac2fb9370bf8ff8c9650da487f" },
                { "lib/server/application-context.js", "a5f17345980221cfe97687b9e5fcb4267ffdb4ce5c9b6f0ea5c9fdac7f1d08ce" },
                { "lib/server/host-path-service.js", "b1b2b32d1eb6be2b08c42ff9f77c37d61e41d319f0f9bb56fd10c5feeb828a72" },
                { "lib/server/request-utils.js", "0ab190eb36ac1df2bc0a683c78ef2efcfe8b84be0e690acf98f747e3cf35ad59" },
                { "lib/server/windows-launcher-routes.js", "f0432186d7555e7b7767a3c37da1a10de16adb6c9d30fefa027614e49d9f0223" },
                { "lib/server/root-routes.js", "be1d2928e21402d66aebe1616f5338f04e44d4f63ed9ed3a1f4f6699ba36618e" },
                { "lib/server/http-application.js", "ba9d43be7fd3173e6bd4c980b216963561276f65e73f5337ea24d32a98fa96eb" },
                { "lib/server/activity-presence-service.js", "3de3f0f22b2bd323f077b7b82be9cc04ae2d91c075eb18942512f4c12f2c6ade" },
                { "lib/server/share-presentation-service.js", "9ce1280efbd8f4dbc0ae398716a2988c99de5f87a8d7edfa40ad96dab4bf2247" },
                { "lib/server/pwa-routes.js", "bfd2056a3e6669d65e99d5d514891435e5f819b0f47386bcc6f13322727c1b27" },
                { "lib/server/pwa-composition-service.js", "e238dedf67254539dd76c08c52f82cd38de92fe06d1e4b4ec51868fd4db05921" },
                { "lib/server/pwa-application.js", "1f8fafaebeafa796ebc510f1b3fba9b9de79499c66f563674f40a6bde06bc348" },
                { "lib/server/pwa-device-service.js", "a0022c3826ff97dc27aa8d19a4aff740c59eb2c1f1f772a2fee801fe34b1e8d1" },
                { "lib/server/pwa-photo-service.js", "9a917a263d7a9c2b80184615804e733ae2471e851eeb2edd704ff12cf182af4a" },
                { "lib/server/webauthn-service.js", "12aa485e6148279ae0b57595f87fdb740d628f372153b1ae21b831b006e3942a" },
                { "lib/server/pwa-event-service.js", "55723909814dcd4d4bfce47b8fdaac9e4830286550d56c78635bc90e1bcc2d38" },
                { "lib/server/upload-reception-service.js", "3de2f6971e7ca7592485fb4467d1cc5452761e1ab6fb83cf712b1299bb6ec24c" },
                { "lib/server/transfer-service.js", "04e152552f619b1c67bca8b79a359dd258f306627499ce7b304d2eb9e4d2ed80" },
                { "lib/server/download-service.js", "41aa5b68d7c1976751ca0259d0ab099d0ceaa48228b6295d7945fd5ce7ec5079" },
                { "lib/server/search-service.js", "eda5a1e1f286824a4eba320858a12c50434fb594b7a5f816396a421863c5f5b0" },
                { "lib/server/ocr-service.js", "1eb8561a98c7885c540762b25149df5dbc9b11756eb8f4a4e983348a04c9bf7f" },
                { "lib/server/dlp-service.js", "f5710ddf2a7bef2f4eca3eb35a6358e469f2c48ea7af4865e917ebce69a6bbc2" },
                { "lib/server/photo-service.js", "d449780b24e3dfb752bec0890489f5c89ab262dc5782d4bd7abf177ba7f6de9c" },
                { "lib/server/share-service.js", "8a6043646a4dc2dd9e9c7394774ebf3bd0f41686b718c274e95ae6fe58e86cb0" },
                { "lib/server/audit-service.js", "1bd707cc8cdf7b3b3d8b6aa77846f4dc6493143efeccb01c0789a2da6c53d816" },
                { "lib/server/reception-collaboration-routes.js", "d9cb9b5ef697575aa2be40851f3038058eb485e4c16aaebad6ddf877c9475493" },
                { "lib/server/public-share-routes.js", "2ccac17e5de95edeccf892e59bb1a74c594a0653d1257ae1b375c5c1ac60d2b5" },
                { "lib/server/public-access-service.js", "288512f7a7c6ab49801396e7ff55b1e5df2bfe138ca9ea1ae75feec2751d3317" },
                { "lib/server/public-abuse-service.js", "3ce94dafcc421b5aaddc809a3340a1e731d606366fcaa21992a7d61af828054d" },
                { "lib/auth-utils.js", "37e00f036bf56798182b88d393173647f65bfa712d3a26fc3be02552e9dabc04" },
                { "lib/server/account-service.js", "0bbb27b416af36aeea2afdb7814a879feb5ebc5d8bff61c11c001d1776d593b7" },
                { "lib/server/auth-service.js", "d83f98376f3b831e8fd395380be90da04c2a9484a48c47a7de952a53005eb571" },
                { "lib/server/session-service.js", "ede07178a7a6a5e619892020f51b50208b5e4036e7e3f24cd0e1a755833b270b" },
                { "lib/server/state-store.js", "7bb01d633a28ab24f60951e1ae2ad1f55c5b49869434fd6a422d6209246a742d" },
                { "lib/server/state-bootstrap-service.js", "3353f57cb139f2e1e6e2d736dff9fc9c97777d4c80bdb48b2ffd14c7e6064528" },
                { "lib/server/settings-service.js", "1900ee74a259816baee1f2338dbc5863ca39244eb15faf042ede75c0063df956" },
                { "lib/server/system-health-service.js", "20244f73991e4f63202282cf208181f25ba0ebcde7339cfab1617d219cfe7d5c" },
                { "lib/server/diagnostics-service.js", "6e73944b548bf45ebc4c97c6da303ad3d3ae090e66982e7efe6af23c561ee274" },
                { "lib/server/admin-router.js", "db0b201673dfa56e7f2d56916a4feb2463229cb73141744c123c7acc3300c017" },
                { "lib/server/admin-account-routes.js", "bb4873e1fbf49e9f466ae2d04402cde8b3c7c8db5c8afac93933fe2934c9fe75" },
                { "lib/server/admin-security-routes.js", "54683253c6905091ac590626cf32a20f103148fbef19f9f306b4a9963f832812" },
                { "lib/server/admin-storage-routes.js", "f17453119baca310651c53c1203441003f841c116b0883ccf84ec6244ed5c339" },
                { "lib/server/admin-share-routes.js", "7e6266a266b304f8ca265fc4b16ab1d45e27071757ab8180d54110537ec24f47" },
                { "lib/server/admin-photo-routes.js", "3853ed535e9bf4757f22b4e978738b4aae8f927d8d448dcec2883ceed5a40dab" },
                { "lib/server/admin-settings-routes.js", "219ed8bb92cf1503436f9eb2a3beb3cd9c59c45f0d66094e0ce7c909908f7ce6" },
                { "lib/server/admin-dashboard-routes.js", "8e345234f42bfd198af5e8d860b5d6910d7420c38c6664a951f9642bb2e605de" },
                { "lib/server/admin-diagnostics-routes.js", "9eb12228e4ca0f0722d7a8674a22c4681323c33850bab9fa7e16769d36d9901a" },
                { "lib/server/public-pages.js", "de434eac7cef447abbda40604621a354ff6c23320a42823cdcb8969dcc16c533" },
                { "lib/server/tls-manager.js", "b82a1b195b6cb36d47d8d431b890e0479aaf9ca8d47f98e8ef9e046390610f7f" },
                { "lib/server/network-services.js", "0cfd820c0d1a73bc417dfc572419c92a323b271e3b6f8e49b98c56c592168e82" },
                { "lib/server/windows-install-preferences.js", "2ea81b6c40e0e96aaab8ecff8cee6003db8fd943e43d2b2019c12676671b5494" },
                { "lib/server/backup-service.js", "f49d6c2e89044f961680a808e6768f4a6656be73adac0e64f16ece9d4c23d6c7" },
                { "lib/server/restore-service.js", "bf57ba6eb2e57b187df5123f09645b953fe52d2b70a9bda6db96ad63ac5f6ace" },
                { "lib/server/maintenance-service.js", "55e249a41a1a79b7aa61b7993a62389e3a67bf576a68a021454155a918dd9f7b" },
                { "lib/server/storage-connector-job-service.js", "b1ba700f964a10f5e4344482a51c83e1e3d6d325ddb96d18a742547764e6656d" },
                { "lib/server/storage-connector-config.js", "04830567b2b2393510dd69dd8c610765252ef7312218068fceba09ec68125437" },
                { "lib/server/storage-connector-browser.js", "bb3fb333a7d04069cc78151912196dc4eec4d932dcd90bb06ad6de60929c1a7d" },
                { "lib/server/oauth-broker-deployment.js", "f87d48ad2dac90fc4bb725879ee30adfb2013a792fafda1f3fb5e1163b0699d5" },
                { "lib/assets/oauth-broker-worker.mjs", "75b0cc4a7ac1f230c450a486fa3eeb250997c25b0952316309bbd892ccae3d29" },
                { "lib/assets/oauth-broker-schema.sql", "ff745a72b9599399b02f0e81a9c376d7daf2934f86dedec05cce4c1268b5642f" },
                { "lib/google-oauth-profile.js", "6a3cac0ad7c419442f57ee28e53c5f8f15bd3dd6f3bb1a1242a415f941ceaa78" },
                { "lib/google-oauth-broker-client.js", "b64d80e6ce5229b858769e55b2a7420aeaeaa0d8d4b68d4debfc34e991f90f89" },
                { "lib/server/notification-service.js", "e897fe713d6980fdf35a37e4256e1e4632515d29ad0ac90d14a30d6a60d8af54" },
                { "lib/server/notification-center-service.js", "3559e4b8bde5913f81556ad8290bd3dedda03851aef0631af7e3f9c9a11c6298" },
                { "lib/server/pwa-notification-service.js", "4c4e12a775fdd536541496852e1286a1242ca42690ce6a4bb701cfe61bdf5d20" },
                { "public/app.js", "38796d8199de3a959bbd93d792524984c900e51f27ca5542998da190523d5b2f" },
                { "pwa/app.js", "c42bbe2d9a2b657ff356f0678e6d675cf0849dcb11aaf82114f29bbde6fe654e" },
                { "lib/dlp-utils.js", "0d8f768c3457ec713199ce9e82f9483be21df2ea01dce6ead26675d240fde768" },
                { "lib/fd-utils.js", "947deee8d45440f49c4497621b8479f1a92ff4703789099b24aae4a81dd29bb5" },
                { "pwa/dlp-local.js", "246267542621fc92f759438b2295b87f777ba6d6aa88b3c4d23dea25aebe7390" },
                { "lib/storage-connectors.js", "90cc270a3e713b11460d950d013eee737b5aaaf8cb01d53db75ef3e8f4184e91" },
                { "lib/web-storage-share.js", "7a575bd6ed1e98eedd748bc96510e8e85a08eeb3c7dff64608a3fc97b3c8bbdf" },
                { "lib/web-storage-writable.js", "d4a076866d4c09228e261e09405e8a7e3da1a04604c9bbf4c55e2edfac80070f" },
                { "public/index.html", "6f732fa4db094e94e00d12accb492d60418cb810b75c890f70ca7398983c866b" },
                { "public/oauth-bridge.html", "7c08c6d54d523b0ed3976293e99fe7e4f43c01ff359fd4be170dfd0f0ab344c3" },
                { "public/oauth-bridge.css", "32a468581ae0ae93c818fe00217a55cdec62dc5cb4796c748003ad4f71bbbbbb" },
                { "public/oauth-bridge.js", "853b1582d7367eb4a68cd891d568923a3e399abfad442f36d38c06812cb27f3e" },
                { "public/google-oauth-complete.js", "da9a4028d6c3e4e5f3bae22921a18eceb105b89aecd0fc42b21a9bdde86520cc" },
                { "public/style.css", "17f5b1bd8bec7ff4e888e5e4753cde20effe5aef0acb2857b902ac96605b1ea3" },
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
        private string _lastReadyFailure = string.Empty;

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
        private static string InstallUpdateCheckEnableMarker { get { return Path.Combine(BaseDirectory, "install-update-check-enable.flag"); } }
        private static string InstallUpdateCheckDisableMarker { get { return Path.Combine(BaseDirectory, "install-update-check-disable.flag"); } }
        private static string InstallPublicIpEnableMarker { get { return Path.Combine(BaseDirectory, "install-public-ip-enable.flag"); } }
        private static string InstallPublicIpDisableMarker { get { return Path.Combine(BaseDirectory, "install-public-ip-disable.flag"); } }

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
        private static string RuntimeRoot { get { return Path.Combine(PortableRoot, "runtime"); } }
        private static string PortableNodePath { get { return Path.Combine(RuntimeRoot, "node", "node.exe"); } }
        private static string ExternalNodeReceiptPath { get { return Path.Combine(RuntimeRoot, "node", "external-node.ini"); } }
        // rclone and Tesseract are intentionally not part of the default Windows payload.
        // The launcher downloads them only after explicit user activation and stores them
        // under the current user's Direct-Xfer data root. Legacy portable locations remain
        // supported so upgrades from older packages do not break custom/manual layouts.
        private static string OptionalToolsRoot { get { return Path.Combine(BaseDirectory, "tools"); } }
        private static string OptionalRcloneRoot { get { return Path.Combine(OptionalToolsRoot, "rclone", Program.RcloneVersion); } }
        private static string OptionalRclonePath { get { return Path.Combine(OptionalRcloneRoot, "rclone.exe"); } }
        private static string OptionalRcloneActivationMarker { get { return Path.Combine(OptionalRcloneRoot, Program.OptionalActivationMarkerFileName); } }
        private static string OptionalTesseractRoot { get { return Path.Combine(OptionalToolsRoot, "tesseract", Program.TesseractVersion); } }
        private static string OptionalTesseractPath { get { return Path.Combine(OptionalTesseractRoot, "tesseract.exe"); } }
        private static string OptionalTessdataPath { get { return Path.Combine(OptionalTesseractRoot, "tessdata"); } }
        private static string OptionalTesseractActivationMarker { get { return Path.Combine(OptionalTesseractRoot, Program.OptionalActivationMarkerFileName); } }
        private static string PortableRclonePath { get { return Path.Combine(RuntimeRoot, "rclone", "rclone.exe"); } }
        private static string PortableTesseractRoot { get { return Path.Combine(RuntimeRoot, "tesseract"); } }
        private static string PortableTesseractPath { get { return Path.Combine(PortableTesseractRoot, "tesseract.exe"); } }
        private static string PortableTessdataPath { get { return Path.Combine(PortableTesseractRoot, "tessdata"); } }
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
            var startupWatch = Stopwatch.StartNew();
            var validationWatch = Stopwatch.StartNew();

            // Application-integrity verification and Node verification are independent.
            // Running them concurrently removes their cumulative startup cost while
            // preserving the exact same fail-closed checks before Node is launched.
            var appValidation = Task.Run(EnsureApplicationRuntime);
            var nodeValidation = Task.Run(EnsureNode);
            var appDir = appValidation.GetAwaiter().GetResult();
            var node = nodeValidation.GetAwaiter().GetResult();

            OpenRuntimeLog();
            AppendLog("[server-host] Direct-Xfer " + Program.AppVersion + " " + Program.HostVersion + " starting runtime cycle; validation=" +
                validationWatch.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture) + " ms.");

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

            AppendLog("[server-host] server ready on " + _scheme + "://127.0.0.1:" + _port.ToString(CultureInfo.InvariantCulture) +
                "; startup=" + startupWatch.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture) + " ms.");
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
                string full;
                try { full = Path.GetFullPath(value.Trim()); }
                catch { continue; }
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
                var marker = Path.Combine(root, "runtime-build.txt");
                if (!File.Exists(marker))
                {
                    // Compatibility with portable/runtime bundles generated before runtime marker hardening.
                    var legacyMarker = Path.Combine(root, ".dx-runtime-build");
                    if (File.Exists(legacyMarker)) marker = legacyMarker;
                    else { reason = "missing runtime marker (runtime-build.txt)"; return false; }
                }
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
            // node.exe is tens of megabytes. SequentialScan plus a large userspace
            // buffer avoids thousands of tiny reads while keeping full SHA-256
            // verification on every cold ServerHost start.
            using (var sha = SHA256.Create())
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read,
                1024 * 1024, FileOptions.SequentialScan))
                return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", string.Empty).ToLowerInvariant();
        }

        private static IEnumerable<string> NodeCandidates()
        {
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var raw in new[]
            {
                PortableNodePath,
                ReadExternalNodeReceiptPath(),
                Environment.GetEnvironmentVariable("DX_WINDOWS_NODE")
            })
            {
                if (string.IsNullOrWhiteSpace(raw)) continue;
                string full;
                try { full = Path.GetFullPath(raw.Trim()); }
                catch { continue; }
                if (seen.Add(full)) yield return full;
            }
        }

        private static string? ReadExternalNodeReceiptPath()
        {
            string path, sha256, version;
            return TryReadExternalNodeReceipt(out path, out sha256, out version) ? path : null;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetPrivateProfileString(
            string lpAppName,
            string lpKeyName,
            string lpDefault,
            StringBuilder lpReturnedString,
            uint nSize,
            string lpFileName);

        private static bool TryReadNodeReceiptValue(string key, out string value)
        {
            value = string.Empty;
            // Inno Setup writes the receipt through Windows INI APIs. Reading it through
            // GetPrivateProfileStringW keeps Unicode paths safe regardless of the on-disk
            // INI encoding chosen by Windows/Setup. The receipt is capped at 16 KiB below,
            // so this buffer cannot truncate a legitimate value.
            var buffer = new StringBuilder(32 * 1024);
            var count = GetPrivateProfileString("node", key, string.Empty, buffer, (uint)buffer.Capacity, ExternalNodeReceiptPath);
            if (count == 0 || count >= buffer.Capacity - 1) return false;
            value = buffer.ToString().Trim();
            return value.Length > 0;
        }

        private static bool IsSupportedNodeVersion(Version version)
        {
            if (version == null) return false;
            return (version.Major == 22 && version >= new Version(22, 23, 2)) ||
                (version.Major == 24 && version >= new Version(24, 19, 0)) ||
                (version.Major == 26 && version >= new Version(26, 7, 0));
        }

        private static bool TryReadExternalNodeReceipt(out string path, out string sha256, out string version)
        {
            path = string.Empty;
            sha256 = string.Empty;
            version = string.Empty;
            try
            {
                if (!File.Exists(ExternalNodeReceiptPath)) return false;
                var info = new FileInfo(ExternalNodeReceiptPath);
                if (info.Length <= 0 || info.Length > 16 * 1024 ||
                    (info.Attributes & FileAttributes.ReparsePoint) != 0) return false;

                if (!TryReadNodeReceiptValue("path", out path) || string.IsNullOrWhiteSpace(path) ||
                    !TryReadNodeReceiptValue("sha256", out sha256) || sha256.Length != 64 || !sha256.All(IsHexDigit) ||
                    !TryReadNodeReceiptValue("version", out version) || !Version.TryParse(version, out var parsed) || parsed == null ||
                    !IsSupportedNodeVersion(parsed)) return false;

                path = Path.GetFullPath(path);
                sha256 = sha256.ToLowerInvariant();
                version = parsed.ToString();
                return !string.Equals(path, Path.GetFullPath(PortableNodePath), StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                path = string.Empty;
                sha256 = string.Empty;
                version = string.Empty;
                return false;
            }
        }

        private static string EnsureNode()
        {
            foreach (var candidate in NodeCandidates()) if (NodeUsable(candidate)) return candidate;
            throw new FileNotFoundException("Valid x64 Node.js runtime not found. Re-run the Direct-Xfer installer to restore the bundled Node.js runtime.");
        }

        private static void SanitizeNodeEnvironment(ProcessStartInfo start)
        {
            if (start == null) return;
            foreach (var inheritedName in new[] { "NODE_OPTIONS", "NODE_PATH", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_REPL_EXTERNAL_MODULE" })
            {
                try { if (start.EnvironmentVariables.ContainsKey(inheritedName)) start.EnvironmentVariables.Remove(inheritedName); } catch { }
            }
        }

        private static bool HasNonEmptyEnvironmentVariable(ProcessStartInfo start, string name)
        {
            try
            {
                return start.EnvironmentVariables.ContainsKey(name) &&
                    !string.IsNullOrWhiteSpace(start.EnvironmentVariables[name]);
            }
            catch { return false; }
        }

        private static string[] RequestedOcrLanguages(ProcessStartInfo start)
        {
            string raw = string.Empty;
            try
            {
                if (start.EnvironmentVariables.ContainsKey("SEARCH_OCR_LANGS"))
                    raw = (start.EnvironmentVariables["SEARCH_OCR_LANGS"] ?? string.Empty).Trim().ToLowerInvariant();
            }
            catch { raw = string.Empty; }

            var parts = raw.Split(new[] { '+' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 1 || parts.Length > 6 || parts.Any(part =>
                part.Length != 3 || part.Any(ch => ch < 'a' || ch > 'z')))
                return new[] { "fra", "eng" };
            return parts.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        }

        private static bool PortableHelperUsable(string path, string arguments, params string[] expectedPrefixes)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(path) || !Path.IsPathRooted(path) || !File.Exists(path)) return false;
                var full = Path.GetFullPath(path);
                if ((File.GetAttributes(full) & FileAttributes.ReparsePoint) != 0 || !IsAmd64Pe(full)) return false;
                using (var process = new Process())
                {
                    process.StartInfo = new ProcessStartInfo
                    {
                        FileName = full, Arguments = arguments, UseShellExecute = false, CreateNoWindow = true,
                        RedirectStandardOutput = true, RedirectStandardError = true, WindowStyle = ProcessWindowStyle.Hidden
                    };
                    if (!process.Start()) return false;
                    var stdout = process.StandardOutput.ReadToEndAsync();
                    var stderr = process.StandardError.ReadToEndAsync();
                    if (!process.WaitForExit(5000))
                    {
                        try { process.Kill(true); } catch { }
                        try { process.WaitForExit(1000); } catch { }
                        return false;
                    }
                    if (!stdout.Wait(500)) return false;
                    try { stderr.Wait(500); } catch { }
                    if (process.ExitCode != 0) return false;
                    var stderrText = stderr.IsCompleted ? (stderr.Result ?? string.Empty) : string.Empty;
                    var output = ((stdout.Result ?? string.Empty) + "\n" + stderrText).Trim();
                    return expectedPrefixes != null && expectedPrefixes.Length > 0 &&
                        output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                            .Any(line => expectedPrefixes.Any(prefix =>
                            {
                                if (string.IsNullOrWhiteSpace(prefix)) return false;
                                var value = line.Trim();
                                if (!value.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return false;
                                return value.Length == prefix.Length || value[prefix.Length] == '.' || char.IsWhiteSpace(value[prefix.Length]);
                            }));
                }
            }
            catch { return false; }
        }

        private static bool RcloneUsable(string path)
        {
            return PortableHelperUsable(path, "version", "rclone v" + Program.RcloneVersion);
        }

        private static bool TesseractUsable(string executablePath, string tessdataPath, IEnumerable<string> requiredLanguages)
        {
            if (!PortableHelperUsable(executablePath, "--version",
                "tesseract " + Program.TesseractVersion,
                "tesseract v" + Program.TesseractVersion)) return false;
            try
            {
                if (string.IsNullOrWhiteSpace(tessdataPath) || !Path.IsPathRooted(tessdataPath) || !Directory.Exists(tessdataPath)) return false;
                var tessdataFull = Path.GetFullPath(tessdataPath);
                foreach (var language in new[] { "eng", "fra", "spa" })
                {
                    var model = Path.Combine(tessdataFull, language + ".traineddata");
                    if (!File.Exists(model) || new FileInfo(model).Length < 100 * 1024) return false;
                }
                var requested = (requiredLanguages ?? Array.Empty<string>())
                    .Where(language => !string.IsNullOrWhiteSpace(language))
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToArray();
                if (requested.Length == 0) requested = new[] { "fra", "eng" };
                foreach (var language in requested)
                {
                    var model = Path.Combine(tessdataFull, language + ".traineddata");
                    if (!File.Exists(model) || new FileInfo(model).Length < 100 * 1024) return false;
                }

                using var process = new Process();
                var start = new ProcessStartInfo
                {
                    FileName = Path.GetFullPath(executablePath), UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardOutput = true, RedirectStandardError = true, WindowStyle = ProcessWindowStyle.Hidden
                };
                start.ArgumentList.Add("--list-langs");
                start.ArgumentList.Add("--tessdata-dir");
                start.ArgumentList.Add(tessdataFull);
                try { if (start.EnvironmentVariables.ContainsKey("TESSDATA_PREFIX")) start.EnvironmentVariables.Remove("TESSDATA_PREFIX"); } catch { }
                process.StartInfo = start;
                if (!process.Start()) return false;
                var stdout = process.StandardOutput.ReadToEndAsync();
                var stderr = process.StandardError.ReadToEndAsync();
                if (!process.WaitForExit(5000))
                {
                    try { process.Kill(); } catch { }
                    try { process.WaitForExit(1000); } catch { }
                    return false;
                }
                if (!stdout.Wait(500)) return false;
                try { stderr.Wait(500); } catch { }
                if (process.ExitCode != 0) return false;
                var stderrText = stderr.IsCompleted ? (stderr.Result ?? string.Empty) : string.Empty;
                var languages = ((stdout.Result ?? string.Empty) + "\n" + stderrText)
                    .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                    .Select(line => line.Trim())
                    .ToHashSet(StringComparer.OrdinalIgnoreCase);
                return new[] { "eng", "fra", "spa" }.All(languages.Contains) && requested.All(languages.Contains);
            }
            catch { return false; }
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
                string expectedHash;
                string? expectedVersion = null;
                if (bundled)
                {
                    expectedHash = Program.NodeExeSha256;
                    expectedVersion = Program.NodeVersion;
                }
                else
                {
                    string receiptPath, receiptHash, receiptVersion;
                    if (TryReadExternalNodeReceipt(out receiptPath, out receiptHash, out receiptVersion) &&
                        string.Equals(full, receiptPath, StringComparison.OrdinalIgnoreCase))
                    {
                        expectedHash = receiptHash;
                        expectedVersion = receiptVersion;
                    }
                    else
                    {
                        var external = Environment.GetEnvironmentVariable("DX_WINDOWS_NODE");
                        string? externalFull = null;
                        try
                        {
                            if (!string.IsNullOrWhiteSpace(external)) externalFull = Path.GetFullPath(external.Trim());
                        }
                        catch { }
                        if (string.IsNullOrWhiteSpace(externalFull) ||
                            !string.Equals(full, externalFull, StringComparison.OrdinalIgnoreCase)) return false;
                        expectedHash = (Environment.GetEnvironmentVariable("DX_WINDOWS_NODE_SHA256") ?? string.Empty).Trim();
                        if (expectedHash.Length != 64 || !expectedHash.All(IsHexDigit)) return false;
                    }
                }

                if (!string.Equals(FileSha256(full), expectedHash, StringComparison.OrdinalIgnoreCase)) return false;

                // For Direct-Xfer's pinned private Node binary the exact SHA-256 and
                // AMD64 PE checks already identify the executable byte-for-byte. Spawning
                // a second Node process only to ask --version adds cold-start overhead
                // without adding an integrity property. External/user-supplied Node paths
                // still execute --version below to enforce the supported-version policy.
                if (bundled)
                {
                    return Version.TryParse(Program.NodeVersion, out var pinnedVersion) && pinnedVersion != null &&
                        IsSupportedNodeVersion(pinnedVersion);
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
                        try { process.Kill(true); } catch { }
                        try { process.WaitForExit(1000); } catch { }
                        return false;
                    }
                    if (!stdout.Wait(500)) return false;
                    try { stderr.Wait(100); } catch { }
                    var output = (stdout.Result ?? string.Empty).Trim().TrimStart('v');
                    if (process.ExitCode != 0 || !Version.TryParse(output, out var parsed) || parsed == null) return false;
                    if (!IsSupportedNodeVersion(parsed)) return false;
                    return string.IsNullOrWhiteSpace(expectedVersion) ||
                        string.Equals(parsed.ToString(), expectedVersion, StringComparison.Ordinal);
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
            // Inno Setup writes exactly one one-shot marker for each privacy choice.
            // Node applies the selected values durably to Direct-Xfer settings, then consumes
            // the marker from this per-user writable directory. This makes the installer
            // choice effective on upgrades without permanently locking the in-app setting.
            if (File.Exists(InstallUpdateCheckEnableMarker))
            {
                start.EnvironmentVariables["DX_WINDOWS_INSTALL_UPDATE_CHECK"] = "1";
                start.EnvironmentVariables["DX_WINDOWS_INSTALL_UPDATE_CHECK_MARKER"] = InstallUpdateCheckEnableMarker;
            }
            else if (File.Exists(InstallUpdateCheckDisableMarker))
            {
                start.EnvironmentVariables["DX_WINDOWS_INSTALL_UPDATE_CHECK"] = "0";
                start.EnvironmentVariables["DX_WINDOWS_INSTALL_UPDATE_CHECK_MARKER"] = InstallUpdateCheckDisableMarker;
            }
            if (File.Exists(InstallPublicIpEnableMarker))
            {
                start.EnvironmentVariables["DX_WINDOWS_INSTALL_PUBLIC_IP_DISCOVERY"] = "1";
                start.EnvironmentVariables["DX_WINDOWS_INSTALL_PUBLIC_IP_DISCOVERY_MARKER"] = InstallPublicIpEnableMarker;
            }
            else if (File.Exists(InstallPublicIpDisableMarker))
            {
                start.EnvironmentVariables["DX_WINDOWS_INSTALL_PUBLIC_IP_DISCOVERY"] = "0";
                start.EnvironmentVariables["DX_WINDOWS_INSTALL_PUBLIC_IP_DISCOVERY_MARKER"] = InstallPublicIpDisableMarker;
            }
            // Explicit administrator overrides always win. rclone and Tesseract are optional
            // Windows components installed per-user by the launcher only after activation.
            // Legacy runtime\rclone and runtime\tesseract paths remain accepted for upgrades
            // and manually assembled portable deployments.
            if (!HasNonEmptyEnvironmentVariable(start, "RCLONE_BIN"))
            {
                if (File.Exists(OptionalRcloneActivationMarker) && File.Exists(OptionalRclonePath))
                {
                    if (RcloneUsable(OptionalRclonePath))
                        start.EnvironmentVariables["RCLONE_BIN"] = OptionalRclonePath;
                    else
                        AppendLog("[server-host] optional rclone failed validation and will not be used.");
                }
                if (!HasNonEmptyEnvironmentVariable(start, "RCLONE_BIN") && File.Exists(PortableRclonePath))
                {
                    if (RcloneUsable(PortableRclonePath))
                        start.EnvironmentVariables["RCLONE_BIN"] = PortableRclonePath;
                    else
                        AppendLog("[server-host] legacy portable rclone failed validation and will not be used.");
                }
            }
            if (!HasNonEmptyEnvironmentVariable(start, "RCLONE_CONFIG"))
                start.EnvironmentVariables["RCLONE_CONFIG"] = Path.Combine(config.dataDir, "rclone", "rclone.conf");

            var requestedOcrLanguages = RequestedOcrLanguages(start);
            string selectedTesseract = string.Empty;
            string selectedTessdata = string.Empty;
            if (!HasNonEmptyEnvironmentVariable(start, "SEARCH_OCR_TESSERACT_BIN"))
            {
                if (File.Exists(OptionalTesseractActivationMarker) && File.Exists(OptionalTesseractPath))
                {
                    if (TesseractUsable(OptionalTesseractPath, OptionalTessdataPath, requestedOcrLanguages))
                    {
                        selectedTesseract = OptionalTesseractPath;
                        selectedTessdata = OptionalTessdataPath;
                    }
                    else
                    {
                        AppendLog("[server-host] optional Tesseract cannot satisfy the requested OCR languages (" +
                            string.Join("+", requestedOcrLanguages) + ") and will not be used.");
                    }
                }
                if (string.IsNullOrWhiteSpace(selectedTesseract) && File.Exists(PortableTesseractPath))
                {
                    if (TesseractUsable(PortableTesseractPath, PortableTessdataPath, requestedOcrLanguages))
                    {
                        selectedTesseract = PortableTesseractPath;
                        selectedTessdata = PortableTessdataPath;
                    }
                    else
                    {
                        AppendLog("[server-host] legacy portable Tesseract cannot satisfy the requested OCR languages (" +
                            string.Join("+", requestedOcrLanguages) + ") and will not be used.");
                    }
                }

                if (!string.IsNullOrWhiteSpace(selectedTesseract))
                {
                    start.EnvironmentVariables["SEARCH_OCR_TESSERACT_BIN"] = selectedTesseract;
                    if (!HasNonEmptyEnvironmentVariable(start, "TESSDATA_PREFIX"))
                    {
                        start.EnvironmentVariables["TESSDATA_PREFIX"] = selectedTessdata;
                        start.EnvironmentVariables["DX_WINDOWS_TESSDATA_DIR"] = selectedTessdata;
                    }
                }
                else if (!HasNonEmptyEnvironmentVariable(start, "SEARCH_OCR_ENABLED"))
                {
                    // Keep the default installer light and quiet: Windows OCR stays off until
                    // Tesseract is explicitly activated. Administrators can still opt in to a
                    // PATH/custom Tesseract by setting SEARCH_OCR_ENABLED or *_BIN themselves.
                    start.EnvironmentVariables["SEARCH_OCR_ENABLED"] = "false";
                    AppendLog("[server-host] OCR is disabled until the optional Tesseract component is activated.");
                }
            }
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
            _lastReadyFailure = string.Empty;
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
            if (!string.IsNullOrWhiteSpace(_lastReadyFailure))
                AppendLog("[server-host] readiness timeout detail: " + _lastReadyFailure);
            return false;
        }

        private bool TryReady(int port, string token, string preferredScheme, int expectedPid, out string usedScheme)
        {
            usedScheme = preferredScheme;
            var lastFailure = string.Empty;
            foreach (var scheme in SchemeCandidates(preferredScheme))
            {
                try
                {
                    var response = LauncherRequest("GET", port, "/__dx_launcher/ready", token, scheme, 2000, LocalCaCertificatePath);
                    var payload = Json.Deserialize<Dictionary<string, object?>>(response.Body);
                    object? okValue, appValue, pidValue;
                    var ok = payload != null && payload.TryGetValue("ok", out okValue) && Convert.ToBoolean(okValue, CultureInfo.InvariantCulture);
                    var app = payload != null && payload.TryGetValue("app", out appValue) ? Convert.ToString(appValue, CultureInfo.InvariantCulture) : string.Empty;
                    var pid = payload != null && payload.TryGetValue("pid", out pidValue) ? Convert.ToInt32(pidValue, CultureInfo.InvariantCulture) : 0;
                    if (response.StatusCode == HttpStatusCode.OK && ok && string.Equals(app, "Direct-Xfer", StringComparison.Ordinal) && pid == expectedPid)
                    { _lastReadyFailure = string.Empty; usedScheme = scheme; return true; }
                    lastFailure = scheme + " returned HTTP " + ((int)response.StatusCode).ToString(CultureInfo.InvariantCulture) +
                        " (ok=" + ok.ToString(CultureInfo.InvariantCulture) + ", app=" + (app ?? string.Empty) +
                        ", pid=" + pid.ToString(CultureInfo.InvariantCulture) + ", expectedPid=" + expectedPid.ToString(CultureInfo.InvariantCulture) + ")";
                }
                catch (Exception ex)
                {
                    lastFailure = scheme + " probe failed: " + ex.GetType().Name + ": " + ex.Message;
                }
            }
            if (!string.IsNullOrWhiteSpace(lastFailure)) _lastReadyFailure = lastFailure;
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
                localChain.ChainPolicy.DisableCertificateDownloads = true;
                localChain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
                localChain.ChainPolicy.CustomTrustStore.Add(localCa);
                localChain.ChainPolicy.VerificationFlags = X509VerificationFlags.NoFlag;
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
            try { server.Kill(true); } catch { try { server.Kill(); } catch { } }
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
