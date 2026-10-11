namespace Overlay;

internal static class HubOrigin {
    internal static bool Allowed(string origin, int runtimePort) => origin.Length == 0 ||
        origin == "http://127.0.0.1:5260" || origin == "http://localhost:5260" ||
        origin == $"http://127.0.0.1:{runtimePort}" || origin == $"http://localhost:{runtimePort}";
}
