using System.Diagnostics;
using System.Runtime.InteropServices;


namespace Overlay.Audio;

/// <summary>
/// The playback devices, by id and name, and which one a music player is playing on. Raw COM vtable
/// calls like the capture, so it stays Native AOT safe.
/// </summary>
/// <remarks>
/// Finding the player walks every device's audio sessions and names each session's process. That is a
/// few cross-process calls per device, so the capture does it on a timer thread, never on the thread
/// that drains the audio.
/// </remarks>
internal static unsafe partial class AudioEndpoints
{
    private static readonly Guid ClsidEnumerator = new("BCDE0395-E52F-467C-8E3D-C4579291692E");
    private static readonly Guid IidEnumerator = new("A95664D2-9614-4F35-A746-DE8DB63617E6");
    private static readonly Guid IidSessionManager2 = new("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
    private static readonly Guid IidSessionControl2 = new("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D");
    private static readonly Guid FriendlyNameFormat = new("A45C254E-DF1C-4EFD-8020-67D146A850E0");

    private const int ClsCtxAll = 0x17;
    private const int ERender = 0;
    private const int StateActive = 1;
    private const int SessionActive = 1;
    private const ushort VtLpwstr = 31;

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey
    {
        public Guid FormatId;
        public uint PropertyId;
    }

    public static nint CreateEnumerator()
    {
        Check(CoCreateInstance(in ClsidEnumerator, 0, ClsCtxAll, in IidEnumerator, out var enumerator));
        return enumerator;
    }

    /// <summary>The id of the device to open for <paramref name="source"/>. Throws when there is no default.</summary>
    /// <param name="current">The device open now: when the player is on two devices, staying put wins.</param>
    public static string Resolve(nint enumerator, SpectrumSource source, string? current)
    {
        switch (source.Mode)
        {
            case SpectrumSourceMode.Device when IsActive(enumerator, source.DeviceId):
                return source.DeviceId;
            case SpectrumSourceMode.FollowPlayer:
                if (FindPlayer(enumerator, current) is { } player)
                {
                    return player;
                }

                break;
        }

        return DefaultId(enumerator);
    }

    public static string DefaultId(nint enumerator)
    {
        nint device;
        Check(((delegate* unmanaged[MemberFunction]<nint, int, int, nint*, int>)Slot(enumerator, 4))(
            enumerator, ERender, 0, &device));
        try
        {
            return IdOf(device);
        }
        finally
        {
            Release(device);
        }
    }

    /// <summary>Opens a device by id. The caller releases it.</summary>
    public static nint Open(nint enumerator, string id)
    {
        nint device;
        fixed (char* p = id)
        {
            Check(((delegate* unmanaged[MemberFunction]<nint, char*, nint*, int>)Slot(enumerator, 5))(enumerator, p, &device));
        }

        return device;
    }

    public static string IdOf(nint device)
    {
        nint id;
        Check(((delegate* unmanaged[MemberFunction]<nint, nint*, int>)Slot(device, 5))(device, &id));
        try
        {
            return Marshal.PtrToStringUni(id) ?? string.Empty;
        }
        finally
        {
            CoTaskMemFree(id);
        }
    }

    /// <summary>The name Windows shows, such as "Speakers (Realtek USB Audio)". Empty if it has none.</summary>
    public static string NameOf(nint device)
    {
        nint store;
        if (((delegate* unmanaged[MemberFunction]<nint, int, nint*, int>)Slot(device, 4))(device, 0, &store) < 0)
        {
            return string.Empty;
        }

        try
        {
            var key = new PropertyKey { FormatId = FriendlyNameFormat, PropertyId = 14 };
            var value = stackalloc byte[24];
            new Span<byte>(value, 24).Clear();
            if (((delegate* unmanaged[MemberFunction]<nint, PropertyKey*, byte*, int>)Slot(store, 5))(store, &key, value) < 0)
            {
                return string.Empty;
            }

            try
            {
                return *(ushort*)value == VtLpwstr ? Marshal.PtrToStringUni(*(nint*)(value + 8)) ?? string.Empty : string.Empty;
            }
            finally
            {
                PropVariantClear(value);
            }
        }
        finally
        {
            Release(store);
        }
    }

    /// <summary>The playback devices that are switched on and plugged in.</summary>
    public static List<AudioOutputDevice> ListActive(nint enumerator)
    {
        var list = new List<AudioOutputDevice>();
        ForEachActive(enumerator, device => list.Add(new AudioOutputDevice(IdOf(device), NameOf(device))));
        return list;
    }

    private static bool IsActive(nint enumerator, string id)
    {
        if (string.IsNullOrEmpty(id))
        {
            return false;
        }

        nint device = 0;
        try
        {
            device = Open(enumerator, id);
            int state;
            return ((delegate* unmanaged[MemberFunction]<nint, int*, int>)Slot(device, 6))(device, &state) >= 0
                && state == StateActive;
        }
        catch (COMException)
        {
            return false;
        }
        finally
        {
            Release(device);
        }
    }

    /// <summary>The device a music player has a playing session on, or null when it has none.</summary>
    private static string? FindPlayer(nint enumerator, string? current)
    {
        string? found = null;
        ForEachActive(enumerator, device =>
        {
            if (found is not null && found == current)
            {
                return;
            }

            var id = IdOf(device);
            if ((found is null || id == current) && HasPlayingPlayer(device))
            {
                found = id;
            }
        });
        return found;
    }

    private static bool HasPlayingPlayer(nint device)
    {
        nint manager = 0, sessions = 0;
        try
        {
            var iid = IidSessionManager2;
            if (((delegate* unmanaged[MemberFunction]<nint, Guid*, int, nint, nint*, int>)Slot(device, 3))(
                    device, &iid, ClsCtxAll, 0, &manager) < 0
                || ((delegate* unmanaged[MemberFunction]<nint, nint*, int>)Slot(manager, 5))(manager, &sessions) < 0)
            {
                return false;
            }

            int count;
            if (((delegate* unmanaged[MemberFunction]<nint, int*, int>)Slot(sessions, 3))(sessions, &count) < 0)
            {
                return false;
            }

            for (var i = 0; i < count; i++)
            {
                nint session = 0, session2 = 0;
                try
                {
                    if (((delegate* unmanaged[MemberFunction]<nint, int, nint*, int>)Slot(sessions, 4))(sessions, i, &session) < 0)
                    {
                        continue;
                    }

                    int state;
                    if (((delegate* unmanaged[MemberFunction]<nint, int*, int>)Slot(session, 3))(session, &state) < 0
                        || state != SessionActive
                        || Marshal.QueryInterface(session, in IidSessionControl2, out session2) < 0)
                    {
                        continue;
                    }

                    uint pid;
                    if (((delegate* unmanaged[MemberFunction]<nint, uint*, int>)Slot(session2, 14))(session2, &pid) >= 0
                        && pid != 0
                        && SpectrumSource.IsPlayerProcess(ProcessName(pid)))
                    {
                        return true;
                    }
                }
                finally
                {
                    Release(session2);
                    Release(session);
                }
            }

            return false;
        }
        finally
        {
            Release(sessions);
            Release(manager);
        }
    }

    private static string? ProcessName(uint pid)
    {
        try
        {
            using var process = Process.GetProcessById((int)pid);
            return process.ProcessName;
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            return null; // it exited
        }
    }

    private static void ForEachActive(nint enumerator, Action<nint> visit)
    {
        nint collection;
        Check(((delegate* unmanaged[MemberFunction]<nint, int, int, nint*, int>)Slot(enumerator, 3))(
            enumerator, ERender, StateActive, &collection));
        try
        {
            uint count;
            Check(((delegate* unmanaged[MemberFunction]<nint, uint*, int>)Slot(collection, 3))(collection, &count));
            for (uint i = 0; i < count; i++)
            {
                nint device;
                if (((delegate* unmanaged[MemberFunction]<nint, uint, nint*, int>)Slot(collection, 4))(collection, i, &device) < 0)
                {
                    continue;
                }

                try
                {
                    visit(device);
                }
                finally
                {
                    Release(device);
                }
            }
        }
        finally
        {
            Release(collection);
        }
    }

    public static nint Slot(nint obj, int index) => (*(nint**)obj)[index];

    public static void Release(nint obj)
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
    private static partial int CoCreateInstance(in Guid clsid, nint outer, int context, in Guid iid, out nint instance);

    [LibraryImport("ole32.dll")]
    private static partial void CoTaskMemFree(nint memory);

    [LibraryImport("ole32.dll")]
    private static partial int PropVariantClear(byte* value);
}
