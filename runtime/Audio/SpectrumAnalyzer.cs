namespace Overlay.Audio;

/// <summary>
/// Turns mono samples into the 35-byte frame the Spotify card draws: 32 log-spaced band levels
/// (0-255, low to high), a flags byte (bit 0 = beat onset), the overall level and the low end's punch
/// (see <see cref="KickDetector"/>). The wire shape is
/// fixed by <c>overlay-ui/src/shared/spectrum.ts</c>. Feed it with <see cref="Push"/> from the capture
/// thread and pull frames with <see cref="TryWriteFrame"/> at about 30 Hz.
/// </summary>
public sealed class SpectrumAnalyzer
{
    public const int Bands = 32;
    public const int FrameBytes = Bands + 3;
    public const int FftSize = 2048;

    public const double LowHz = 50;
    public const double HighHz = 16000;

    // A full-scale sine reads 0 dB. Music's treble sits far below its bass, so the floor slides up
    // with frequency (a pink-noise tilt) and the bars use the whole height at every pitch.
    public const double FloorDb = -78;
    public const double CeilingDb = -18;
    public const double TiltDbPerOctave = 3.0;
    private const double TiltRefHz = 100;

    // Automatic gain: the top of the scale follows the loudest band of the last few seconds, so the
    // bars use their full height at any player volume and a quieter mix is not a flat one. The range
    // below that top is narrower than the fixed scale, which is what makes the bars swing with the music.
    public const double AgcRangeDb = 42;
    public const double AgcMinTopDb = -66;          // never amplify a near-silent device into noise
    public const double AgcReleaseDbPerFrame = 0.1; // about 3 dB/s at 30 fps: a volume drop is caught in seconds
    private const double AgcAttack = 0.5;

    private const double Attack = 0.85;
    private const double Release = 0.3;

    private readonly object _gate = new();
    private readonly float[] _ring = new float[FftSize];
    private readonly float[] _window = new float[FftSize];
    private readonly float[] _re = new float[FftSize];
    private readonly float[] _im = new float[FftSize];
    private readonly double[] _shown = new double[Bands];
    private readonly double[] _tiltDb = new double[Bands];
    private int _write;
    private int _sampleRate;
    private int _pushedSinceFrame;
    private int[] _loBin = new int[Bands];
    private int[] _hiBin = new int[Bands];
    private readonly KickDetector _kicks = new();
    private double _topDb = AgcMinTopDb;
    private readonly double[] _bandDb = new double[Bands];

    public SpectrumAnalyzer()
    {
        for (var i = 0; i < FftSize; i++)
        {
            _window[i] = (float)(0.5 - (0.5 * Math.Cos(2 * Math.PI * i / (FftSize - 1))));
        }
    }

    /// <summary>Band edges in Hz: <see cref="Bands"/> + 1 values, log spaced from <see cref="LowHz"/> up.</summary>
    public static double[] BandEdgesHz(int sampleRate)
    {
        var top = Math.Min(HighHz, sampleRate * 0.45);
        var edges = new double[Bands + 1];
        var ratio = Math.Pow(top / LowHz, 1.0 / Bands);
        for (var i = 0; i <= Bands; i++)
        {
            edges[i] = LowHz * Math.Pow(ratio, i);
        }

        return edges;
    }

    /// <summary>
    /// The FFT bins each band reads, inclusive. A band narrower than one bin (the lowest ones) reads the
    /// bin nearest its centre rather than nothing.
    /// </summary>
    public static (int[] Lo, int[] Hi) BandBins(int sampleRate, int fftSize = FftSize)
    {
        var edges = BandEdgesHz(sampleRate);
        var width = (double)sampleRate / fftSize;
        var max = (fftSize / 2) - 1;
        var lo = new int[Bands];
        var hi = new int[Bands];
        for (var b = 0; b < Bands; b++)
        {
            var l = (int)Math.Ceiling(edges[b] / width);
            var h = (int)Math.Floor(edges[b + 1] / width);
            if (h < l)
            {
                l = h = (int)Math.Round((edges[b] + edges[b + 1]) / 2 / width);
            }

            lo[b] = Math.Clamp(l, 1, max);
            hi[b] = Math.Clamp(h, lo[b], max);
        }

        return (lo, hi);
    }

    /// <summary>dB (0 = full-scale sine) to 0..1 against the band's tilted floor and ceiling.</summary>
    public static double ToUnit(double db, double tiltDb = 0)
        => Math.Clamp((db - (FloorDb + tiltDb)) / (CeilingDb - FloorDb), 0, 1);

    /// <summary>
    /// dB (tilt already removed) to 0..1 against the automatic-gain scale whose top is <paramref name="topDb"/>.
    /// </summary>
    public static double ToUnitAgc(double tiltedDb, double topDb)
        => Math.Clamp((tiltedDb - (topDb - AgcRangeDb)) / AgcRangeDb, 0, 1);

    /// <summary>One automatic-gain step: rise quickly to a louder peak, fall slowly after a quieter one.</summary>
    public static double NextTop(double topDb, double framePeakDb)
    {
        var next = framePeakDb > topDb
            ? topDb + ((framePeakDb - topDb) * AgcAttack)
            : topDb - AgcReleaseDbPerFrame;
        return Math.Max(next, AgcMinTopDb);
    }

    /// <summary>Tilt for a band centred on <paramref name="centreHz"/>.</summary>
    public static double TiltFor(double centreHz)
        => centreHz <= TiltRefHz ? 0 : TiltDbPerOctave * Math.Log2(centreHz / TiltRefHz);

