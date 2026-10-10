using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.SignalR;

namespace Overlay;

/// <summary>Owns encrypted credentials, provider authorization, and the normalized live state.</summary>
public sealed class Connections {
    public const string DefaultTwitchClientId = "r0se55c0m8ba1fsmp6iewuq8md6l2b";
    const string TwitchAuth = "https://id.twitch.tv/oauth2";
    const string TwitchApi = "https://api.twitch.tv/helix";
    const string SpotifyAuth = "https://accounts.spotify.com";
    const string SpotifyApi = "https://api.spotify.com/v1";
    readonly OverlayState state;
    readonly Vault vault;
    readonly HttpClient http;
    readonly IHubContext<OverlayHub> hub;
    readonly object gate = new();
    readonly Queue<JsonObject> chat = new();
    readonly HashSet<string> chatIds = new(StringComparer.Ordinal);
    readonly Queue<string> chatIdOrder = new();
    readonly Queue<string> eventIds = new();
    readonly HashSet<string> seenEvents = new(StringComparer.Ordinal);
    readonly Dictionary<string, long> goals = new(StringComparer.Ordinal);
    readonly Dictionary<string, string> goalResets = new(StringComparer.Ordinal);
    string twitchStatus = "Disconnected", spotifyStatus = "Disconnected", companionStatus = "Not connected";
    string twitchUserId = "", twitchLogin = "", spotifyState = "", spotifyVerifier = "";
    long twitchGeneration, spotifyGeneration, chaosGeneration;
    DateTimeOffset spotifyStateExpires = DateTimeOffset.MinValue;
    string? twitchDeviceCode;
    DateTimeOffset twitchDeviceNext = DateTimeOffset.MinValue, twitchDeviceExpires = DateTimeOffset.MinValue;
    int twitchDeviceInterval = 5;
    DateTimeOffset twitchTokenExpires = DateTimeOffset.MinValue;
    DateTimeOffset spotifyTokenExpires = DateTimeOffset.MinValue;
    bool twitchFeedWarning;
    JsonObject? category, nowPlaying;
    string lastSpotifyTrack = "";
    string spotifyArtUrl = "";
    string goalFile => Path.Combine(state.Site, "overlay", "goals.json");
    bool companionOnline;
    public Action<JsonObject>? ImportExternalScene { get; set; }
    public event Action<JsonObject>? SceneChangedExternally;
    public void NotifySceneChangedExternally(JsonObject document) => SceneChangedExternally?.Invoke(document);

    public Connections(OverlayState state, Vault vault, HttpClient http, IHubContext<OverlayHub> hub) {
        this.state = state; this.vault = vault; this.http = http; this.hub = hub;
        LoadGoals();
        companionStatus = vault.Get("license").Length == 0 ? "Not connected" : "Checking ChaosBot";
    }

    public bool TwitchConnected { get { lock (gate) return !string.IsNullOrEmpty(vault.Get("twitchAccessToken")) && twitchUserId.Length > 0 && twitchStatus is "Connected" or "Some feeds unavailable" or "Reconnecting"; } }
    public JsonObject? Category { get { lock (gate) return category?.DeepClone().AsObject(); } }
    public JsonObject? NowPlaying { get { lock (gate) return nowPlaying?.DeepClone().AsObject(); } }
    public object[] ChatHistory { get { lock (gate) return chat.Select(x => x.DeepClone()).Cast<object>().ToArray(); } }

    public object PublicStatus() {
        lock (gate) return new {
            companion = companionOnline,
            twitch = new { connected = TwitchConnected, status = twitchStatus, name = twitchLogin },
            spotify = new { connected = spotifyStatus == "Connected", status = spotifyStatus },
            chaosbot = new { connected = companionOnline, status = companionStatus,
                tier = vault.Get("tier"), email = vault.Get("email") }
        };
    }

    public object Settings() {
        lock (gate) return new {
            aiProvider = vault.Get("aiProvider") is {Length:>0} provider ? provider : "hosted", apiKey = vault.Get("apiKey").Length == 0 ? "" : "••••••••",
            hasApiKey = vault.Get("apiKey").Length != 0, model = vault.Get("model"), baseUrl = vault.Get("baseUrl"),
            spotifyClientId = vault.Get("spotifyClientId"), twitchClientId = TwitchClientId,
            hasChaosBotLicense = vault.Get("license").Length != 0, chaosBotTier = vault.Get("tier")
        };
    }

    public Task SaveSettings(JsonObject input) {
        var changes = new Dictionary<string, string>(StringComparer.Ordinal);
        CopyText(input, changes, "aiProvider", 30, new[] { "hosted", "openai", "anthropic", "gemini", "custom" });
        CopyText(input, changes, "model", 120); CopyText(input, changes, "baseUrl", 500);
        CopyText(input, changes, "spotifyClientId", 160); CopyText(input, changes, "twitchClientId", 160);
        if (changes.TryGetValue("aiProvider",out var selected) && selected != vault.Get("aiProvider") || changes.TryGetValue("baseUrl",out var destination) && destination != vault.Get("baseUrl")) changes["apiKey"]="";
        if (input["apiKey"] is JsonValue key && key.TryGetValue<string>(out var raw) && raw != "••••••••") {
            if (raw.Length > 2000 || raw.Any(char.IsControl)) throw new InvalidDataException("The API key is invalid.");
            changes["apiKey"] = raw.Trim();
        }
        if (changes.TryGetValue("baseUrl", out var url) && url.Length > 0 && (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0 || uri.Scheme != Uri.UriSchemeHttps && !(uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback)))
            throw new InvalidDataException("Use an HTTPS API address, or a local loopback address.");
        vault.SetMany(changes);
        return Task.CompletedTask;
    }

