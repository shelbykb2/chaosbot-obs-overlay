using System.Runtime.InteropServices;

namespace Overlay.Audio;

/// <summary>
/// A native IMMNotificationClient that only notes when the default playback device changes.
/// Windows calls it, so the capture never has to ask.
/// </summary>
/// <remarks>
/// It replaces a check every 500 ms that asked the audio service for the default device and its id.
/// That is a cross-process call; it usually took 2 ms but sometimes 25, on a thread that is meant to
/// drain audio packets every 15 ms.
/// <para>
/// Native AOT, like the capture: a block of native memory laid out as a COM object (vtable pointer
/// first) with static unmanaged callbacks, so nothing is marshalled and nothing can be trimmed.
/// Windows calls it on its own thread; the only state is one flag, written there and read by the
/// capture thread. Its lifetime is the owner's, so AddRef and Release count nothing: the owner
/// unregisters it before freeing it.
/// </para>
/// </remarks>
internal sealed unsafe class DefaultDeviceWatch : IDisposable
{
    private const int NoInterface = unchecked((int)0x80004002);
    private const int ERender = 0;
    private const int EConsole = 0;

    private static readonly Guid IidUnknown = new("00000000-0000-0000-C000-000000000046");
    private static readonly Guid IidNotificationClient = new("7991EEC9-7E89-4D85-8390-6C703CEC60C0");
    private static readonly nint* Vtable = BuildVtable();

    [StructLayout(LayoutKind.Sequential)]
    private struct Native
    {
        public nint* Vtbl;
        public int Changed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey
    {
        public Guid FormatId;
        public uint PropertyId;
    }

    private Native* _native;

    public DefaultDeviceWatch()
    {
        _native = (Native*)NativeMemory.AllocZeroed((nuint)sizeof(Native));
        _native->Vtbl = Vtable;
    }

    /// <summary>The IMMNotificationClient pointer to register.</summary>
    public nint ComPointer => (nint)_native;

    /// <summary>True once the default playback device has changed since this was made.</summary>
    public bool Changed => Volatile.Read(ref _native->Changed) != 0;

    public void Dispose()
    {
        if (_native != null)
        {
            NativeMemory.Free(_native);
            _native = null;
        }
    }

    private static nint* BuildVtable()
    {
        var v = (nint*)NativeMemory.Alloc(8, (nuint)sizeof(nint));
        v[0] = (nint)(delegate* unmanaged<nint, Guid*, nint*, int>)&QueryInterface;
        v[1] = (nint)(delegate* unmanaged<nint, uint>)&AddRef;
        v[2] = (nint)(delegate* unmanaged<nint, uint>)&AddRef;
        v[3] = (nint)(delegate* unmanaged<nint, char*, uint, int>)&OnDeviceStateChanged;
        v[4] = (nint)(delegate* unmanaged<nint, char*, int>)&OnDeviceAddedOrRemoved;
        v[5] = (nint)(delegate* unmanaged<nint, char*, int>)&OnDeviceAddedOrRemoved;
        v[6] = (nint)(delegate* unmanaged<nint, int, int, char*, int>)&OnDefaultDeviceChanged;
        v[7] = (nint)(delegate* unmanaged<nint, char*, PropertyKey, int>)&OnPropertyValueChanged;
        return v;
    }

    [UnmanagedCallersOnly]
    private static int QueryInterface(nint self, Guid* iid, nint* result)
    {
        if (*iid == IidUnknown || *iid == IidNotificationClient)
        {
            *result = self;
            return 0;
        }

        *result = 0;
        return NoInterface;
    }

    [UnmanagedCallersOnly]
    private static uint AddRef(nint self) => 1;

    [UnmanagedCallersOnly]
    private static int OnDeviceStateChanged(nint self, char* id, uint state) => 0;

    [UnmanagedCallersOnly]
    private static int OnDeviceAddedOrRemoved(nint self, char* id) => 0;

    [UnmanagedCallersOnly]
    private static int OnDefaultDeviceChanged(nint self, int flow, int role, char* id)
    {
        // Only the device the capture follows: playback, console role. A null id means there is none
        // now (unplugged); the capture reopens and backs off until one returns.
        if (flow == ERender && role == EConsole)
        {
            Volatile.Write(ref ((Native*)self)->Changed, 1);
        }

        return 0;
    }

    [UnmanagedCallersOnly]
    private static int OnPropertyValueChanged(nint self, char* id, PropertyKey key) => 0;

    /// <summary>Calls one of the object's own vtable slots, the way Windows would. For tests.</summary>
    internal int CallDefaultDeviceChanged(int flow, int role)
        => ((delegate* unmanaged<nint, int, int, char*, int>)Vtable[6])(ComPointer, flow, role, null);

    /// <summary>For tests: QueryInterface through the vtable.</summary>
    internal int CallQueryInterface(Guid iid, out nint result)
    {
        nint r;
        var hr = ((delegate* unmanaged<nint, Guid*, nint*, int>)Vtable[0])(ComPointer, &iid, &r);
        result = r;
        return hr;
    }
}
