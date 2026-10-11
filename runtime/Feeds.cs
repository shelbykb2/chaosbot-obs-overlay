using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.SignalR;

namespace Overlay;

/// <summary>Polls provider state, consumes Twitch EventSub, and mirrors external scene edits.</summary>
public sealed class Feeds(OverlayState state, Connections connections, IHubContext<OverlayHub> hub,
    IConfiguration configuration, IHostApplicationLifetime lifetime, ILogger<Feeds> logger) : BackgroundService {
    readonly int parentPid = int.TryParse(configuration["parent"], out var pid) ? pid : 0;
    DateTimeOffset nextTwitchValidation = DateTimeOffset.MinValue, nextCategory = DateTimeOffset.MinValue, nextCompanion = DateTimeOffset.MinValue;
    string lastForeground = "";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken) {
        var twitchTask = TwitchLoop(stoppingToken);
        var spotifyTask = SpotifyLoop(stoppingToken);
        try {
            while (!stoppingToken.IsCancellationRequested) {
                if (parentPid > 0 && !ParentAlive()) { lifetime.StopApplication(); return; }
                var imported=state.ImportLegacyCompanion(configuration["companion-site"]);
                if (state.ReadExternal() || imported) {
                    var document = state.Document;
                    connections.ReconcileGoals();
                    connections.ImportExternalScene?.Invoke(document.DeepClone().AsObject());
                    connections.NotifySceneChangedExternally(document.DeepClone().AsObject());
                    await hub.Clients.All.SendAsync("scene", state.Wire(), stoppingToken);
                    await hub.Clients.All.SendAsync("spotifyConfig", connections.CardConfig(), stoppingToken);
                    await connections.SendGoals(hub.Clients.All);
                }
                await SwitchForFocusedGame(stoppingToken);
                if (DateTimeOffset.UtcNow >= nextCompanion) { nextCompanion = DateTimeOffset.UtcNow.AddSeconds(15); await connections.CheckCompanionAsync(); }
                await Task.Delay(500, stoppingToken);
            }
        } catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        finally { try { await Task.WhenAll(twitchTask, spotifyTask); } catch (OperationCanceledException) { } }
    }

    bool ParentAlive() { try { using var p = Process.GetProcessById(parentPid); return !p.HasExited; } catch { return false; } }

    async Task TwitchLoop(CancellationToken ct) {
        var wsTask = Task.CompletedTask;
        while (!ct.IsCancellationRequested) {
            try {
                await connections.PollTwitchAuthorization();
                if (DateTimeOffset.UtcNow >= nextTwitchValidation) { nextTwitchValidation = DateTimeOffset.UtcNow.AddMinutes(45); await connections.EnsureTwitchValid(); }
                if (DateTimeOffset.UtcNow >= nextCategory) { nextCategory = DateTimeOffset.UtcNow.AddSeconds(45); await connections.PollCategory(); }
                if (connections.TwitchConnected && wsTask.IsCompleted) wsTask = EventSubLoop(ct);
                if (!connections.TwitchConnected && !wsTask.IsCompleted) { /* EventSub observes the disconnect and exits on its next receive timeout. */ }
            } catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception ex) { logger.LogDebug("Twitch feed cycle failed: {Reason}", SafeReason(ex)); if (connections.TwitchAccessToken.Length > 0) connections.SetTwitchStatus("Reconnecting"); }
            try { await Task.Delay(500, ct); } catch (OperationCanceledException) { break; }
        }
        try { await wsTask; } catch (OperationCanceledException) { }
    }

    async Task SpotifyLoop(CancellationToken ct) {
        while (!ct.IsCancellationRequested) {
            try { await connections.PollSpotify(); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception ex) { logger.LogDebug("Spotify poll failed: {Reason}", SafeReason(ex)); connections.SetSpotifyStatus("Reconnecting"); }
            try { await Task.Delay(1500, ct); } catch (OperationCanceledException) { break; }
        }
    }

    async Task EventSubLoop(CancellationToken ct) {
        var attempt = 0;
        var endpoint = new Uri("wss://eventsub.wss.twitch.tv/ws");
        var isMigration = false;
        while (!ct.IsCancellationRequested && connections.TwitchConnected) {
            try {
                using var socket = new ClientWebSocket();
                socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
                await socket.ConnectAsync(endpoint, ct);
                var reconnect = await ReceiveSession(socket, isMigration, () => attempt = 0, ct);
                isMigration = reconnect is not null;
                endpoint = reconnect is null ? new Uri("wss://eventsub.wss.twitch.tv/ws") : CheckedReconnect(reconnect);
            } catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception ex) { logger.LogDebug("Twitch EventSub reconnecting: {Reason}", SafeReason(ex)); connections.SetTwitchStatus("Reconnecting"); isMigration = false; endpoint = new Uri("wss://eventsub.wss.twitch.tv/ws"); }
            attempt++;
            var delay = TimeSpan.FromSeconds(Math.Min(60, Math.Pow(2, Math.Min(attempt, 6))));
            try { await Task.Delay(delay, ct); } catch (OperationCanceledException) { break; }
        }
    }

    async Task<string?> ReceiveSession(ClientWebSocket socket, bool isMigration, Action welcomed, CancellationToken ct) {
        using var buffer = new MemoryStream(); var timeoutSeconds = 15;
        while (!ct.IsCancellationRequested && socket.State == WebSocketState.Open && connections.TwitchConnected) {
            using var receiveCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            receiveCts.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds + 8));
            var frame = new byte[8192];
            ValueWebSocketReceiveResult part;
            try { part = await socket.ReceiveAsync(frame.AsMemory(), receiveCts.Token); }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw new TimeoutException("Twitch EventSub keepalive timed out."); }
            if (part.MessageType == WebSocketMessageType.Close) throw new IOException("Twitch EventSub closed the connection.");
            buffer.Write(frame, 0, part.Count);
            if (buffer.Length > 1024 * 1024) throw new InvalidDataException("Twitch sent an oversized EventSub message.");
            if (part.EndOfMessage) {
                var bytes = buffer.ToArray();
                buffer.SetLength(0);
                try {
                    using var envelope = JsonDocument.Parse(bytes);
                    if (envelope.RootElement.TryGetProperty("metadata", out var md) && md.TryGetProperty("message_type", out var mt) && mt.GetString() == "session_welcome" &&
                        envelope.RootElement.TryGetProperty("payload", out var pl) && pl.TryGetProperty("session", out var session) && session.TryGetProperty("keepalive_timeout_seconds", out var ka) && ka.TryGetInt32(out var seconds))
                        timeoutSeconds = Math.Clamp(seconds, 5, 120);
                } catch (JsonException) { }
                var reconnect = await ProcessEventSub(bytes, isMigration, welcomed, ct);
                if (reconnect is { Length: > 0 }) return reconnect;
                timeoutSeconds = 15;
            }
        }
        return null;
    }

    async Task<string?> ProcessEventSub(byte[] message, bool isMigration, Action welcomed, CancellationToken ct) {
        using var doc = JsonDocument.Parse(message); var root = doc.RootElement;
        if (!root.TryGetProperty("metadata", out var meta) || !root.TryGetProperty("payload", out var payload)) return null;
        var type = meta.TryGetProperty("message_type", out var mt) ? mt.GetString() : "";
        if (type == "session_welcome") {
            welcomed();
            var session = payload.GetProperty("session").GetProperty("id").GetString();
            if (!isMigration && !string.IsNullOrWhiteSpace(session)) await connections.SubscribeEventSub(session);
            return null;
        }
        if (type == "session_keepalive") return null;
        if (type == "session_reconnect") return payload.GetProperty("session").GetProperty("reconnect_url").GetString();
        if (type == "revocation") {
            var reason = payload.TryGetProperty("subscription", out var revoked) && revoked.TryGetProperty("status", out var status) ? status.GetString() : "";
            if (reason is "authorization_revoked" or "user_removed") await connections.Disconnect("twitch");
            else connections.SetTwitchStatus("Some feeds unavailable");
            return null;
        }
        if (type != "notification" || !payload.TryGetProperty("subscription", out var subscription) || !payload.TryGetProperty("event", out var ev)) return null;
        var eventType = subscription.TryGetProperty("type", out var et) ? et.GetString() : "";
        var eventId = meta.TryGetProperty("message_id", out var notificationId) ? notificationId.GetString() ?? "" :
            ev.TryGetProperty("id", out var eventIdProp) ? eventIdProp.GetString() ?? "" : "";
        string S(string key) => ev.TryGetProperty(key, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() ?? "" : "";
        int N(string key) => ev.TryGetProperty(key, out var p) && p.TryGetInt32(out var n) ? Math.Clamp(n, 0, 1_000_000) : 0;
        switch (eventType) {
            case "channel.follow":
                await connections.PublishAlert("follow", S("user_name"), 0, "", eventId); break;
            case "channel.subscribe":
                if(ev.TryGetProperty("is_gift",out var gifted) && gifted.ValueKind==JsonValueKind.True) break;
                await connections.PublishAlert("sub", S("user_name"), 1, "", eventId); break;
            case "channel.subscription.message":
                var months = N("cumulative_months");
                if(months<=1) break;
                var subMessage = ev.TryGetProperty("message", out var msg) && msg.TryGetProperty("text", out var text) ? text.GetString() ?? "" : "";
                await connections.PublishAlert(months > 1 ? "resub" : "sub", S("user_name"), months, subMessage, eventId); break;
            case "channel.subscription.gift":
                await connections.PublishAlert("gift", S("user_name"), Math.Max(1, N("total")), "", eventId); break;
            case "channel.cheer":
                await connections.PublishAlert("bits", S("user_name") is { Length: > 0 } cheerName ? cheerName : "Anonymous", N("bits"), S("message"), eventId); break;
            case "channel.raid":
                await connections.PublishAlert("raid", S("from_broadcaster_user_name"), N("viewers"), "", eventId); break;
            case "channel.chat.message":
                await connections.AddChat(ReadChatLine(ev)); break;
            case "channel.chat.message_delete":
                await connections.ClearChat(S("message_id")); break;
            case "channel.chat.clear_user_messages":
                await connections.ClearChat(user: S("user_login")); break;
            case "channel.chat.clear":
                await connections.ClearChat(all: true); break;
        }
        return null;
    }

    static JsonObject ReadChatLine(JsonElement ev) {
        var message = ev.TryGetProperty("message", out var m) ? m : default;
        var text = message.ValueKind == JsonValueKind.Object && message.TryGetProperty("text", out var tx) ? tx.GetString() ?? "" : "";
        var login = ev.TryGetProperty("chatter_user_login", out var u) ? u.GetString() ?? "" : "";
        var display = ev.TryGetProperty("chatter_user_name", out var name) ? name.GetString() ?? login : login;
        var color = ev.TryGetProperty("color", out var c) ? c.GetString() ?? "" : "";
        var badges = new JsonArray();
        if (ev.TryGetProperty("badges", out var badgeList) && badgeList.ValueKind == JsonValueKind.Array) foreach (var b in badgeList.EnumerateArray()) {
            var set = b.TryGetProperty("set_id", out var s) ? s.GetString() : "";
            var mapped = set switch { "broadcaster" => "broadcaster", "moderator" => "moderator", "vip" => "vip", "subscriber" => "subscriber", "partner" => "partner", _ => null };
            if (mapped is not null && !badges.Any(x => x?.GetValue<string>() == mapped)) badges.Add(mapped);
        }
        var emotes = new JsonArray();
        if (message.ValueKind == JsonValueKind.Object && message.TryGetProperty("fragments", out var fragments) && fragments.ValueKind == JsonValueKind.Array) {
            var cursor = 0;
            foreach (var fragment in fragments.EnumerateArray()) {
                var part = fragment.TryGetProperty("text", out var pt) ? pt.GetString() ?? "" : "";
                if (fragment.TryGetProperty("type", out var ft) && ft.GetString() == "emote" && fragment.TryGetProperty("emote", out var emote) && emote.TryGetProperty("id", out var eid))
                    emotes.Add(new JsonObject { ["id"] = eid.GetString(), ["start"] = cursor, ["end"] = cursor + Math.Max(0, part.Length - 1) });
                cursor += part.Length;
            }
        }
        var action = message.ValueKind == JsonValueKind.Object && message.TryGetProperty("message_type", out var type) && type.GetString() == "ACTION";
        var id = ev.TryGetProperty("message_id", out var msgId) ? msgId.GetString() ?? Guid.NewGuid().ToString("N") : Guid.NewGuid().ToString("N");
        var safeColor = System.Text.RegularExpressions.Regex.IsMatch(color, "^#[0-9a-fA-F]{6}$") ? color : "";
        return new JsonObject { ["id"] = id, ["user"] = login.ToLowerInvariant(), ["name"] = display, ["color"] = safeColor, ["badges"] = badges, ["text"] = text, ["emotes"] = emotes, ["action"] = action };
    }

    static Uri CheckedReconnect(string url) {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != "wss" ||
            !(uri.Host.Equals("eventsub.wss.twitch.tv", StringComparison.OrdinalIgnoreCase) || uri.Host.EndsWith(".eventsub.wss.twitch.tv", StringComparison.OrdinalIgnoreCase)))
            throw new InvalidDataException("Twitch provided an invalid reconnect address.");
        return uri;
    }

    async Task SwitchForFocusedGame(CancellationToken ct) {
        var game = WindowGames.Focused() ?? ""; lastForeground = game;
        var doc = state.Document; var scenes = doc["scenes"]!.AsArray(); var category = connections.Category;
        var selected = scenes.FirstOrDefault(scene => scene?["showFor"] is JsonArray triggers && triggers.Any(t => {
            var kind = t?["kind"]?.GetValue<string>(); var value = t?["value"]?.GetValue<string>() ?? "";
            return kind == "game" && value.Equals(game, StringComparison.OrdinalIgnoreCase) || kind == "category" &&
                (value.Equals(category?["id"]?.ToString(), StringComparison.OrdinalIgnoreCase) || value.Equals(category?["name"]?.ToString(), StringComparison.OrdinalIgnoreCase));
        }));
        var id = selected?["id"]?.GetValue<string>() ?? doc["activeSceneId"]?.GetValue<string>() ?? "";
        if (id.Length == 0 || id == doc["activeSceneId"]?.GetValue<string>()) return;
        try { state.MakeLive(id); await hub.Clients.All.SendAsync("scene", state.Wire(), ct); }
        catch (InvalidDataException) { }
    }

    static string SafeReason(Exception ex) => ex is HttpRequestException or WebSocketException or TimeoutException ? ex.GetType().Name : "Provider request failed";
}