    static void CopyText(JsonObject input, Dictionary<string, string> output, string key, int max, string[]? choices = null) {
        if (input[key] is not JsonValue v || !v.TryGetValue<string>(out var text)) return;
        text = text.Trim();
        if (text.Length > max || text.Any(char.IsControl) || choices is not null && !choices.Contains(text, StringComparer.Ordinal)) throw new InvalidDataException($"The {key} setting is invalid.");
        output[key] = text;
    }

    public async Task Disconnect(string provider) {
        switch (provider.Trim().ToLowerInvariant()) {
            case "twitch":
                lock (gate) { twitchGeneration++; twitchDeviceCode = null; }
                vault.SetMany(new() { ["twitchAccessToken"] = "", ["twitchRefreshToken"] = "", ["twitchTokenExpiry"] = "", ["twitchUserId"] = "", ["twitchLogin"] = "" });
                lock (gate) { twitchStatus = "Disconnected"; twitchUserId = ""; twitchLogin = ""; twitchDeviceCode = null; twitchFeedWarning = false; category = null; chat.Clear(); chatIds.Clear(); chatIdOrder.Clear(); }
                await hub.Clients.All.SendAsync("chatHistory", new { lines = Array.Empty<object>() });
                break;
            case "spotify":
                lock (gate) { spotifyGeneration++; }
                vault.SetMany(new() { ["spotifyAccessToken"] = "", ["spotifyRefreshToken"] = "", ["spotifyTokenExpiry"] = "" });
                lock (gate) { spotifyStatus = "Disconnected"; nowPlaying = null; lastSpotifyTrack = ""; spotifyArtUrl = ""; spotifyState = ""; spotifyVerifier = ""; }
                await hub.Clients.All.SendAsync("nowPlaying", (object?)null);
                break;
            case "chaosbot":
                lock (gate) { chaosGeneration++; }
                vault.SetMany(new() { ["license"] = "", ["fingerprint"] = "", ["tier"] = "", ["email"] = "" });
                lock (gate) companionStatus = "Not connected";
                break;
            default: throw new InvalidDataException("Unknown connection.");
        }
    }

    public async Task<object> Connect(string provider) {
        switch (provider.Trim().ToLowerInvariant()) {
            case "twitch": return await StartTwitchDeviceGrant();
            case "spotify": return await StartSpotifyAuthorization();
            case "chaosbot": return await ConnectChaosBot();
            default: throw new InvalidDataException("Unknown connection.");
        }
    }

    async Task<object> StartTwitchDeviceGrant() {
        var id = RequiredClientId("twitchClientId", "Twitch");
        using var res = await http.PostAsync($"{TwitchAuth}/device", new FormUrlEncodedContent(new Dictionary<string, string> { ["client_id"] = id, ["scopes"] = "moderator:read:followers moderator:read:chat channel:read:subscriptions bits:read user:read:chat channel:read:redemptions" }));
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
        if (!res.IsSuccessStatusCode) throw new InvalidOperationException("Twitch could not start sign in. Check the public client ID.");
        var root = doc.RootElement; var device = root.GetProperty("device_code").GetString()!; var url = root.GetProperty("verification_uri").GetString()!; var code = root.GetProperty("user_code").GetString()!;
        lock (gate) { twitchGeneration++; twitchDeviceCode = device; twitchFeedWarning = false; twitchDeviceInterval = Math.Clamp(root.TryGetProperty("interval", out var iv) ? iv.GetInt32() : 5, 2, 30); twitchDeviceNext = DateTimeOffset.UtcNow; twitchDeviceExpires = DateTimeOffset.UtcNow.AddSeconds(root.GetProperty("expires_in").GetInt32()); twitchStatus = "Waiting for sign in"; }
        OpenBrowser(url);
        return new { url, code };
    }

    public async Task PollTwitchAuthorization() {
        string? device; int interval; long generation; lock (gate) { device = twitchDeviceCode; interval = twitchDeviceInterval; generation = twitchGeneration; if (device is null || DateTimeOffset.UtcNow < twitchDeviceNext) return; twitchDeviceNext = DateTimeOffset.UtcNow.AddSeconds(interval); }
        if (DateTimeOffset.UtcNow >= twitchDeviceExpires) { lock (gate) { twitchDeviceCode = null; twitchStatus = "Sign in expired"; } return; }
        var id = RequiredClientId("twitchClientId", "Twitch");
        using var response = await http.PostAsync($"{TwitchAuth}/token", new FormUrlEncodedContent(new Dictionary<string, string> { ["client_id"] = id, ["device_code"] = device!, ["grant_type"] = "urn:ietf:params:oauth:grant-type:device_code" }));
        var body = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(body);
        if (!response.IsSuccessStatusCode) {
            var err = doc.RootElement.TryGetProperty("error", out var e) ? e.GetString() : "";
            if (err == "authorization_pending") return;
            if (err == "slow_down") { lock (gate) twitchDeviceInterval = Math.Min(30, twitchDeviceInterval + 5); return; }
            lock (gate) { twitchDeviceCode = null; twitchStatus = "Sign in failed"; } return;
        }
        var root = doc.RootElement;
        lock (gate) { if (generation != twitchGeneration || twitchDeviceCode != device) return; StoreTwitchToken(root); twitchDeviceCode = null; twitchStatus = "Checking account"; }
        await ValidateTwitch();
    }

