using Overlay;
using Overlay.Audio;

namespace Overlay.RuntimeTests;

/// <summary>Portable audio contract checks; does not require an active Windows audio device.</summary>
public static class AudioTests {
    public static void Run() {
        PcmLayoutsDownmixToMono();
        AnalyzerPlacesTonesInTheirBands();
        KickAfterQuietProducesABeat();
        StableAndHighFrequencyAudioDoNotCreateKicks();
        CaptureRequiresAPlayingInterestedVisualizer();
        FollowPlayerRecognizesMusicPlayersOnly();
    }

    static void PcmLayoutsDownmixToMono() {
        Require(PcmMono.LayoutOf(3, 32, Guid.Empty) == PcmLayout.Float32, "IEEE float mix formats are recognized.");
        Require(PcmMono.LayoutOf(1, 16, Guid.Empty) == PcmLayout.Int16, "16-bit PCM mix formats are recognized.");
        Require(PcmMono.LayoutOf(1, 24, Guid.Empty) == PcmLayout.Int24, "24-bit PCM mix formats are recognized.");
        Require(PcmMono.LayoutOf(1, 32, Guid.Empty) == PcmLayout.Int32, "32-bit PCM mix formats are recognized.");
        Require(PcmMono.LayoutOf(0xFFFE, 32, new Guid("00000003-0000-0010-8000-00AA00389B71")) == PcmLayout.Float32,
            "Extensible float formats use their sub-format tag.");
        Require(PcmMono.LayoutOf(1, 8, Guid.Empty) is null, "Unsupported PCM layouts are rejected.");

        Span<float> mono = stackalloc float[1];
        var floats = new byte[8];
        BitConverter.TryWriteBytes(floats.AsSpan(0, 4), 0.25f);
        BitConverter.TryWriteBytes(floats.AsSpan(4, 4), -0.75f);
        Require(PcmMono.Downmix(floats, 2, PcmLayout.Float32, mono) == 1 && Near(mono[0], -0.25f), "Float stereo is averaged into mono.");

        var int16 = new byte[4];
        BitConverter.TryWriteBytes(int16.AsSpan(0, 2), (short)16384);
        BitConverter.TryWriteBytes(int16.AsSpan(2, 2), (short)-16384);
        Require(PcmMono.Downmix(int16, 2, PcmLayout.Int16, mono) == 1 && Near(mono[0], 0), "16-bit stereo is averaged into mono.");

        var int24 = new byte[] { 0x00, 0x00, 0xC0 };
        Require(PcmMono.Downmix(int24, 1, PcmLayout.Int24, mono) == 1 && Near(mono[0], -0.5f, 0.00001f), "24-bit samples are sign-extended correctly.");

        var int32 = new byte[4];
        BitConverter.TryWriteBytes(int32.AsSpan(), int.MinValue);
        Require(PcmMono.Downmix(int32, 1, PcmLayout.Int32, mono) == 1 && Near(mono[0], -1), "32-bit PCM minimum maps to negative full scale.");
    }

    static void AnalyzerPlacesTonesInTheirBands() {
        const int rate = 48000;
        foreach (var frequency in new[] { 125d, 500d, 6000d }) {
            var analyzer = new SpectrumAnalyzer();
            var samples = new float[rate / 5];
            for (var i = 0; i < samples.Length; i++) samples[i] = 0.7f * (float)Math.Sin(2 * Math.PI * frequency * i / rate);
            analyzer.Push(samples, rate);
            var frame = new byte[SpectrumAnalyzer.FrameBytes];
            Require(analyzer.TryWriteFrame(frame), $"A {frequency:0} Hz tone produces a spectrum frame.");
            Require(frame.Length == 35, "Spectrum frames preserve the 35-byte wire contract.");

            var edges = SpectrumAnalyzer.BandEdgesHz(rate);
            var expected = Array.FindIndex(edges, 0, edges.Length - 1, edge => frequency >= edge && frequency < edges[Array.IndexOf(edges, edge) + 1]);
            var peak = Array.IndexOf(frame, frame.Take(SpectrumAnalyzer.Bands).Max());

            Require(expected >= 0 && frame[expected] >= 180,
                $"A {frequency:0} Hz sine registers strongly in its expected log band (band {expected} held {frame[expected]}).");
            // At 48 kHz the 2048-point FFT has 23.4 Hz bins. The analyzer assigns a nearest bin
            // when a log band is narrower than one bin, so the low bands share bins. Hann-window
            // leakage and the 42 dB AGC can flatten adjacent low bands; allow three FFT bins plus
            // one band of quantization around the expected band, rather than requiring a false exact peak.
            var tolerance = Math.Max(1, (int)Math.Ceiling(3d * rate / SpectrumAnalyzer.FftSize / (edges[expected + 1] - edges[expected])) + 1);
            Require(Math.Abs(peak - expected) <= tolerance,
                $"A {frequency:0} Hz sine peaks within FFT low-band resolution (expected {expected} ± {tolerance}, got {peak}).");
            Require(frame[32] <= 1 && frame[33] > 0, "Beat flags and overall level use their defined frame slots.");
        }
    }

