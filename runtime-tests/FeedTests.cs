// Dependency-free integration checks for the live feed contracts. A host test runner can call
// FeedTests.RunAsync(); all provider traffic is captured by the in-memory HTTP handler below.
using System.Collections.Concurrent;
using System.Net;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.SignalR;
using Overlay;

namespace Overlay.RuntimeTests;

public static class FeedTests {
    public static async Task RunAsync() {
        var root = Path.Combine(Path.GetTempPath(), "overlay-feed-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try {
            var site = Path.Combine(root, "site"); var state = new OverlayState(site);
            state.Save(JsonNode.Parse("""{"schemaVersion":1,"activeSceneId":"scene","scenes":[{"id":"scene","name":"Scene","showFor":[],"elements":[{"id":"subs-goal","name":"Subs","type":"goal","rect":{"x":0,"y":0,"w":300,"h":60},"props":{"kind":"subs","startedAt":"start-a"}}]}]}""")!.AsObject());
            var vault = new Vault(Path.Combine(root, "credentials.dat"));
            var capture = new CapturingHubContext(); var handler = new FakeHttpHandler(); using var http = new HttpClient(handler);
            var connections = new Connections(state, vault, http, capture);

            await connections.SaveSettings(new JsonObject { ["aiProvider"] = "openai", ["apiKey"] = "test-api-secret", ["model"] = "test-model", ["spotifyClientId"] = "spotify-public", ["twitchClientId"] = "twitch-public" });
            var safeSettings = JsonSerializer.SerializeToNode(connections.Settings())!;
            Require(safeSettings["apiKey"]?.GetValue<string>() != "test-api-secret" && safeSettings["hasApiKey"]?.GetValue<bool>() == true, "Settings reports key presence without returning the API key.");

            handler.Respond = request => request.RequestUri?.AbsolutePath switch {
                "/api/token" => Json(HttpStatusCode.OK, """{"access_token":"spotify-access","refresh_token":"spotify-refresh","expires_in":3600}"""),
                "/v1/me/player/currently-playing" => new HttpResponseMessage(HttpStatusCode.NoContent),
                _ => throw new InvalidOperationException("Unexpected fake Spotify HTTP request.")
            };
            SetField(connections, "spotifyState", "callback-state-once-123"); SetField(connections, "spotifyVerifier", "pkce-verifier");
            SetField(connections, "spotifyStateExpires", DateTimeOffset.UtcNow.AddMinutes(5));
            await connections.SpotifyCallback("callback-state-once-123", "authorization-code");
            try { await connections.SpotifyCallback("callback-state-once-123", "authorization-code"); throw new InvalidOperationException("A replayed Spotify callback was accepted."); }
            catch (InvalidDataException) { }
            Require(handler.Count("/api/token") == 1, "Spotify callback state is consumed once and rejected on replay.");
            SetField(connections, "spotifyState", "callback-state-expired-123"); SetField(connections, "spotifyVerifier", "pkce-verifier");
            SetField(connections, "spotifyStateExpires", DateTimeOffset.UtcNow.AddSeconds(-1));
            try { await connections.SpotifyCallback("callback-state-expired-123", "authorization-code"); throw new InvalidOperationException("An expired Spotify callback was accepted."); }
            catch (InvalidDataException) { }
            Require(handler.Count("/api/token") == 1, "An expired Spotify callback does not exchange its code.");

            await connections.PublishAlert("gift", "gifter", 3, "", "notification-1");
            await connections.PublishAlert("gift", "gifter", 3, "", "notification-1");
            await connections.PublishAlert("sub", "subscriber", 1, "", "notification-2", test: true);
            var replay = new CapturingClientProxy(); await connections.SendGoals(replay);
            Require(GoalCurrent(replay) == 3, "A repeated gift only increments the goal once, and test alerts never count.");

            await connections.AddChat(new JsonObject { ["id"] = "chat-1", ["user"] = "viewer", ["name"] = "Viewer", ["text"] = "hello", ["badges"] = new JsonArray(), ["emotes"] = new JsonArray() });
            Require(connections.ChatHistory.Length == 1, "Incoming chat is retained for replay.");
            await connections.ClearChat(id: "chat-1");
            Require(connections.ChatHistory.Length == 0, "A deleted message is removed from retained chat history.");

            var changed = state.Document; changed["scenes"]![0]!["elements"]![0]!["props"]!["startedAt"] = "start-b"; state.Save(changed); connections.ReconcileGoals();
            var reset = new CapturingClientProxy(); await connections.SendGoals(reset);
            Require(GoalCurrent(reset) == 0, "Changing startedAt resets a persisted goal counter.");

            connections.SetTwitchStatus("Reconnecting");
            var status = JsonSerializer.SerializeToNode(connections.PublicStatus())!;
            Require(status["twitch"]?["status"]?.GetValue<string>() == "Reconnecting", "Provider reconnect state is reported without exposing credentials.");
            Require(status["companion"]?.GetValue<bool>() == false, "The companion flag is false until its local API responds.");

            handler.Respond = request => {
                if (request.RequestUri?.AbsolutePath == "/oauth2/token") return Json(HttpStatusCode.OK, """{"access_token":"fresh-access","refresh_token":"fresh-refresh","expires_in":3600,"scope":["user:read:chat"]}""");
                if (request.RequestUri?.AbsolutePath == "/oauth2/validate") {
                    Require(request.Headers.Authorization?.Parameter == "fresh-access", "Token validation uses the refreshed access token.");
                    return Json(HttpStatusCode.OK, """{"user_id":"42","login":"channel"}""");
                }
                throw new InvalidOperationException("Unexpected fake HTTP request.");
            };
            vault.SetMany(new() { ["twitchClientId"] = "public-client", ["twitchAccessToken"] = "expired-access", ["twitchRefreshToken"] = "old-refresh", ["twitchTokenExpiry"] = DateTimeOffset.UtcNow.AddMinutes(-10).ToUnixTimeSeconds().ToString() });
            await connections.EnsureTwitchValid();
            Require(handler.Count("/oauth2/token") == 1 && handler.Count("/oauth2/validate") == 1, "Expired Twitch tokens refresh once before validation.");
            Require(connections.TwitchConnected, "A validated refreshed token reconnects Twitch.");
        } finally { try { Directory.Delete(root, true); } catch { } }
    }