    async Task<object> StartSpotifyAuthorization() {
        var id = RequiredClientId("spotifyClientId", "Spotify");
        var stateValue = Convert.ToHexString(RandomNumberGenerator.GetBytes(20)).ToLowerInvariant();
        var verifier = Base64Url(RandomNumberGenerator.GetBytes(48));
        var challenge = Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
        lock (gate) { spotifyGeneration++; spotifyState = stateValue; spotifyVerifier = verifier; spotifyStateExpires = DateTimeOffset.UtcNow.AddMinutes(10); spotifyStatus = "Waiting for sign in"; }
        var query = new Dictionary<string, string> {
            ["client_id"] = id, ["response_type"] = "code", ["redirect_uri"] = "http://127.0.0.1:5261/auth/spotify/callback",
            ["scope"] = "user-read-currently-playing user-read-playback-state user-read-private", ["state"] = stateValue,
            ["code_challenge_method"] = "S256", ["code_challenge"] = challenge
        };
        var url = "https://accounts.spotify.com/authorize?" + Query(query);
        OpenBrowser(url);
        return new { url };
    }

    public async Task SpotifyCallback(string callbackState, string code) {
        string expected, verifier; long generation; bool valid;
        lock (gate) {
            expected = spotifyState; verifier = spotifyVerifier; generation = spotifyGeneration;
            valid = DateTimeOffset.UtcNow <= spotifyStateExpires && expected.Length >= 20 &&
                CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(callbackState)) && !string.IsNullOrWhiteSpace(code);
            if (valid) { spotifyState = ""; spotifyVerifier = ""; spotifyStateExpires = DateTimeOffset.MinValue; }
        }
        if (!valid) throw new InvalidDataException("Spotify sign in was invalid or expired. Try connecting again.");
        var id = RequiredClientId("spotifyClientId", "Spotify");
        using var response = await http.PostAsync($"{SpotifyAuth}/api/token", new FormUrlEncodedContent(new Dictionary<string, string> { ["client_id"] = id, ["grant_type"] = "authorization_code", ["code"] = code, ["redirect_uri"] = "http://127.0.0.1:5261/auth/spotify/callback", ["code_verifier"] = verifier }));
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        if (!response.IsSuccessStatusCode) { lock (gate) if (generation == spotifyGeneration) spotifyStatus = "Sign in failed"; throw new InvalidOperationException("Spotify could not finish sign in. Check the redirect URL in your app settings."); }
        lock (gate) { if (generation != spotifyGeneration) throw new InvalidDataException("Spotify sign in was replaced. Connect again."); StoreSpotifyToken(doc.RootElement); spotifyStatus = "Connected"; }
        await PollSpotify();
    }

    async Task<object> ConnectChaosBot() {
        var redirect = "http://127.0.0.1:5006/auth/chaosbot/callback"; var fingerprint = HardwareFingerprint.Compute(); var legacy = HardwareFingerprint.ComputeLegacy();
        var stateValue = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)); var listener = new HttpListener(); listener.Prefixes.Add("http://127.0.0.1:5006/");
        try { listener.Start(); } catch (HttpListenerException) { throw new InvalidOperationException("Port 5006 is busy. Close the other ChaosBot sign in and try again."); }
        long generation; lock (gate) { generation = ++chaosGeneration; companionStatus = "Waiting for sign in"; }
        try {
            var url = "https://chaosbot.shelbykb.dev/desktop/connect?redirect_uri=" + Uri.EscapeDataString(redirect) + "&state=" + Uri.EscapeDataString(stateValue) + "&fingerprint=" + Uri.EscapeDataString(fingerprint);
            OpenBrowser(url);
            using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(10));
            var code = await WaitForChaosCode(listener, stateValue, timeout.Token);
            var form = new Dictionary<string, string> { ["code"] = code, ["state"] = stateValue, ["fingerprint"] = fingerprint, ["legacy_fingerprint"] = legacy };
            if (vault.Get("twitchAccessToken") is { Length: > 0 } twitchToken) form["twitch_token"] = twitchToken;
            using var response = await http.PostAsync("https://chaosbot.shelbykb.dev/api/desktop/exchange", new FormUrlEncodedContent(form));
            using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync()); var root = doc.RootElement;
            if (!response.IsSuccessStatusCode || !root.TryGetProperty("ok", out var ok) || !ok.GetBoolean()) throw new InvalidOperationException(root.TryGetProperty("error", out var err) ? err.GetString() : "ChaosBot account sign in failed.");
            var tier = root.TryGetProperty("tier", out var t) ? t.GetString() ?? "pro" : "pro";
            lock (gate) { if (generation != chaosGeneration) throw new InvalidDataException("ChaosBot sign in was replaced. Connect again."); vault.SetMany(new() { ["license"] = root.GetProperty("license").GetString()!, ["fingerprint"] = fingerprint, ["tier"] = tier, ["email"] = root.TryGetProperty("email", out var em) ? em.GetString() ?? "" : "" }); companionStatus = "Connected"; }
            return new { connected = true, tier };
        } catch { lock (gate) if (generation == chaosGeneration) companionStatus = "Sign in failed"; throw; }
        finally { listener.Close(); }
    }

    static async Task<string> WaitForChaosCode(HttpListener listener, string expectedState, CancellationToken ct) {
        while (true) {
            var pending = listener.GetContextAsync();
            _ = pending.ContinueWith(static t => _ = t.Exception, CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            var ctx = await pending.WaitAsync(ct);
            if (!string.Equals(ctx.Request.Url?.AbsolutePath, "/auth/chaosbot/callback", StringComparison.Ordinal) || ctx.Request.HttpMethod != "GET") { ctx.Response.StatusCode = 404; ctx.Response.Close(); continue; }
            var code = ctx.Request.QueryString["code"]; var got = ctx.Request.QueryString["state"] ?? "";
            var valid = code?.Length is > 0 and < 4096 && CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(expectedState), Encoding.UTF8.GetBytes(got));
            var body = Encoding.UTF8.GetBytes(valid ? "<title>Connected</title><p>You can close this tab and return to ChaosBot.</p>" : "<title>Sign in failed</title><p>Return to ChaosBot and try again.</p>");
            ctx.Response.ContentType = "text/html; charset=utf-8"; ctx.Response.ContentLength64 = body.Length; await ctx.Response.OutputStream.WriteAsync(body, ct); ctx.Response.Close();
            if (!valid) throw new InvalidDataException("ChaosBot sign in callback was invalid.");
            return code!;
        }
    }

    static void OpenBrowser(string url) { try { Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true, WindowStyle = ProcessWindowStyle.Hidden }); } catch { /* The returned URL remains available to the UI. */ } }
    string RequiredClientId(string key, string provider) => (key == "twitchClientId" ? TwitchClientId : vault.Get(key).Trim()) is { Length: > 0 } value ? value : throw new InvalidDataException($"Add your {provider} public app client ID in Connections first.");
    static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    static string Query(Dictionary<string, string> values) => string.Join("&", values.Select(p => Uri.EscapeDataString(p.Key) + "=" + Uri.EscapeDataString(p.Value)));

    void StoreTwitchToken(JsonElement root) {
        var expiry = DateTimeOffset.UtcNow.AddSeconds(root.TryGetProperty("expires_in", out var e) ? Math.Max(60, e.GetInt32()) : 3600);
        var changes = new Dictionary<string, string> { ["twitchAccessToken"] = root.GetProperty("access_token").GetString()!, ["twitchTokenExpiry"] = expiry.ToUnixTimeSeconds().ToString() };
        if (root.TryGetProperty("refresh_token", out var r)) changes["twitchRefreshToken"] = r.GetString() ?? "";
        vault.SetMany(changes); lock (gate) twitchTokenExpires = expiry;
    }
    void StoreSpotifyToken(JsonElement root) {
        var expiry = DateTimeOffset.UtcNow.AddSeconds(root.TryGetProperty("expires_in", out var e) ? Math.Max(60, e.GetInt32()) : 3600);
        var changes = new Dictionary<string, string> { ["spotifyAccessToken"] = root.GetProperty("access_token").GetString()!, ["spotifyTokenExpiry"] = expiry.ToUnixTimeSeconds().ToString() };
        if (root.TryGetProperty("refresh_token", out var r)) changes["spotifyRefreshToken"] = r.GetString() ?? vault.Get("spotifyRefreshToken");
        vault.SetMany(changes); lock (gate) spotifyTokenExpires = expiry;
    }

    public async Task ValidateTwitch() {
        string token; long generation; lock (gate) { token = vault.Get("twitchAccessToken"); generation = twitchGeneration; }
        if (token.Length == 0) { lock (gate) if (generation == twitchGeneration) twitchStatus = "Disconnected"; return; }
        using var req = new HttpRequestMessage(HttpMethod.Get, $"{TwitchAuth}/validate"); req.Headers.Authorization = new AuthenticationHeaderValue("OAuth", token);
        using var res = await http.SendAsync(req); if (res.StatusCode == HttpStatusCode.Unauthorized) { await RefreshTwitch(generation); return; }
        if (!res.IsSuccessStatusCode) { lock (gate) if (generation == twitchGeneration) twitchStatus = "Reconnecting"; return; }
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync()); var root = doc.RootElement;
        lock (gate) {
            if (generation != twitchGeneration) return;
            twitchUserId = root.TryGetProperty("user_id", out var u) ? u.GetString() ?? "" : vault.Get("twitchUserId");
            twitchLogin = root.TryGetProperty("login", out var l) ? l.GetString() ?? "" : vault.Get("twitchLogin");
            twitchStatus = twitchUserId.Length > 0 ? twitchFeedWarning ? "Some feeds unavailable" : "Connected" : "Needs reconnect";
            vault.SetMany(new() { ["twitchUserId"] = twitchUserId, ["twitchLogin"] = twitchLogin });
        }
    }
    async Task RefreshTwitch(long generation) {
        string refresh; lock (gate) { if (generation != twitchGeneration) return; refresh = vault.Get("twitchRefreshToken"); }
        if (refresh.Length == 0) { lock (gate) if (generation == twitchGeneration) twitchStatus = "Reconnect required"; return; }
        using var res = await http.PostAsync($"{TwitchAuth}/token", new FormUrlEncodedContent(new Dictionary<string, string> { ["client_id"] = RequiredClientId("twitchClientId", "Twitch"), ["grant_type"] = "refresh_token", ["refresh_token"] = refresh }));
        if (!res.IsSuccessStatusCode) { lock (gate) if (generation == twitchGeneration) twitchStatus = "Reconnect required"; return; }
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
        lock (gate) { if (generation != twitchGeneration) return; StoreTwitchToken(doc.RootElement); }
        await ValidateTwitch();
    }
    public async Task EnsureTwitchValid() {
        long generation; string status; lock (gate) { generation = twitchGeneration; status = twitchStatus; if (vault.Get("twitchAccessToken").Length == 0) return; }
        if (DateTimeOffset.UtcNow >= ReadExpiry(vault.Get("twitchTokenExpiry")).AddMinutes(-5)) await RefreshTwitch(generation);
        else if (status != "Connected" && status != "Some feeds unavailable") await ValidateTwitch();
    }
    public string TwitchAccessToken => vault.Get("twitchAccessToken");
    public string TwitchClientId => vault.Get("twitchClientId").Trim() is { Length: > 0 } id ? id : DefaultTwitchClientId;
    public string TwitchUserId { get { lock (gate) return twitchUserId.Length > 0 ? twitchUserId : vault.Get("twitchUserId"); } }
    public void SetTwitchStatus(string status) { lock (gate) twitchStatus = Clean(status, 48); }
    public void SetSpotifyStatus(string status) { lock (gate) spotifyStatus = Clean(status, 48); }
    public async Task SubscribeEventSub(string sessionId) {
        long generation; lock (gate) generation = twitchGeneration;
        var user = TwitchUserId; if (user.Length == 0) return;
        var failures = 0;
        var specs = new (string type, string version, JsonObject condition)[] {
            ("channel.follow", "2", new JsonObject { ["broadcaster_user_id"] = user, ["moderator_user_id"] = user }),
            ("channel.subscribe", "1", new JsonObject { ["broadcaster_user_id"] = user }),
            ("channel.subscription.message", "1", new JsonObject { ["broadcaster_user_id"] = user }),
            ("channel.subscription.gift", "1", new JsonObject { ["broadcaster_user_id"] = user }),
            ("channel.cheer", "1", new JsonObject { ["broadcaster_user_id"] = user }),
            ("channel.raid", "1", new JsonObject { ["to_broadcaster_user_id"] = user }),
            ("channel.chat.message", "1", new JsonObject { ["broadcaster_user_id"] = user, ["user_id"] = user }),
            ("channel.chat.message_delete", "1", new JsonObject { ["broadcaster_user_id"] = user, ["user_id"] = user }),
            ("channel.chat.clear", "1", new JsonObject { ["broadcaster_user_id"] = user }),
            ("channel.chat.clear_user_messages", "1", new JsonObject { ["broadcaster_user_id"] = user, ["user_id"] = user })
        };
        foreach (var spec in specs) {
            var body = new JsonObject { ["type"] = spec.type, ["version"] = spec.version, ["condition"] = spec.condition.DeepClone(), ["transport"] = new JsonObject { ["method"] = "websocket", ["session_id"] = sessionId } };
            using var request = TwitchRequest(HttpMethod.Post, $"{TwitchApi}/eventsub/subscriptions", body);
            using var response = await http.SendAsync(request);
            if (!response.IsSuccessStatusCode) failures++;
        }
        lock (gate) { if (generation != twitchGeneration) return; twitchFeedWarning = failures > 0; twitchStatus = failures > 0 ? "Some feeds unavailable" : "Connected"; }
    }
    HttpRequestMessage TwitchRequest(HttpMethod method, string url, JsonObject? body = null) {
        var r = new HttpRequestMessage(method, url); r.Headers.Authorization = new AuthenticationHeaderValue("Bearer", TwitchAccessToken); r.Headers.Add("Client-Id", TwitchClientId);
        if (body is not null) r.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"); return r;
    }
    static DateTimeOffset ReadExpiry(string key) => long.TryParse(key, out var seconds) ? DateTimeOffset.FromUnixTimeSeconds(seconds) : DateTimeOffset.MinValue;

    public async Task PollSpotify() {
        string token; long generation; lock (gate) { generation = spotifyGeneration; token = vault.Get("spotifyAccessToken"); }
        if (token.Length == 0) { lock (gate) if (generation == spotifyGeneration && spotifyStatus != "Waiting for sign in") spotifyStatus = "Disconnected"; return; }
        if (DateTimeOffset.UtcNow >= ReadExpiry(vault.Get("spotifyTokenExpiry")).AddMinutes(-5)) {
            var refresh = vault.Get("spotifyRefreshToken"); if (refresh.Length == 0) { lock (gate) if (generation == spotifyGeneration) spotifyStatus = "Reconnect required"; return; }
            using var refreshRes = await http.PostAsync($"{SpotifyAuth}/api/token", new FormUrlEncodedContent(new Dictionary<string, string> { ["client_id"] = RequiredClientId("spotifyClientId", "Spotify"), ["grant_type"] = "refresh_token", ["refresh_token"] = refresh }));
            if (!refreshRes.IsSuccessStatusCode) { lock (gate) if (generation == spotifyGeneration) spotifyStatus = "Reconnect required"; return; }
            using var refreshDoc = JsonDocument.Parse(await refreshRes.Content.ReadAsStringAsync());
            lock (gate) { if (generation != spotifyGeneration) return; StoreSpotifyToken(refreshDoc.RootElement); token = vault.Get("spotifyAccessToken"); }
        }
        using var req = new HttpRequestMessage(HttpMethod.Get, $"{SpotifyApi}/me/player/currently-playing"); req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var response = await http.SendAsync(req);
        if (!IsSpotifyCurrent(generation)) return;
        if (response.StatusCode == HttpStatusCode.Unauthorized) { lock (gate) if (generation == spotifyGeneration) spotifyStatus = "Reconnect required"; return; }
        if (response.StatusCode == HttpStatusCode.NoContent) {
            JsonObject? paused = null;
            lock (gate) { if (generation != spotifyGeneration) return; spotifyStatus = "Connected"; if (nowPlaying is not null) { nowPlaying["isPlaying"] = false; paused = nowPlaying.DeepClone().AsObject(); } }
            if (paused is not null && IsSpotifyCurrent(generation)) await hub.Clients.All.SendAsync("nowPlaying", paused);
            return;
        }
        if (!response.IsSuccessStatusCode) { lock (gate) if (generation == spotifyGeneration) spotifyStatus = "Reconnecting"; return; }
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync()); var root = doc.RootElement;
        if (!root.TryGetProperty("item", out var item) || item.ValueKind != JsonValueKind.Object) { lock (gate) if (generation == spotifyGeneration) spotifyStatus = "Connected"; return; }
        var id = item.TryGetProperty("id", out var tid) ? tid.GetString() ?? "" : "";
        var image = item.TryGetProperty("album", out var albumObj) && albumObj.ValueKind == JsonValueKind.Object && albumObj.TryGetProperty("images", out var images) && images.ValueKind == JsonValueKind.Array && images.GetArrayLength() > 0 && images[0].TryGetProperty("url", out var artUrl) ? artUrl.GetString() : null;
        var albumName = item.TryGetProperty("album", out var albumData) && albumData.ValueKind == JsonValueKind.Object && albumData.TryGetProperty("name", out var albumTitle) ? albumTitle.GetString() : "";
        var artists = item.TryGetProperty("artists", out var arts) && arts.ValueKind == JsonValueKind.Array ? arts.EnumerateArray().Select(a => a.TryGetProperty("name", out var n) ? Clean(n.GetString(), 100) : "").Where(x => x.Length > 0).ToArray() : Array.Empty<string>();
        var safeImage = Uri.TryCreate(image, UriKind.Absolute, out var artUri) && artUri.Scheme == "https" && artUri.Host == "i.scdn.co" ? image : null;
        var next = new JsonObject { ["trackId"] = id, ["title"] = Clean(item.TryGetProperty("name", out var nm) ? nm.GetString() : "", 200), ["artists"] = JsonSerializer.SerializeToNode(artists), ["album"] = Clean(albumName, 200), ["artUrl"] = safeImage is null ? null : "/api/spotify/art?id=" + Uri.EscapeDataString(id), ["progressMs"] = root.TryGetProperty("progress_ms", out var pr) && pr.ValueKind == JsonValueKind.Number ? pr.GetInt32() : 0, ["durationMs"] = item.TryGetProperty("duration_ms", out var du) ? du.GetInt32() : 0, ["isPlaying"] = root.TryGetProperty("is_playing", out var playing) && playing.GetBoolean() };
        lock (gate) { if (generation != spotifyGeneration) return; spotifyStatus = "Connected"; nowPlaying = next.DeepClone().AsObject(); lastSpotifyTrack = id; spotifyArtUrl = safeImage ?? ""; }
        if (IsSpotifyCurrent(generation)) await hub.Clients.All.SendAsync("nowPlaying", next);
    }
    bool IsSpotifyCurrent(long generation) { lock (gate) return generation == spotifyGeneration; }
    public async Task<(byte[] Bytes, string ContentType)?> GetArt(string id) {
        var current = NowPlaying; string target;
        lock (gate) target = current?["trackId"]?.GetValue<string>() == id ? spotifyArtUrl : "";
        if (!Uri.TryCreate(target, UriKind.Absolute, out var uri) || uri.Scheme != "https" || uri.Host != "i.scdn.co") return null;
        using var res = await http.GetAsync(uri); if (!res.IsSuccessStatusCode || res.Content.Headers.ContentLength is > 5_000_000) return null;
        var bytes = await res.Content.ReadAsByteArrayAsync();
        var type = res.Content.Headers.ContentType?.MediaType;
        if (bytes.Length > 5_000_000 || type is not ("image/jpeg" or "image/png" or "image/webp")) return null;
        return (bytes, type);
    }

    public async Task<JsonObject[]> SearchCategories(string query) {
        query = Clean(query, 100).Trim(); if (query.Length < 2 || TwitchAccessToken.Length == 0 || TwitchClientId.Length == 0) return Array.Empty<JsonObject>();
        using var req = TwitchRequest($"{TwitchApi}/search/categories?query={Uri.EscapeDataString(query)}&first=20");
        using var res = await http.SendAsync(req); if (!res.IsSuccessStatusCode) return Array.Empty<JsonObject>();
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
        return doc.RootElement.GetProperty("data").EnumerateArray().Select(x => new JsonObject { ["id"] = x.GetProperty("id").GetString(), ["name"] = Clean(x.GetProperty("name").GetString(), 100), ["boxArtUrl"] = x.TryGetProperty("box_art_url", out var art) ? art.GetString() : "" }).ToArray();
    }
    HttpRequestMessage TwitchRequest(string url) => TwitchRequest(HttpMethod.Get, url);

    public async Task PollCategory() {
        var user = TwitchUserId; if (user.Length == 0 || !TwitchConnected) return;
        using var req = TwitchRequest($"{TwitchApi}/channels?broadcaster_id={Uri.EscapeDataString(user)}"); using var res = await http.SendAsync(req); if (!res.IsSuccessStatusCode) return;
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync()); var row = doc.RootElement.GetProperty("data").EnumerateArray().FirstOrDefault();
        if (row.ValueKind != JsonValueKind.Object) return;
        var next = new JsonObject { ["id"] = row.GetProperty("game_id").GetString(), ["name"] = Clean(row.GetProperty("game_name").GetString(), 100), ["title"] = Clean(row.GetProperty("title").GetString(), 140) };
        lock (gate) category = next;
    }

    public async Task PublishAlert(string kind, string name, int amount, string message, bool test = false) => await PublishAlert(kind, name, amount, message, "", test);
    public async Task PublishAlert(string kind, string name, int amount, string message, string eventId, bool test = false) {
        kind = kind.ToLowerInvariant(); if (!new[] { "follow", "sub", "resub", "gift", "bits", "raid" }.Contains(kind)) return;
        name = Clean(name, 25).Trim(); if (name.Length == 0) name = "Viewer";
        if (!test && eventId.Length > 0 && !RememberEvent(eventId)) return;
        var alert = new JsonObject { ["id"] = eventId.Length > 0 ? Clean(eventId, 64) : Guid.NewGuid().ToString("N"), ["kind"] = kind, ["name"] = name, ["amount"] = Math.Clamp(amount, 0, 1_000_000), ["message"] = Clean(message, 200), ["test"] = test };
        await hub.Clients.All.SendAsync("twitchEvent", alert);
        if (!test) await IncrementGoals(kind, kind is "bits" or "gift" ? Math.Max(1, amount) : 1);
    }

    public async Task AddChat(JsonObject line) {
        var id = line["id"]?.GetValue<string>() ?? ""; if (id.Length == 0) return;
        lock (gate) {
            if (!chatIds.Add(id)) return; chatIdOrder.Enqueue(id); chat.Enqueue(line.DeepClone().AsObject());
            while (chat.Count > 30) chat.Dequeue(); while (chatIdOrder.Count > 2000) chatIds.Remove(chatIdOrder.Dequeue());
        }
        await hub.Clients.All.SendAsync("chat", line);
    }
    public async Task ClearChat(string? id = null, string? user = null, bool all = false) {
        lock (gate) {
            if (all) { chat.Clear(); chatIds.Clear(); chatIdOrder.Clear(); }
            else {
                var kept = chat.Where(line => id is not null ? line["id"]?.GetValue<string>() != id : !string.Equals(line["user"]?.GetValue<string>(), user, StringComparison.OrdinalIgnoreCase)).ToArray();
                chat.Clear(); foreach (var line in kept) chat.Enqueue(line);
                if (id is not null) chatIds.Remove(id);
            }
        }
        await hub.Clients.All.SendAsync("chatClear", new { id, user, all });
    }
    bool RememberEvent(string id) { lock (gate) { if (seenEvents.Contains(id)) return false; seenEvents.Add(id); eventIds.Enqueue(id); while (eventIds.Count > 5000) seenEvents.Remove(eventIds.Dequeue()); return true; } }

    public async Task IncrementGoals(string kind, int amount) {
        var doc = state.Document; var changed = new List<(string id, long current)>();
        lock (gate) {
            foreach (var element in GoalElements(doc)) {
                var p = element.props; var targetKind = p["kind"]?.GetValue<string>() ?? "follows"; var started = p["startedAt"]?.GetValue<string>() ?? "";
                if (!MatchesGoal(targetKind, kind)) continue;
                if (!goalResets.TryGetValue(element.id, out var prior) || prior != started) { goals[element.id] = 0; goalResets[element.id] = started; }
                goals[element.id] = Math.Min(1_000_000_000, goals.GetValueOrDefault(element.id) + amount); changed.Add((element.id, goals[element.id]));
            }
            PersistGoals();
        }
        foreach (var g in changed) await hub.Clients.All.SendAsync("goal", new { id = g.id, current = g.current });
    }
    public async Task SendGoals(IClientProxy client) {
        ReconcileGoals();
        foreach (var g in CurrentGoals()) await client.SendAsync("goal", new { id = g.Key, current = g.Value });
    }
    public void ReconcileGoals() {
        lock (gate) {
            foreach (var el in GoalElements(state.Document)) {
                var started = el.props["startedAt"]?.GetValue<string>() ?? "";
                if (!goalResets.TryGetValue(el.id, out var old) || old != started) { goalResets[el.id] = started; goals[el.id] = 0; }
            }
            var existing = GoalElements(state.Document).Select(x => x.id).ToHashSet(StringComparer.Ordinal);
            foreach (var key in goals.Keys.Where(k => !existing.Contains(k)).ToArray()) { goals.Remove(key); goalResets.Remove(key); }
            PersistGoals();
        }
    }
    KeyValuePair<string, long>[] CurrentGoals() { lock (gate) return goals.ToArray(); }
    sealed record GoalElement(string id, JsonObject props);
    static IEnumerable<GoalElement> GoalElements(JsonObject doc) => doc["scenes"]?.AsArray().SelectMany(s => s?["elements"]?.AsArray() ?? new JsonArray()).Where(e => e?["type"]?.GetValue<string>() == "goal" && e?["props"] is JsonObject).Select(e => new GoalElement(e!["id"]!.GetValue<string>(), e["props"]!.AsObject())) ?? Array.Empty<GoalElement>();
    static bool MatchesGoal(string goal, string alert) => goal == "follows" && alert == "follow" || goal == "subs" && alert is "sub" or "resub" or "gift" || goal == "bits" && alert == "bits";
    void LoadGoals() {
        if (!File.Exists(goalFile)) return;
        try { var root = JsonNode.Parse(File.ReadAllText(goalFile))?.AsObject(); if (root is null) return; foreach (var pair in root) if (pair.Value is JsonObject obj && long.TryParse(obj["current"]?.ToString(), out var current)) { goals[pair.Key] = Math.Clamp(current, 0, 1_000_000_000); goalResets[pair.Key] = obj["startedAt"]?.GetValue<string>() ?? ""; } } catch { }
    }
    void PersistGoals() {
        var root = new JsonObject(); foreach (var pair in goals) root[pair.Key] = new JsonObject { ["current"] = pair.Value, ["startedAt"] = goalResets.GetValueOrDefault(pair.Key, "") };
        OverlayState.AtomicWrite(goalFile, root.ToJsonString());
    }
    public void SetCategory(JsonObject value) { lock (gate) category = value.DeepClone().AsObject(); }
    public async Task<bool> CheckCompanionAsync() {
        try {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            using var res = await http.GetAsync("http://127.0.0.1:5051/api/license", timeout.Token);
            companionOnline = res.IsSuccessStatusCode;
            lock (gate) companionStatus = companionOnline ? "Connected" : vault.Get("license").Length == 0 ? "Not connected" : "Offline";
        } catch {
            companionOnline = false;
            lock (gate) companionStatus = vault.Get("license").Length == 0 ? "Not connected" : "Offline";
        }
        return companionOnline;
    }
    public object CardConfig() {
        var doc = state.Document; var el = doc["scenes"]?.AsArray().SelectMany(s => s?["elements"]?.AsArray() ?? new JsonArray()).FirstOrDefault(e => e?["type"]?.GetValue<string>() == "spotify");
        var rect = el?["rect"] as JsonObject; var p = el?["props"] as JsonObject;
          return new { enabled = p?["enabled"]?.GetValue<bool>() ?? true, x = Number(rect?["x"], 1391)/1920, y = Number(rect?["y"], 24)/1080, w = Number(rect?["w"], 505)/1920, h = Number(rect?["h"], 109)/1080, style = p?["style"]?.GetValue<string>() ?? "pill", accent = p?["accent"]?.GetValue<string>(), backdrop = p?["backdrop"]?.GetValue<string>() ?? "art", opacity = Number(p?["opacity"], 1), visualizer = p?["visualizer"]?.GetValue<string>() ?? "auto", coverSheen = p?["coverSheen"]?.GetValue<bool>() ?? true };
    }
    static double Number(JsonNode? n, double fallback) => double.TryParse(n?.ToJsonString(),System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out var number) && double.IsFinite(number) ? number : fallback;
    static string Clean(string? s, int max) => new((s ?? "").Where(c => !char.IsControl(c)).Take(max).ToArray());
}
