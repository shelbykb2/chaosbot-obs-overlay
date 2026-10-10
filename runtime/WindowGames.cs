using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace Overlay;

public static class WindowGames {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int count);
    static readonly HashSet<string> Excluded=new(StringComparer.OrdinalIgnoreCase) {"obs64","ChaosBot.Desktop","ChaosBot.Overlay.Runtime","explorer","chrome","msedge","firefox","Code","Codex","Spotify","devenv","powershell","pwsh","WindowsTerminal","ApplicationFrameHost"};
    public static object[] Running() => Process.GetProcesses().Select(p=>{
        using(p) { try { return p.MainWindowHandle!=IntPtr.Zero && !Excluded.Contains(p.ProcessName) ? new {id=p.ProcessName.ToLowerInvariant(),name=Clean(p.MainWindowTitle)} : null; } catch {return null;} }
    }).Where(p=>p!=null&&!string.IsNullOrWhiteSpace(p.name)).GroupBy(p=>p!.id).Select(g=>(object)g.First()!).ToArray();
    public static string? Focused() {
        var h=GetForegroundWindow(); GetWindowThreadProcessId(h,out var pid);
        try {using var p=Process.GetProcessById((int)pid); return Excluded.Contains(p.ProcessName) ? null : p.ProcessName.ToLowerInvariant();} catch {return null;}
    }
    public static string Clean(string value) => new(value.Where(c=>!char.IsControl(c)&&c!='\u200b'&&c!='\ufeff').Take(256).ToArray());
}