    static long GoalCurrent(CapturingClientProxy proxy) {
        var msg = proxy.Messages.LastOrDefault(x => x.Method == "goal");
        return msg is null ? -1 : ((JsonObject)JsonSerializer.SerializeToNode(msg.Args[0])!)["current"]!.GetValue<long>();
    }
    static HttpResponseMessage Json(HttpStatusCode status, string body) => new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
    static void Require(bool value, string reason) { if (!value) throw new InvalidOperationException("Feed test failed: " + reason); }
    static void SetField<T>(Connections target, string name, T value) => typeof(Connections).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(target, value);

    sealed class FakeHttpHandler : HttpMessageHandler {
        readonly ConcurrentDictionary<string, int> counts = new();
        public Func<HttpRequestMessage, HttpResponseMessage> Respond { get; set; } = _ => throw new InvalidOperationException("No fake response configured.");
        public int Count(string path) => counts.GetValueOrDefault(path);
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) {
            var path = request.RequestUri?.AbsolutePath ?? ""; counts.AddOrUpdate(path, 1, (_, n) => n + 1);
            return Task.FromResult(Respond(request));
        }
    }

    sealed record Sent(string Method, object?[] Args);
    sealed class CapturingClientProxy : IClientProxy {
        public List<Sent> Messages { get; } = [];
        public Task SendCoreAsync(string method, object?[] args, CancellationToken cancellationToken = default) { Messages.Add(new(method, args)); return Task.CompletedTask; }
    }
    sealed class CapturingHubContext : IHubContext<OverlayHub> {
        readonly CapturingClientProxy all = new(); readonly HubClients clients;
        public CapturingHubContext() => clients = new HubClients(all);
        public IHubClients Clients => clients;
        public IGroupManager Groups { get; } = new GroupManager();
    }
    sealed class HubClients(CapturingClientProxy proxy) : IHubClients {
        public IClientProxy All => proxy;
        public IClientProxy AllExcept(IReadOnlyList<string> excludedConnectionIds) => proxy;
        public IClientProxy Client(string connectionId) => proxy;
        public IClientProxy Clients(IReadOnlyList<string> connectionIds) => proxy;
        public IClientProxy Group(string groupName) => proxy;
        public IClientProxy GroupExcept(string groupName, IReadOnlyList<string> excludedConnectionIds) => proxy;
        public IClientProxy Groups(IReadOnlyList<string> groupNames) => proxy;
        public IClientProxy User(string userId) => proxy;
        public IClientProxy Users(IReadOnlyList<string> userIds) => proxy;
    }
    sealed class GroupManager : IGroupManager {
        public Task AddToGroupAsync(string connectionId, string groupName, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task RemoveFromGroupAsync(string connectionId, string groupName, CancellationToken cancellationToken = default) => Task.CompletedTask;
    }
}
