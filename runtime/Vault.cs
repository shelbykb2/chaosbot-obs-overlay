using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;

namespace Overlay;

// Windows DPAPI binds credentials to the current Windows user. Keys never leave this service.
public sealed class Vault {
    readonly string path;
    readonly object gate = new();
    JsonObject values = new();
    public Vault(string path) {
        this.path = path;
        if (File.Exists(path)) {
            try { values = JsonNode.Parse(Encoding.UTF8.GetString(Transform(File.ReadAllBytes(path),false)))!.AsObject(); }
            catch { throw new InvalidOperationException("The saved credentials could not be unlocked for this Windows user."); }
        }
    }
    public string Get(string key) { lock(gate) return values[key]?.GetValue<string>() ?? ""; }
    public void Set(string key,string value) { lock(gate) { values[key] = value; Persist(); } }
    public void SetMany(Dictionary<string,string> changes) { lock(gate) { foreach(var (key,val) in changes) values[key]=val; Persist(); } }
    void Persist() {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temp=path+".tmp";
        File.WriteAllBytes(temp,Transform(Encoding.UTF8.GetBytes(values.ToJsonString()),true));
        File.Move(temp,path,true);
    }
    [StructLayout(LayoutKind.Sequential)] struct Blob { public int Length; public IntPtr Data; }
    [DllImport("crypt32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CryptProtectData(ref Blob input,string? description,IntPtr entropy,IntPtr reserved,IntPtr prompt,int flags,out Blob output);
    [DllImport("crypt32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CryptUnprotectData(ref Blob input,IntPtr description,IntPtr entropy,IntPtr reserved,IntPtr prompt,int flags,out Blob output);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
    static byte[] Transform(byte[] data,bool protect) {
        var input=new Blob {Length=data.Length,Data=Marshal.AllocHGlobal(data.Length)};
        Blob output=default;
        try {
            Marshal.Copy(data,0,input.Data,data.Length);
            var ok=protect ? CryptProtectData(ref input,"ChaosBot Overlay",IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,1,out output) : CryptUnprotectData(ref input,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,1,out output);
            if(!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            var result=new byte[output.Length]; Marshal.Copy(output.Data,result,0,result.Length); return result;
        } finally { Marshal.FreeHGlobal(input.Data); if(output.Data!=IntPtr.Zero) LocalFree(output.Data); }
    }
}
