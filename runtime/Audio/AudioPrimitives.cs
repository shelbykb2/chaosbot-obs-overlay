namespace Overlay.Audio;

/// <summary>Which Windows playback endpoint supplies Spotify's live spectrum.</summary>
internal enum SpectrumSourceMode { FollowPlayer, WindowsDefault, Device }

/// <summary>Player-following is intentional: mixers such as Sonar often carry music off the default output.</summary>
internal readonly record struct SpectrumSource(SpectrumSourceMode Mode, string DeviceId = "") {
    public static SpectrumSource FollowPlayer { get; } = new(SpectrumSourceMode.FollowPlayer);
    public static bool IsPlayerProcess(string? processName)
        => processName is not null && processName.StartsWith("spoti", StringComparison.OrdinalIgnoreCase);
}

internal delegate void SpectrumSamples(ReadOnlySpan<float> mono, int sampleRate);

internal interface ISpectrumCapture : IDisposable {
    bool IsRunning { get; }
    SpectrumSource Source { get; set; }
    string ListeningTo { get; }
    event Action? ListeningToChanged;
    void Start(SpectrumSamples sink);
    void Stop();
}

internal sealed record AudioOutputDevice(string Id, string Name);
