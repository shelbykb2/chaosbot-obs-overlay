using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.SignalR;
using Overlay;

using var runningMutex = new Mutex(false, "ChaosBotOBSOverlayRunning");
var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders(); // Never log OAuth callback URLs or editor credentials.
var site = Path.GetFullPath(builder.Configuration["site"] ?? Path.Combine(AppContext.BaseDirectory, "site"));
var token = builder.Configuration["token"] ?? throw new InvalidOperationException("An editor token is required.");
if (token.Length < 32) throw new InvalidOperationException("The editor token is too short.");
var port = int.Parse(builder.Configuration["port"] ?? "5261");
builder.WebHost.UseUrls($"http://127.0.0.1:{port}");
builder.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = 12 * 1024 * 1024);
builder.Services.AddSignalR(o => o.MaximumReceiveMessageSize = 256 * 1024);
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.WithOrigins("http://127.0.0.1:5260", "http://localhost:5260")
    .AllowAnyHeader().AllowAnyMethod().AllowCredentials()));
builder.Services.AddSingleton(new OverlayState(site));
builder.Services.AddSingleton(new Vault(Path.Combine(Path.GetDirectoryName(site)!, "credentials.dat")));
builder.Services.AddSingleton(new HttpClient(new SocketsHttpHandler { UseProxy = false, AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(65) });
builder.Services.AddSingleton<Connections>();
builder.Services.AddSingleton<Designer>();
builder.Services.AddSingleton<AudioSpectrum>();
builder.Services.AddHostedService(p => p.GetRequiredService<AudioSpectrum>());
builder.Services.AddHostedService<Feeds>();
var app = builder.Build();
app.Use(async (ctx, next) => {
    if (!IPAddress.TryParse(ctx.Connection.RemoteIpAddress?.ToString(), out var remote) || !IPAddress.IsLoopback(remote)
        || ctx.Request.Host.Host is not ("127.0.0.1" or "localhost") || ctx.Request.Host.Port != port) {
        ctx.Response.StatusCode = 421; return;
    }
    ctx.Response.Headers.CacheControl = "no-store";
    ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";
    ctx.Response.Headers["Referrer-Policy"] = "no-referrer";
    ctx.Response.Headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://i.scdn.co https://static-cdn.jtvnw.net https://cdn.jsdelivr.net http://127.0.0.1:5260; media-src 'self' data: http://127.0.0.1:5260; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:5260; frame-src 'self' http://127.0.0.1:5260; object-src 'none'; base-uri 'self'";
    if(ctx.Request.Path.StartsWithSegments("/api/internal") && !SecureEquals(ctx.Request.Headers.Authorization.ToString(), "Bearer "+token)) {ctx.Response.StatusCode=401;return;}
    if (ctx.Request.Path.StartsWithSegments("/editor") || ctx.Request.Path.StartsWithSegments("/api/private")) {
        var provided = ctx.Request.Cookies["overlay-editor"] ?? "";
        if (ctx.Request.Path == "/editor/" && ctx.Request.Query.TryGetValue("token", out var supplied) && SecureEquals(supplied.ToString(), token)) {
            ctx.Response.Cookies.Append("overlay-editor", token, new CookieOptions { HttpOnly = true, SameSite = SameSiteMode.Strict, Path = "/", IsEssential = true });
            ctx.Response.Redirect("/editor/"); return;
        }
        if (!SecureEquals(provided, token)) { ctx.Response.StatusCode = 401; return; }
        if (ctx.Request.Method != "GET" && ctx.Request.Headers.Origin != $"http://127.0.0.1:{port}") { ctx.Response.StatusCode = 403; return; }
    }
    try { await next(); }
    catch (Exception ex) when (ex is ArgumentException or InvalidDataException or FormatException) {
        if (!ctx.Response.HasStarted) { ctx.Response.StatusCode = 400; await ctx.Response.WriteAsJsonAsync(new { error = ex.Message }); }
    }
    catch { if (!ctx.Response.HasStarted) { ctx.Response.StatusCode = 503; await ctx.Response.WriteAsJsonAsync(new { error = "That operation could not finish. Check Connections and try again." }); } }
});
app.UseCors();
app.MapGet("/health", () => new { ok = true, standalone = true, version = "1.1.0" });
app.MapGet("/api/internal/scenes", (OverlayState s)=>{s.UseModernSync();return Results.Json(s.Snapshot());});
app.MapPut("/api/internal/scenes",async (JsonObject b,OverlayState s,Connections c,IHubContext<OverlayHub> hub)=>{
    var doc=b["doc"] as JsonObject ?? throw new InvalidDataException("No layout was supplied.");
    var revision=b["baseRevision"]?.GetValue<string>() ?? "";
    if(!s.SaveIfRevision(revision,doc))return Results.Json(s.Snapshot(),statusCode:409);
    c.ReconcileGoals();await c.SendGoals(hub.Clients.All);await hub.Clients.All.SendAsync("scene",s.Wire());await hub.Clients.All.SendAsync("spotifyConfig",c.CardConfig());
    return Results.Json(s.Snapshot());
});
app.MapGet("/api/status", (Connections c) => c.PublicStatus());
app.MapGet("/api/spotify/art", async (string id, Connections c) => {
    var art = await c.GetArt(id);
    return art.HasValue ? Results.File(art.Value.Bytes, art.Value.ContentType) : Results.NotFound();
});
app.MapGet("/overlay/scenes.json", (OverlayState s) => Results.Json(new { doc = s.Document }));
app.MapGet("/api/private/settings", (Connections c) => c.Settings());
app.MapPost("/api/private/settings", async (JsonObject body, Connections c) => { await c.SaveSettings(body); return Results.Json(c.Settings()); });
app.MapPost("/api/private/disconnect/{provider}", async (string provider, Connections c) => { await c.Disconnect(provider); return Results.Ok(); });
app.MapPost("/api/private/connect/{provider}", async (string provider, Connections c) => Results.Json(await c.Connect(provider)));
app.MapGet("/auth/spotify/callback", async (HttpContext ctx, Connections c) => {
    await c.SpotifyCallback(ctx.Request.Query["state"].ToString(), ctx.Request.Query["code"].ToString());
    return Results.Text("Spotify connected. You can close this tab and return to OBS.");
});
app.MapGet("/api/private/games", () => WindowGames.Running());
app.MapPost("/api/private/bridge", async (JsonObject m, OverlayState s, Connections c, Designer d, IHubContext<OverlayHub> hub) => {
    if (m["v"]?.GetValue<int>() != 1) throw new InvalidDataException("Unknown editor message version.");
    var type = m["type"]?.GetValue<string>() ?? "";
    var b = m["body"] as JsonObject ?? new JsonObject();
    object Answer(string t, object value) => new { type = t, body = value };
    switch (type) {
        case "ready": return Results.Json(Answer("init", new { doc = s.Document, chaosUrl = "http://127.0.0.1:5260/", spotifyUrl = "http://127.0.0.1:5260/spotify/", games = WindowGames.Running(), category = c.Category, chaos = (object?)null, imageBase = "http://127.0.0.1:5260/overlay/images/", follows = new { available = c.TwitchConnected }, plugin = true }));
        case "commit": s.Save(b["doc"] as JsonObject ?? throw new InvalidDataException("No layout was supplied.")); c.ReconcileGoals(); await c.SendGoals(hub.Clients.All); await hub.Clients.All.SendAsync("scene", s.Wire()); await hub.Clients.All.SendAsync("spotifyConfig", c.CardConfig()); await hub.Clients.All.SendAsync("scenePreview", (object?)null); return Results.Json(Answer("saved", new { }));
        case "preview": s.ValidatePreview(b); await hub.Clients.All.SendAsync("scenePreview", b); return Results.Json(Answer("ack", new { }));
        case "endPreview": await hub.Clients.All.SendAsync("scenePreview", (object?)null); return Results.Json(Answer("ack", new { }));
        case "makeLive": s.MakeLive(b["sceneId"]?.GetValue<string>() ?? ""); await hub.Clients.All.SendAsync("scene", s.Wire()); await hub.Clients.All.SendAsync("spotifyConfig",c.CardConfig()); return Results.Json(Answer("doc", new { doc = s.Document }));
        case "addImage": case "addSound": {
            var sound = type == "addSound"; var file = s.StoreAsset(b["data"]?.GetValue<string>() ?? "", sound);
            return Results.Json(Answer(sound ? "soundAdded" : "imageAdded", new { file, name = b["name"]?.GetValue<string>() ?? "" }));
        }
        case "testAlert": await c.PublishAlert(b["kind"]?.GetValue<string>() ?? "follow", "Preview viewer", 5, "", true); return Results.Json(Answer("ack", new { }));
        case "searchCategories": return Results.Json(Answer("categories", new { query = b["query"]?.GetValue<string>() ?? "", items = await c.SearchCategories(b["query"]?.GetValue<string>() ?? "") }));
        case "describe": return Results.Json(Answer("described", new { text = await d.Generate(b) }));
        case "mirror": return Results.Json(Answer("ack", new { })); // Pictures are fetched by the host adapter, without blocking edits.
        default: throw new InvalidDataException("That action belongs to ChaosBot or is not supported.");
    }
});
// The editor is installed with the plugin; it is never supplied by a running ChaosBot.
var pages = builder.Configuration["pages"] ?? Path.Combine(AppContext.BaseDirectory, "site");
app.MapGet("/editor/{**path}", (string? path) => {
    var relative = string.IsNullOrEmpty(path) ? "editor/index.html" : "editor/" + path;
    var full = Path.GetFullPath(Path.Combine(pages, relative));
    if (!full.StartsWith(Path.GetFullPath(pages) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !File.Exists(full)) return Results.NotFound();
    var mime = Path.GetExtension(full) switch { ".html" => "text/html", ".js" => "text/javascript", ".css" => "text/css", ".png" => "image/png", ".woff2" => "font/woff2", _ => "application/octet-stream" };
    return Results.File(full, mime);
});
app.MapHub<OverlayHub>("/overlay/hub");
await app.RunAsync();
static bool SecureEquals(string a, string b) => CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(a)), SHA256.HashData(Encoding.UTF8.GetBytes(b)));

namespace Overlay {
    public sealed class OverlayHub(OverlayState state, Connections connections, AudioSpectrum spectrum) : Hub {
        public override async Task OnConnectedAsync() {
            if (string.Equals(Context.GetHttpContext()?.Request.Query["page"].ToString(), "spotify", StringComparison.Ordinal)) spectrum.Connect(Context.ConnectionId, ["pageSpotify"]);
            await Clients.Caller.SendAsync("scene", state.Wire());
            await Clients.Caller.SendAsync("nowPlaying", connections.NowPlaying);
            await Clients.Caller.SendAsync("spotifyConfig", connections.CardConfig());
            await Clients.Caller.SendAsync("chatHistory", new { lines = connections.ChatHistory });
            await connections.SendGoals(Clients.Caller);
            await base.OnConnectedAsync();
        }
        public void Feeds(string[] feeds) => spectrum.Connect(Context.ConnectionId, feeds);
        public override Task OnDisconnectedAsync(Exception? exception) { spectrum.Disconnect(Context.ConnectionId); return base.OnDisconnectedAsync(exception); }
    }
}
