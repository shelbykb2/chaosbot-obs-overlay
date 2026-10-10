using System.Runtime.InteropServices;

using Microsoft.Extensions.Logging;

namespace Overlay.Audio;

/// <summary>PCM layouts a shared-mode mix format can come in.</summary>
internal enum PcmLayout
{
    Float32,
    Int16,
    Int24,
    Int32,
}

/// <summary>Packet bytes to mono floats. Pure, so it is tested without a device.</summary>
internal static class PcmMono
{
    public static PcmLayout? LayoutOf(int formatTag, int bitsPerSample, Guid subFormat)
    {
        const int pcm = 1;
        const int ieeeFloat = 3;
        const int extensible = 0xFFFE;
        var tag = formatTag;
        if (tag == extensible)
        {
            // The first four bytes of the sub-format GUID are the real format tag.
            tag = BitConverter.ToInt32(subFormat.ToByteArray(), 0);
        }

        return (tag, bitsPerSample) switch
        {
            (ieeeFloat, 32) => PcmLayout.Float32,
            (pcm, 16) => PcmLayout.Int16,
            (pcm, 24) => PcmLayout.Int24,
            (pcm, 32) => PcmLayout.Int32,
            _ => null,
        };
    }

    public static int BytesPerSample(PcmLayout layout) => layout switch
    {
        PcmLayout.Int16 => 2,
        PcmLayout.Int24 => 3,
        _ => 4,
    };

    /// <summary>Averages the channels of each frame into <paramref name="mono"/>. Returns the frames written.</summary>
    public static int Downmix(ReadOnlySpan<byte> data, int channels, PcmLayout layout, Span<float> mono)
    {
        var width = BytesPerSample(layout);
        var frameBytes = width * channels;
        if (channels <= 0 || frameBytes == 0)
        {
            return 0;
        }

        var frames = Math.Min(data.Length / frameBytes, mono.Length);
        for (var f = 0; f < frames; f++)
        {
            float sum = 0;
            var at = f * frameBytes;
            for (var c = 0; c < channels; c++)
            {
                var s = data.Slice(at + (c * width), width);
                sum += layout switch
                {
                    PcmLayout.Float32 => BitConverter.ToSingle(s),
                    PcmLayout.Int16 => BitConverter.ToInt16(s) / 32768f,
                    PcmLayout.Int24 => (((s[0] | (s[1] << 8) | (s[2] << 16)) << 8) >> 8) / 8388608f,
                    _ => BitConverter.ToInt32(s) / 2147483648f,
                };
            }

            mono[f] = sum / channels;
        }

        return frames;
    }
}