    /// <summary>One smoothing step: quick up, slower down.</summary>
    public static double Smooth(double previous, double target)
        => previous + ((target - previous) * (target > previous ? Attack : Release));

    public void Push(ReadOnlySpan<float> mono, int sampleRate)
    {
        if (sampleRate <= 0 || mono.IsEmpty)
        {
            return;
        }

        lock (_gate)
        {
            if (sampleRate != _sampleRate)
            {
                _sampleRate = sampleRate;
                (_loBin, _hiBin) = BandBins(sampleRate);
                var edges = BandEdgesHz(sampleRate);
                for (var b = 0; b < Bands; b++)
                {
                    _tiltDb[b] = TiltFor(Math.Sqrt(edges[b] * edges[b + 1]));
                }
            }

            foreach (var s in mono)
            {
                _ring[_write] = s;
                _write = (_write + 1) % FftSize;
            }

            _pushedSinceFrame += mono.Length;
            _kicks.Push(mono, sampleRate);
        }
    }

    /// <summary>Forgets everything, so the next playback starts from silence.</summary>
    public void Reset()
    {
        lock (_gate)
        {
            Array.Clear(_ring);
            Array.Clear(_shown);
            _write = 0;
            _pushedSinceFrame = 0;
            _kicks.Reset();
            _topDb = AgcMinTopDb;
        }
    }

    /// <summary>
    /// Writes the next frame into <paramref name="frame"/> (<see cref="FrameBytes"/> long). Returns false
    /// before any samples arrived, so nothing is sent for a device that has not produced audio yet. A
    /// loopback delivers nothing while the device is silent; that reads as silence here, so the bars fall.
    /// </summary>
    public bool TryWriteFrame(Span<byte> frame)
    {
        if (frame.Length < FrameBytes)
        {
            throw new ArgumentException("Frame buffer is too small.", nameof(frame));
        }

        lock (_gate)
        {
            if (_sampleRate == 0)
            {
                return false;
            }

            if (_pushedSinceFrame == 0)
            {
                // No packets since the last frame: the device is silent. Slide a hop of zeros in.
                var hop = Math.Min(FftSize, _sampleRate / 30);
                for (var i = 0; i < hop; i++)
                {
                    _ring[_write] = 0;
                    _write = (_write + 1) % FftSize;
                }
            }

            _pushedSinceFrame = 0;

            for (var i = 0; i < FftSize; i++)
            {
                _re[i] = _ring[(_write + i) % FftSize] * _window[i];
                _im[i] = 0;
            }

            Fft(_re, _im);

            // A full-scale sine through a Hann window peaks at sum(window) / 2 = FftSize / 4.
            const double norm = 4.0 / FftSize;
            var framePeak = double.NegativeInfinity;
            for (var b = 0; b < Bands; b++)
            {
                double power = 0;
                var count = _hiBin[b] - _loBin[b] + 1;
                for (var k = _loBin[b]; k <= _hiBin[b]; k++)
                {
                    power += ((double)_re[k] * _re[k]) + ((double)_im[k] * _im[k]);
                }

                var amp = Math.Sqrt(power / count) * norm;
                _bandDb[b] = (20 * Math.Log10(Math.Max(amp, 1e-9))) - _tiltDb[b];
                framePeak = Math.Max(framePeak, _bandDb[b]);
            }

            _topDb = NextTop(_topDb, framePeak);

            double sum = 0;
            for (var b = 0; b < Bands; b++)
            {
                var target = ToUnitAgc(_bandDb[b], _topDb);
                _shown[b] = Smooth(_shown[b], target);
                sum += _shown[b];
                frame[b] = (byte)Math.Round(_shown[b] * 255);
            }

            frame[Bands] = (byte)(_kicks.TakeBeat() ? 1 : 0);
            frame[Bands + 1] = (byte)Math.Round(sum / Bands * 255);
            frame[Bands + 2] = (byte)Math.Round(_kicks.TakePunch() * 255);
            return true;
        }
    }

    private static readonly float[] Cos = BuildTable(true);
    private static readonly float[] Sin = BuildTable(false);

    private static float[] BuildTable(bool cos)
    {
        var t = new float[FftSize / 2];
        for (var i = 0; i < t.Length; i++)
        {
            var a = -2 * Math.PI * i / FftSize;
            t[i] = (float)(cos ? Math.Cos(a) : Math.Sin(a));
        }

        return t;
    }

    /// <summary>In-place radix-2 FFT of <see cref="FftSize"/> points.</summary>
    internal static void Fft(float[] re, float[] im)
    {
        var n = re.Length;
        for (int i = 1, j = 0; i < n; i++)
        {
            var bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1)
            {
                j ^= bit;
            }

            j ^= bit;
            if (i < j)
            {
                (re[i], re[j]) = (re[j], re[i]);
                (im[i], im[j]) = (im[j], im[i]);
            }
        }

        for (var len = 2; len <= n; len <<= 1)
        {
            var half = len >> 1;
            var step = n / len;
            for (var i = 0; i < n; i += len)
            {
                for (var k = 0; k < half; k++)
                {
                    var wr = Cos[k * step];
                    var wi = Sin[k * step];
                    var a = i + k;
                    var c = a + half;
                    var tr = (re[c] * wr) - (im[c] * wi);
                    var ti = (re[c] * wi) + (im[c] * wr);
                    re[c] = re[a] - tr;
                    im[c] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
            }
        }
    }
}
