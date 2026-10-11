using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;

namespace Overlay;

// Kept byte-for-byte compatible with ChaosBot's desktop account fingerprint algorithm.
public static class HardwareFingerprint {
    static readonly Lazy<string> V2 = new(() => ComputeV2(ReadMachineGuid(), ReadSmbiosUuid()) ?? ComputeLegacy());
    public static string Compute() => V2.Value;
    public static string ComputeLegacy() {
        var sb = new StringBuilder(256);
        sb.Append(Environment.MachineName).Append('|').Append(Environment.OSVersion.VersionString).Append('|').Append(FirstPhysicalMac() ?? "none");
        return Hash(sb.ToString());
    }
    public static bool Matches(string? fingerprint) => !string.IsNullOrWhiteSpace(fingerprint) &&
        (string.Equals(fingerprint.Trim(), Compute(), StringComparison.OrdinalIgnoreCase) || string.Equals(fingerprint.Trim(), ComputeLegacy(), StringComparison.OrdinalIgnoreCase));
    public static string? ComputeV2(string? machineGuid, string? smbiosUuid) {
        var guid = (machineGuid ?? "").Trim().ToLowerInvariant(); var uuid = (smbiosUuid ?? "").Trim().ToLowerInvariant();
        return guid.Length == 0 && uuid.Length == 0 ? null : Hash("v2|" + guid + "|" + uuid);
    }
    static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    static string? ReadMachineGuid() {
        if (!OperatingSystem.IsWindows()) return null;
        try { using var root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64); using var key = root.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography"); return key?.GetValue("MachineGuid") as string; } catch { return null; }
    }
    static string? ReadSmbiosUuid() {
        if (!OperatingSystem.IsWindows()) return null;
        try { const uint rsmb = 0x52534D42; var size = GetSystemFirmwareTable(rsmb, 0, null, 0); if (size == 0) return null; var buffer = new byte[size]; return GetSystemFirmwareTable(rsmb, 0, buffer, size) == size ? ParseSmbiosUuid(buffer) : null; } catch { return null; }
    }
    public static string? ParseSmbiosUuid(byte[] raw) {
        const int header = 8; if (raw.Length < header) return null;
        var end = Math.Min(raw.Length, header + (int)BitConverter.ToUInt32(raw, 4)); var i = header;
        while (i + 4 <= end) {
            var type = raw[i]; var length = raw[i + 1]; if (length < 4) return null;
            if (type == 1 && length >= 0x18 && i + 0x18 <= end) { var uuid = raw.AsSpan(i + 8, 16); if (uuid.IndexOfAnyExcept((byte)0) < 0 || uuid.IndexOfAnyExcept((byte)255) < 0) return null; return Convert.ToHexString(uuid).ToLowerInvariant(); }
            if (type == 127) return null;
            var j = i + length; while (j + 1 < end && (raw[j] != 0 || raw[j + 1] != 0)) j++; i = j + 2;
        }
        return null;
    }
    static string? FirstPhysicalMac() {
        try { foreach (var nic in NetworkInterface.GetAllNetworkInterfaces()) { if (nic.NetworkInterfaceType == NetworkInterfaceType.Loopback || nic.OperationalStatus != OperationalStatus.Up) continue; var bytes = nic.GetPhysicalAddress()?.GetAddressBytes(); if (bytes is { Length: > 0 }) return Convert.ToHexString(bytes); } } catch { }
        return null;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetSystemFirmwareTable(uint provider, uint id, byte[]? buffer, uint size);
}