/// <summary>
/// What the streamer hears: a WASAPI loopback on the device <see cref="Source"/> picks, polled from one
/// thread that exists only between <see cref="Start"/> and <see cref="Stop"/>. Nothing runs while stopped.
/// Following the player, it looks every 2 s for the device the music is on and moves there; a switch of
/// the default device is followed as soon as Windows reports it. A lost or missing device is retried on a
/// backoff. A failure streak is logged once.
/// </summary>
/// <remarks>
/// Native AOT: the COM objects are driven through raw vtable function pointers (no built-in COM
/// interop, no reflection, no generated marshalling), so nothing here can be trimmed away.
/// </remarks>
internal sealed unsafe partial class WasapiLoopbackCapture : ISpectrumCapture
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(15);
    private static readonly TimeSpan DeviceCheckInterval = TimeSpan.FromMilliseconds(500);
    private static readonly TimeSpan RechooseInterval = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan MaxBackoff = TimeSpan.FromSeconds(30);

    private static readonly Guid IidAudioClient = new("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
    private static readonly Guid IidCaptureClient = new("C8ADBD64-E71E-48A0-A4DE-185C395CD317");

    private const int ClsCtxAll = 0x17;
    private const uint StreamFlagsLoopback = 0x00020000;
    private const uint BufferFlagsSilent = 0x2;
    private const int DeviceInvalidated = unchecked((int)0x88890004);

    private readonly ILogger? _logger;
    private readonly object _gate = new();
    private ManualResetEventSlim? _stop;
    private Thread? _thread;
    private SpectrumSource _source = SpectrumSource.FollowPlayer;
    private int _sourceVersion;
    private object? _session;
    private string? _wantedId;
    private int _rechoosing;
    private string _listeningTo = string.Empty;

    public WasapiLoopbackCapture(ILogger<WasapiLoopbackCapture>? logger = null) => _logger = logger;

    public bool IsRunning
    {
        get
        {
            lock (_gate)
            {
                return _thread is not null;
            }
        }
    }

    public SpectrumSource Source
    {
        get
        {
            lock (_gate)
            {
                return _source;
            }
        }

        set
        {
            lock (_gate)
            {
                if (_source == value)
                {
                    return;
                }

                _source = value;
                _sourceVersion++; // a running session sees it and reopens on the new device
            }
        }
    }

    public string ListeningTo => Volatile.Read(ref _listeningTo);

    public event Action? ListeningToChanged;

    public void Start(SpectrumSamples sink)
    {
        lock (_gate)
        {
            if (_thread is not null)
            {
                return;
            }

            var stop = new ManualResetEventSlim(false);
            _stop = stop;
            var thread = new Thread(() => Run(sink, stop))
            {
                IsBackground = true,
                Name = "Spotify spectrum capture",
            };
            _thread = thread;
            try
            {
                thread.Start();
            }
            catch
            {
                _thread = null;
                _stop = null;
                stop.Dispose();
                throw;
            }
        }
    }

    public void Stop()
    {
        Thread? thread;
        ManualResetEventSlim? stop;
        lock (_gate)
        {
            thread = _thread;
            stop = _stop;
            if (thread is not null)
            {
                // Keep ownership until Run exits. A timed-out join must not let Start create a second
                // capture thread or dispose the event while the first thread is still waiting on it.
                stop!.Set();
            }
        }

        if (thread is null)
        {
            return;
        }

        thread.Join(TimeSpan.FromSeconds(3));
    }

    public void Dispose() => Stop();

    /// <summary>1 s, 2 s, 4 s ... up to 30 s between attempts.</summary>
    public static TimeSpan Backoff(int failures)
        => TimeSpan.FromSeconds(Math.Min(MaxBackoff.TotalSeconds, Math.Pow(2, Math.Clamp(failures, 0, 10))));

    private void Run(SpectrumSamples sink, ManualResetEventSlim stop)
    {
        // MTA, so the objects need no message pump and can be released from this thread.
        var com = CoInitializeEx(0, 0);
        try
        {
            var failures = 0;
            var logged = false;
            while (!stop.IsSet)
            {
                var streamed = false;
                try
                {
                    // Returns normally only when it should move to another device (or stop was set).
                    RunSession(sink, stop, () => streamed = true);
                    failures = 0;
                    logged = false;
                    continue;
                }
                catch (Exception ex)
                {
                    if (streamed)
                    {
                        // It worked and then broke: a fresh streak, so say so again.
                        failures = 0;
                        logged = false;
                    }

                    if (!logged)
                    {
                        logged = true;
                        _logger?.LogWarning(ex, "Spectrum capture lost the audio device; retrying with a backoff.");
                    }
                }

                if (stop.Wait(Backoff(failures++)))
                {
                    break;
                }
            }
        }
        finally
        {
            if (com >= 0)
            {
                CoUninitialize();
            }

            SetListeningTo(string.Empty);
            lock (_gate)
            {
                if (ReferenceEquals(_stop, stop))
                {
                    _thread = null;
                    _stop = null;
                }
            }

            stop.Dispose();
        }
    }

    private void RunSession(SpectrumSamples sink, ManualResetEventSlim stop, Action streaming)
    {
        nint enumerator = 0, device = 0, client = 0, capture = 0, format = 0;
        DefaultDeviceWatch? watch = null;
        Timer? rechoose = null;
        try
        {
            enumerator = AudioEndpoints.CreateEnumerator();

            // Windows says when the default device changes. Registered before the device is read, so
            // a change in between is not missed. If it cannot register, the loop asks every 500 ms.
            watch = new DefaultDeviceWatch();
            if (((delegate* unmanaged[MemberFunction]<nint, nint, int>)Slot(enumerator, 6))(enumerator, watch.ComPointer) < 0)
            {
                watch.Dispose();
                watch = null;
            }

            SpectrumSource source;
            int version;
            lock (_gate)
            {
                source = _source;
                version = _sourceVersion;
            }

            var defaultId = AudioEndpoints.DefaultId(enumerator);
            var deviceId = AudioEndpoints.Resolve(enumerator, source, null);
            device = AudioEndpoints.Open(enumerator, deviceId);
            SetListeningTo(AudioEndpoints.NameOf(device));

            // Following the player, or waiting for a picked device to come back: look again every 2 s,
            // on a timer thread, and reopen when the answer changes.
            var session = new object();
            Volatile.Write(ref _wantedId, null);
            Volatile.Write(ref _session, session);
            if (source.Mode == SpectrumSourceMode.FollowPlayer
                || (source.Mode == SpectrumSourceMode.Device && deviceId != source.DeviceId))
            {
                rechoose = new Timer(_ => Rechoose(session, source, deviceId), null, RechooseInterval, RechooseInterval);
            }

            var iid = IidAudioClient;
            Check(((delegate* unmanaged[MemberFunction]<nint, Guid*, int, nint, nint*, int>)Slot(device, 3))(
                device, &iid, ClsCtxAll, 0, &client));
            Check(((delegate* unmanaged[MemberFunction]<nint, nint*, int>)Slot(client, 8))(client, &format));

            var fmt = (byte*)format;
            var tag = *(ushort*)fmt;
            var channels = *(ushort*)(fmt + 2);
            var rate = *(int*)(fmt + 4);
            var bits = *(ushort*)(fmt + 14);
            var sub = tag == 0xFFFE ? *(Guid*)(fmt + 24) : Guid.Empty;
            var layout = PcmMono.LayoutOf(tag, bits, sub)
                ?? throw new NotSupportedException($"Unsupported mix format (tag {tag}, {bits} bits).");

            Check(((delegate* unmanaged[MemberFunction]<nint, int, uint, long, long, nint, Guid*, int>)Slot(client, 3))(
                client, 0, StreamFlagsLoopback, 1_000_000, 0, format, null));
            var captureIid = IidCaptureClient;
            Check(((delegate* unmanaged[MemberFunction]<nint, Guid*, nint*, int>)Slot(client, 14))(
                client, &captureIid, &capture));
            Check(((delegate* unmanaged[MemberFunction]<nint, int>)Slot(client, 10))(client));
            streaming();

            try
            {
                var mono = new float[Math.Max(rate / 4, 4096)];
                var nextCheck = Environment.TickCount64 + (long)DeviceCheckInterval.TotalMilliseconds;
                while (!stop.Wait(PollInterval))
                {
                    DrainPackets(capture, sink, rate, channels, layout, mono);

                    if (Volatile.Read(ref _sourceVersion) != version
                        || (Volatile.Read(ref _wantedId) is { } wanted && wanted != deviceId))
                    {
                        return;
                    }

                    if (watch is not null)
                    {
                        if (watch.Changed)
                        {
                            return;
                        }
                    }
                    else if (Environment.TickCount64 >= nextCheck)
                    {
                        nextCheck = Environment.TickCount64 + (long)DeviceCheckInterval.TotalMilliseconds;
                        if (DefaultDeviceChanged(enumerator, defaultId))
                        {
                            return;
                        }
                    }
                }
            }
            finally
            {
                ((delegate* unmanaged[MemberFunction]<nint, int>)Slot(client, 11))(client);
            }
        }
        finally
        {
            rechoose?.Dispose();
            if (format != 0)
            {
                CoTaskMemFree(format);
            }

            Release(capture);
            Release(client);
            Release(device);
            if (watch is not null)
            {
                // Unregister waits out a callback in flight, so the memory is free to go after it.
                ((delegate* unmanaged[MemberFunction]<nint, nint, int>)Slot(enumerator, 7))(enumerator, watch.ComPointer);
                watch.Dispose();
            }

            Release(enumerator);
        }
    }

    private static void DrainPackets(
        nint capture, SpectrumSamples sink, int rate, int channels, PcmLayout layout, float[] mono)
    {
        while (true)
        {
            uint next;
            var hr = ((delegate* unmanaged[MemberFunction]<nint, uint*, int>)Slot(capture, 5))(capture, &next);
            if (hr == DeviceInvalidated)
            {
                throw new InvalidOperationException("The audio device was removed.");
            }

            Check(hr);
            if (next == 0)
            {
                return;
            }

            byte* data;
            uint frames, flags;
            Check(((delegate* unmanaged[MemberFunction]<nint, byte**, uint*, uint*, ulong*, ulong*, int>)Slot(capture, 3))(
                capture, &data, &frames, &flags, null, null));
            try
            {
                var count = (int)Math.Min(frames, (uint)mono.Length);
                if ((flags & BufferFlagsSilent) != 0)
                {
                    Array.Clear(mono, 0, count);
                }
                else
                {
                    var bytes = new ReadOnlySpan<byte>(data, count * channels * PcmMono.BytesPerSample(layout));
                    count = PcmMono.Downmix(bytes, channels, layout, mono);
                }

                sink(mono.AsSpan(0, count), rate);
            }
            finally
            {
                ((delegate* unmanaged[MemberFunction]<nint, uint, int>)Slot(capture, 4))(capture, frames);
            }
        }
    }

    /// <summary>Runs on a timer thread: which device the session should be on now.</summary>
    private void Rechoose(object session, SpectrumSource source, string current)
    {
        if (Interlocked.Exchange(ref _rechoosing, 1) != 0)
        {
            return; // the last look is still going
        }

        var com = CoInitializeEx(0, 0);
        nint enumerator = 0;
        try
        {
            enumerator = AudioEndpoints.CreateEnumerator();
            var id = AudioEndpoints.Resolve(enumerator, source, current);
            if (ReferenceEquals(Volatile.Read(ref _session), session))
            {
                Volatile.Write(ref _wantedId, id);
            }
        }
        catch (COMException)
        {
            // No default device for a moment; the next look tries again.
        }
        finally
        {
            Release(enumerator);
            if (com >= 0)
            {
                CoUninitialize();
            }

            Volatile.Write(ref _rechoosing, 0);
        }
    }

    private void SetListeningTo(string name)
    {
        if (Interlocked.Exchange(ref _listeningTo, name) != name)
        {
            ListeningToChanged?.Invoke();
        }
    }

    private static bool DefaultDeviceChanged(nint enumerator, string defaultId)
    {
        try
        {
            return !string.Equals(AudioEndpoints.DefaultId(enumerator), defaultId, StringComparison.Ordinal);
        }
        catch (COMException)
        {
            // No default device at the moment (unplugged): reopen, which backs off until one returns.
            return true;
        }
    }

    private static nint Slot(nint obj, int index) => (*(nint**)obj)[index];

    private static void Release(nint obj)
    {
        if (obj != 0)
        {
            ((delegate* unmanaged[MemberFunction]<nint, uint>)Slot(obj, 2))(obj);
        }
    }

    private static void Check(int hr)
    {
        if (hr < 0)
        {
            Marshal.ThrowExceptionForHR(hr);
        }
    }

    [LibraryImport("ole32.dll")]
    private static partial int CoInitializeEx(nint reserved, uint coInit);

    [LibraryImport("ole32.dll")]
    private static partial void CoUninitialize();

    [LibraryImport("ole32.dll")]
    private static partial void CoTaskMemFree(nint memory);
}
