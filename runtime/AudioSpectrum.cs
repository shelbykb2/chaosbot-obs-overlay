using System.Text.Json.Nodes;
using Microsoft.AspNetCore.SignalR;
using Overlay.Audio;

namespace Overlay;

/// <summary>Captures the playback device used by Spotify only while an interested renderer is live.</summary>
public sealed class AudioSpectrum : BackgroundService {
    const string SpotifyFeed = "spotify";
    const string SpotifyPageFeed = "pageSpotify";
    static readonly TimeSpan GatePoll = TimeSpan.FromMilliseconds(500);
    static readonly TimeSpan FrameInterval = TimeSpan.FromMilliseconds(1000d / 30);

    readonly Connections connections;
    readonly OverlayState state;
    readonly IHubContext<OverlayHub> hub;
    readonly ILogger<AudioSpectrum> logger;
    readonly object clientsGate = new();
    readonly Dictionary<string, bool> interestedClients = new(StringComparer.Ordinal);
    readonly SpectrumAnalyzer analyzer = new();
    readonly ISpectrumCapture capture;
    readonly byte[] frame = new byte[SpectrumAnalyzer.FrameBytes];

    public AudioSpectrum(Connections connections, OverlayState state, IHubContext<OverlayHub> hub, ILoggerFactory loggerFactory) {
        this.connections = connections;
        this.state = state;
        this.hub = hub;
        logger = loggerFactory.CreateLogger<AudioSpectrum>();
        capture = new WasapiLoopbackCapture(loggerFactory.CreateLogger<WasapiLoopbackCapture>());
        capture.Source = SpectrumSource.FollowPlayer;
    }

    /// <summary>Called by the hub when a page connects or changes the feeds it draws.</summary>
    public void Connect(string connectionId, string[] feeds) {
        var requested = feeds?.Any(feed => feed is SpotifyFeed or SpotifyPageFeed) == true;
        lock (clientsGate) {
            if (requested) interestedClients[connectionId] = feeds.Contains(SpotifyPageFeed, StringComparer.Ordinal);
            else interestedClients.Remove(connectionId);
        }
    }

    public void Disconnect(string connectionId) {
        lock (clientsGate) interestedClients.Remove(connectionId);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken) {
        if (!OperatingSystem.IsWindows()) {
            logger.LogInformation("Spotify spectrum capture is available on Windows only.");
            return;
        }

        var captureActive = false;
        var failures = 0;
        var nextGateCheck = DateTimeOffset.MinValue;
        var nextFrame = DateTimeOffset.MinValue;
        try {
            while (!stoppingToken.IsCancellationRequested) {
                try {
                    var now = DateTimeOffset.UtcNow;
                    if (now >= nextGateCheck) {
                        nextGateCheck = now + GatePoll;
                        var hasInterestedClient = TryInterestedClients(out var pageSpotify);
                        var pageSourceVisible = pageSpotify && HasConfiguredCardVisualizer();
                        var sceneSourceVisible = HasActiveSceneVisualizer();
                        var shouldCapture = ShouldCapture(hasInterestedClient, IsPlaying(), sceneSourceVisible, pageSourceVisible);
                        if (shouldCapture != captureActive) {
                            if (shouldCapture) {
                                analyzer.Reset();
                                capture.Start(analyzer.Push);
                                captureActive = true;
                                logger.LogDebug("Spotify spectrum capture started on {Device}.", capture.ListeningTo);
                            } else {
                                capture.Stop();
                                analyzer.Reset();
                                captureActive = false;
                            }
                        }
                    }

                    now = DateTimeOffset.UtcNow;
                    if (captureActive && now >= nextFrame) {
                        nextFrame = now + FrameInterval;
                        if (analyzer.TryWriteFrame(frame)) {
                            var ids = InterestedIds();
                            if (ids.Length != 0) await hub.Clients.Clients(ids).SendAsync("spectrum", frame.ToArray(), stoppingToken);
                        }
                    }

                    failures = 0;
                    var delay = captureActive ? TimeSpan.FromMilliseconds(5) : TimeSpan.FromMilliseconds(100);
                    await Task.Delay(delay, stoppingToken);
                } catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) {
                    break;
                } catch (Exception ex) {
                    failures = Math.Min(failures + 1, 5);
                    logger.LogWarning(ex, "Spotify spectrum service failed; retrying after a short delay.");
                    try { capture.Stop(); }
                    catch (Exception stopError) { logger.LogDebug(stopError, "Spotify spectrum capture cleanup will retry."); }
                    captureActive = false;
                    analyzer.Reset();
                    await Task.Delay(TimeSpan.FromSeconds(Math.Min(30, Math.Pow(2, failures - 1))), stoppingToken);
                    nextGateCheck = DateTimeOffset.MinValue;
                }
            }
        } finally {
            try { capture.Stop(); }
            catch (Exception ex) { logger.LogDebug(ex, "Spotify spectrum capture did not stop cleanly during shutdown."); }
            try { capture.Dispose(); }
            catch (Exception ex) { logger.LogDebug(ex, "Spotify spectrum capture disposal did not finish cleanly."); }
        }
    }

    internal static bool ShouldCapture(bool hasInterestedClient, bool isPlaying, bool activeSceneVisualizer, bool pageSpotifyVisualizer)
        => hasInterestedClient && isPlaying && (activeSceneVisualizer || pageSpotifyVisualizer);

    bool IsPlaying() => connections.NowPlaying?["isPlaying"]?.GetValue<bool>() == true;

    bool TryInterestedClients(out bool pageSpotify) {
        lock (clientsGate) {
            pageSpotify = interestedClients.Values.Any(value => value);
            return interestedClients.Count != 0;
        }
    }

    string[] InterestedIds() {
        lock (clientsGate) return interestedClients.Keys.ToArray();
    }

    bool HasConfiguredCardVisualizer() {
        // The dedicated /spotify source uses its default enabled/auto settings when no card exists.
        var doc = state.Document;
        var configured = doc["scenes"]?.AsArray()
            .SelectMany(scene => scene?["elements"]?.AsArray() ?? new JsonArray())
            .FirstOrDefault(element => element?["type"]?.GetValue<string>() == "spotify");
        if (configured is null) return true;
        var props = configured["props"] as JsonObject;
        return (props?["enabled"]?.GetValue<bool>() ?? true) &&
            !string.Equals(props?["visualizer"]?.GetValue<string>() ?? "auto", "none", StringComparison.OrdinalIgnoreCase);
    }

    bool HasActiveSceneVisualizer() {
        var doc = state.Document;
        var active = doc["activeSceneId"]?.GetValue<string>();
        var scene = doc["scenes"]?.AsArray().FirstOrDefault(item => item?["id"]?.GetValue<string>() == active);
        return scene?["elements"]?.AsArray().Any(element => {
            if (element?["type"]?.GetValue<string>() != "spotify") return false;
            var props = element["props"] as JsonObject;
            return (props?["enabled"]?.GetValue<bool>() ?? true) &&
                !string.Equals(props?["visualizer"]?.GetValue<string>() ?? "auto", "none", StringComparison.OrdinalIgnoreCase);
        }) == true;
    }
}