    static void KickAfterQuietProducesABeat() {
        const int rate = 48000;
        var analyzer = new SpectrumAnalyzer();
        var frame = new byte[SpectrumAnalyzer.FrameBytes];
        var quietHop = rate / 30;
        var quiet = new float[quietHop];
        for (var i = 0; i < 40; i++) {
            for (var n = 0; n < quiet.Length; n++) quiet[n] = 0.02f * (float)Math.Sin(2 * Math.PI * 2000 * (i * quietHop + n) / rate);
            analyzer.Push(quiet, rate);
            analyzer.TryWriteFrame(frame);
        }
        var burst = new float[quietHop * 2];
        for (var n = 0; n < burst.Length; n++) burst[n] = 0.9f * (float)Math.Sin(2 * Math.PI * 70 * n / rate);
        analyzer.Push(burst, rate);
        analyzer.TryWriteFrame(frame);
        Require((frame[SpectrumAnalyzer.Bands] & 1) != 0, "A clear low-frequency kick after quiet produces a beat flag.");
    }
    static void StableAndHighFrequencyAudioDoNotCreateKicks() {
        const int rate = 48000;
        const int hop = rate / 200;
        var steadyDetector = new KickDetector();
        var mixedDetector = new KickDetector();
        var steady = new float[hop];
        var noise = new float[hop];
        var random = new Random(417);
        float previousInput = 0, previousHighPass = 0;
        var steadyBeats = 0;
        var mixedBeats = 0;
        for (var block = 0; block < 600; block++) {
            for (var i = 0; i < hop; i++) {
                var sample = (block * hop) + i;
                steady[i] = 0.3f * (float)Math.Sin(2 * Math.PI * 100 * sample / rate);
                var white = (float)random.NextDouble() * 2 - 1;
                var highPass = 0.52f * (previousHighPass + white - previousInput);
                previousInput = white;
                previousHighPass = highPass;
                noise[i] = 0.2f * highPass;
            }
            steadyDetector.Push(steady, rate);
            mixedDetector.Push(steady, rate);
            mixedDetector.Push(noise, rate);
            var steadyBeat = steadyDetector.TakeBeat();
            var mixedBeat = mixedDetector.TakeBeat();
            if (block >= 100) {
                if (steadyBeat) steadyBeats++;
                if (mixedBeat) mixedBeats++;
            }
        }
        Require(steadyBeats == 0, $"Steady bass after warmup does not create false kicks ({steadyBeats}).");
        Require(mixedBeats == 0, $"Steady bass with high-frequency noise does not create false kicks ({mixedBeats}).");
    }
    static void CaptureRequiresAPlayingInterestedVisualizer() {
        Require(!AudioSpectrum.ShouldCapture(false, true, true, true), "No interested client keeps capture stopped.");
        Require(!AudioSpectrum.ShouldCapture(true, false, true, true), "Paused Spotify keeps capture stopped.");
        Require(!AudioSpectrum.ShouldCapture(true, true, false, false), "A disabled or none visualizer keeps capture stopped.");
        Require(AudioSpectrum.ShouldCapture(true, true, true, false), "An active scene Spotify visualizer enables capture.");
        Require(AudioSpectrum.ShouldCapture(true, true, false, true), "The dedicated Spotify page source enables capture when configured.");
    }

    static void FollowPlayerRecognizesMusicPlayersOnly() {
        Require(SpectrumSource.FollowPlayer.Mode == SpectrumSourceMode.FollowPlayer, "Player-following is the default capture source.");
        Require(SpectrumSource.IsPlayerProcess("Spotify") && SpectrumSource.IsPlayerProcess("spotify_player"), "Spotify players are recognized for endpoint selection.");
        Require(!SpectrumSource.IsPlayerProcess("obs64") && !SpectrumSource.IsPlayerProcess("Discord"), "OBS and unrelated processes are not selected as the music source.");
    }

    static bool Near(float actual, float expected, float tolerance = 0.0001f) => Math.Abs(actual - expected) <= tolerance;
    static void Require(bool condition, string reason) {
        if (!condition) throw new InvalidOperationException("Audio test failed: " + reason);
    }
}
