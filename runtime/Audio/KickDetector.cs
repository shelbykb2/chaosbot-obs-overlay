namespace Overlay.Audio;

/// <summary>
/// Reads the low end's hits from the raw samples as they arrive: a punch level for the cover's bump, and
/// a beat flag for the sparks. Both go out in the spectrum frame, so a late or missed hit is a bump out of
/// time with the song.
/// </summary>
/// <remarks>
/// The low end (a low-pass at <see cref="CutoffHz"/>) is measured every 5 ms over the last 30 ms, in dB,
/// and a kick is a jump over the 30 ms just before. The jump has to clear a fixed minimum and the song's
/// usual jump by a margin, so a busy mix sets its own bar. It also has to come near the loudest the low end
/// was in the 300 ms before: the tail of the last kick beating against the bass note swells too, and so does
/// a bass note on the off-beat, but both stay well under the kick itself.
/// <para>
/// The punch is that jump itself, the largest since the last frame, as a 0-1 level: a hard kick reads high,
/// a bass note low, and nothing between hits. The bump follows it rather than the flag, so it moves exactly
/// when the low end does and never fires off the beat. A flag alone is right most of the time, and a bump
/// that is right most of the time still reads as out of time. Locking to a tempo grid was tried too: on real
/// rock (live drums, a busy bass guitar) the estimate jumped between 74 and 157 BPM.
/// </para>
/// <para>
/// Two things this replaces did not work. A bass level compared with its own average saw only the first
/// second of a song: a bass line that never stops holds the low end near the top of the scale, and a kick
/// on top of it is never 1.4 times the average. And the FFT frame is late for this: the Hann window gives
/// its newest samples almost no weight, so a kick showed 20 to 40 ms after it landed, then waited for a frame.
/// </para>
/// </remarks>
public sealed class KickDetector
{
    public const double CutoffHz = 150;
    public const double MinRiseDb = 1.5;
    public const double Sensitivity = 4.0;   // spreads above the song's usual rise
    public const double FloorDb = -90;       // quieter than this is silence, never a kick
    public const double RefractorySeconds = 0.15;
    public const double PunchFullDb = 8.0;   // a jump this big is a full punch
    public const double PeakMarginDb = 3.0;  // a kick reaches near the loudest low end of the last 300 ms

    private const double HopSeconds = 0.005;
    private const int WindowHops = 6;        // 30 ms
    private const int PeakHops = 60;         // 300 ms
    private const int History = 64;
    private const double StatsSeconds = 1.5;

    private readonly double[] _hopEnergy = new double[History];
    private readonly double[] _windowDb = new double[History];
    private int _rate;
    private int _hopLength;
    private double _alpha;
    private int _refractoryHops;
    private double _statsRate;
    private double _lp1;
    private double _lp2;
    private double _acc;
    private int _inHop;
    private long _hops;
    private long _lastBeatHop;
    private double _riseAvg;
    private double _riseSpread;
    private bool _pending;
    private double _punch;

    public KickDetector() => Reset();

    /// <summary>Whether a rise (dB over the 30 ms before) is a kick against the song's usual rise and its spread.</summary>
    public static bool IsKick(double riseDb, double usualRiseDb, double spreadDb)
        => riseDb >= MinRiseDb && riseDb > usualRiseDb + (Sensitivity * spreadDb);

    public void Push(ReadOnlySpan<float> mono, int sampleRate)
    {
        if (sampleRate <= 0)
        {
            return;
        }

        if (sampleRate != _rate)
        {
            Reset();
            _rate = sampleRate;
            _hopLength = Math.Max(1, (int)Math.Round(sampleRate * HopSeconds));
            _alpha = 1 - Math.Exp(-2 * Math.PI * CutoffHz / sampleRate);
            _refractoryHops = (int)Math.Round(RefractorySeconds / HopSeconds);
            _statsRate = HopSeconds / StatsSeconds;
        }

        foreach (var x in mono)
        {
            // Two one-pole low-passes: 12 dB an octave, so the hats and the vocals stay out.
            _lp1 += _alpha * (x - _lp1);
            _lp2 += _alpha * (_lp1 - _lp2);
            _acc += _lp2 * _lp2;
            if (++_inHop == _hopLength)
            {
                EndHop();
            }
        }
    }

    /// <summary>The hardest hit since the last call, 0-1, and starts again from 0.</summary>
    public double TakePunch()
    {
        var punch = _punch;
        _punch = 0;
        return punch;
    }

    /// <summary>True once for each kick found since the last call.</summary>
    public bool TakeBeat()
    {
        var beat = _pending;
        _pending = false;
        return beat;
    }

    public void Reset()
    {
        Array.Clear(_hopEnergy);
        Array.Fill(_windowDb, FloorDb);
        _lp1 = _lp2 = _acc = 0;
        _inHop = 0;
        _hops = 0;
        _lastBeatHop = -1_000_000;
        _riseAvg = _riseSpread = 0;
        _pending = false;
        _punch = 0;
    }

    private void EndHop()
    {
        var slot = (int)(_hops % History);
        _hopEnergy[slot] = _acc;
        _acc = 0;
        _inHop = 0;

        double energy = 0;
        for (var i = 0; i < WindowHops; i++)
        {
            energy += _hopEnergy[(int)((_hops - i + History) % History)];
        }

        // A full-scale sine reads 0 dB.
        var meanSquare = energy / (WindowHops * _hopLength);
        var db = Math.Max(10 * Math.Log10(Math.Max(2 * meanSquare, 1e-12)), FloorDb);
        _windowDb[slot] = db;

        double strength = 0;
        if (_hops >= WindowHops + 1)
        {
            // Against the window just before this one: the lower of two, so a kick that straddles
            // them still shows its whole rise.
            var a = _windowDb[(int)((_hops - WindowHops) % History)];
            var b = _windowDb[(int)((_hops - WindowHops - 1) % History)];
            var rise = Math.Max(0, db - Math.Min(a, b));
            var recentPeak = FloorDb;
            for (var i = WindowHops + 2; i <= Math.Min(PeakHops, _hops); i++)
            {
                recentPeak = Math.Max(recentPeak, _windowDb[(int)((_hops - i) % History)]);
            }

            // Rises that reach the recent peak count in full; the rest (a kick's tail swelling against
            // the bass, a quieter note) only a little.
            var peaky = db >= recentPeak - PeakMarginDb;
            strength = peaky ? rise : rise * 0.25;
            var ready = _hops - _lastBeatHop >= _refractoryHops;
            if (ready && IsKick(rise, _riseAvg, _riseSpread) && peaky)
            {
                _pending = true;
                _lastBeatHop = _hops;
            }
            else if (ready)
            {
                // Learned only between kicks, so a busy beat does not raise the bar for the next one.
                _riseAvg += (rise - _riseAvg) * _statsRate;
                _riseSpread += (Math.Abs(rise - _riseAvg) - _riseSpread) * _statsRate;
            }
        }

        _punch = Math.Max(_punch, Math.Clamp(strength / PunchFullDb, 0, 1));
        _hops++;
    }
}
