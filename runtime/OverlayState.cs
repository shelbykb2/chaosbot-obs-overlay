using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Overlay;

public sealed class OverlayState {
    readonly object gate = new();
    readonly string file;
    string lastDisk = "";
    JsonObject document;
    bool initialized;
    public string Site { get; }
    public OverlayState(string site) {
        Site = site;
        Directory.CreateDirectory(Path.Combine(site, "overlay"));
        file = Path.Combine(site, "overlay", "scenes.json");
        document = JsonNode.Parse("""{"schemaVersion":1,"activeSceneId":"gameplay","scenes":[{"id":"gameplay","name":"Gameplay","showFor":[],"elements":[]}]}""")!.AsObject();
        ReadExternal();
        initialized=File.Exists(Path.Combine(Site,"overlay","initialized")) || document["scenes"]!.AsArray().Any(s=>s?["elements"] is JsonArray e && e.Count>0);
        if (!File.Exists(file)) Save(document,false);
    }
    public JsonObject Document { get { lock (gate) return document.DeepClone().AsObject(); } }
    public object Wire() {var doc=Document;return new {activeSceneId=doc["activeSceneId"]?.GetValue<string>(),doc};}
    public void UseModernSync() => AtomicWrite(Path.Combine(Site,"overlay","modern-sync"),"1");
    public bool ImportLegacyCompanion(string? directory) {
        if(string.IsNullOrEmpty(directory)||File.Exists(Path.Combine(Site,"overlay","modern-sync")))return false;
        var source=Path.Combine(directory,"overlay","scenes.json");
        var marker=Path.Combine(Site,"overlay","companion-hash");
        try {
            if(!File.Exists(source)||new FileInfo(source).Length>2*1024*1024)return false;
            var bytes=File.ReadAllBytes(source);var hash=Convert.ToHexString(SHA256.HashData(bytes));
            if(File.Exists(marker)&&File.ReadAllText(marker)==hash)return false;
            var envelope=JsonNode.Parse(bytes) as JsonObject;
            var doc=envelope?["doc"] as JsonObject ?? envelope;
            if(doc==null)return false;Validate(doc);
            foreach(var scene in doc["scenes"]!.AsArray())foreach(var element in scene!["elements"]!.AsArray())foreach(var prop in element!["props"]!.AsObject()) {
                if(prop.Value is not JsonValue value||!value.TryGetValue<string>(out var name))continue;
                var match=Regex.Match(name,@"\A[0-9a-f]{64}\.(png|jpg|gif|webp|mp3|ogg|wav)\z");
                if(!match.Success)continue;
                var sound=match.Groups[1].Value is "mp3" or "ogg" or "wav";
                var media=Path.Combine(directory,"overlay",sound?"sounds":"images",name);
                if(File.Exists(media)&&new FileInfo(media).Length<=8*1024*1024) {
                    var stored=StoreAsset("data:application/octet-stream;base64,"+Convert.ToBase64String(File.ReadAllBytes(media)),sound);
                    if(stored!=name)throw new InvalidDataException("A synced media checksum did not match.");
                }
            }
            Save(doc);AtomicWrite(marker,hash);return true;
        } catch(Exception ex) when(ex is IOException or System.Text.Json.JsonException or InvalidDataException or InvalidOperationException or UnauthorizedAccessException){return false;}
    }
    public bool ReadExternal() {
        lock (gate) {
            try {
                if (!File.Exists(file) || new FileInfo(file).Length > 2 * 1024 * 1024) return false;
                var raw = File.ReadAllText(file);
                if (raw == lastDisk) return false;
                var parsed = JsonNode.Parse(raw) as JsonObject;
                var doc = parsed?["doc"] as JsonObject ?? parsed;
                if (doc is null) return false;
                Validate(doc);
                document = doc.DeepClone().AsObject(); lastDisk = raw; return true;
            } catch (Exception ex) when (ex is System.Text.Json.JsonException or InvalidDataException or InvalidOperationException or IOException or UnauthorizedAccessException) { return false; }
        }
    }
    public string Revision { get { lock(gate) return Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(document.ToJsonString()))).ToLowerInvariant(); } }
    public object Snapshot() { lock(gate) return new { revision=Revision, empty=!initialized, doc=Document }; }
    public bool SaveIfRevision(string revision,JsonObject doc) { lock(gate) { if(revision!=Revision)return false; Save(doc);return true; } }
    public void Save(JsonObject doc,bool markInitialized=true) {
        Validate(doc);
        lock (gate) {
            var next = doc.DeepClone().AsObject();
            var raw = new JsonObject { ["doc"] = next.DeepClone() }.ToJsonString();
            AtomicWrite(file, raw);
            document = next; lastDisk = raw;
            if(markInitialized) {initialized=true;AtomicWrite(Path.Combine(Site,"overlay","initialized"),"1");}
        }
    }
    public void MakeLive(string id) {
        lock (gate) {
            var next = document.DeepClone().AsObject();
            if (!next["scenes"]!.AsArray().Any(s => s?["id"]?.GetValue<string>() == id)) throw new InvalidDataException("That layout no longer exists.");
            next["activeSceneId"] = id; Save(next);
        }
    }
    public void ValidatePreview(JsonObject preview) {
        var id = preview["sceneId"]?.GetValue<string>() ?? "";
        var next = Document;
        var scene = next["scenes"]!.AsArray().FirstOrDefault(s => s?["id"]?.GetValue<string>() == id);
        if (scene is null || preview["elements"] is not JsonArray elements) throw new InvalidDataException("Invalid preview.");
        scene["elements"] = elements.DeepClone(); Validate(next);
    }
    public static void Validate(JsonObject doc) {
        if (doc.ToJsonString().Length > 2 * 1024 * 1024 || doc["schemaVersion"]?.GetValue<int>() != 1) throw new InvalidDataException("Unsupported or oversized layout.");
        if (doc["scenes"] is not JsonArray scenes || scenes.Count is < 1 or > 24) throw new InvalidDataException("Keep between one and 24 layouts.");
        var sceneIds = new HashSet<string>();
        foreach (var s in scenes) {
            var id = Text(s?["id"], 80);
            if (!sceneIds.Add(id)) throw new InvalidDataException("Layout IDs must be unique.");
            Text(s?["name"], 60);
            if (s?["elements"] is not JsonArray elements || elements.Count > 64) throw new InvalidDataException("A layout can hold up to 64 elements.");
            var elementIds = new HashSet<string>();
            foreach (var e in elements) {
                if (!elementIds.Add(Text(e?["id"], 80))) throw new InvalidDataException("Element IDs must be unique.");
                Text(e?["type"], 40); Text(e?["name"], 60);
                if (e?["rect"] is not JsonObject r) throw new InvalidDataException("An element needs a rectangle.");
                foreach (var (key, max) in new[] { ("x", 1920), ("y", 1080), ("w", 1920), ("h", 1080) }) {
                    var n = double.TryParse(r[key]?.ToJsonString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var number) ? number : -1;
                    if (!double.IsFinite(n) || n != Math.Truncate(n) || n < (key is "w" or "h" ? 8 : 0) || n > max) throw new InvalidDataException("Element positions must fit the 1920 × 1080 canvas.");
                }
                if (e["props"] is not JsonObject p || p.ToJsonString().Length > 32768) throw new InvalidDataException("Invalid element properties.");
                foreach (var prop in p) {
                    if (prop.Value is JsonObject or JsonArray) throw new InvalidDataException("Element properties must be simple values.");
                    if (prop.Value is JsonValue value && value.TryGetValue<string>(out var text) && text.Length > 2000) throw new InvalidDataException("Element text is too long.");
                }
            }
            if (s["showFor"] is JsonArray triggers) {
                if (triggers.Count > 16) throw new InvalidDataException("A layout can have up to 16 triggers.");
                foreach (var t in triggers) { if (t?["kind"]?.GetValue<string>() is not ("game" or "category")) throw new InvalidDataException("Unknown layout trigger."); Text(t["value"], 256); Text(t["label"], 256); }
            }
        }
        if (!sceneIds.Contains(doc["activeSceneId"]?.GetValue<string>() ?? "")) throw new InvalidDataException("Choose an existing live layout.");
    }
    static string Text(JsonNode? node, int max) {
        if (node is not JsonValue val || !val.TryGetValue<string>(out var text) || string.IsNullOrWhiteSpace(text) || text.Length > max || text.Any(char.IsControl)) throw new InvalidDataException("A layout has an invalid name or identifier.");
        return text;
    }
    public string StoreAsset(string data, bool sound) {
        var match = Regex.Match(data, @"\Adata:([a-zA-Z0-9/+.-]+);base64,([A-Za-z0-9+/=]+)\z");
        if (!match.Success) throw new InvalidDataException("Choose a picture or sound file.");
        var bytes = Convert.FromBase64String(match.Groups[2].Value);
        if (bytes.Length is < 12 or > 8 * 1024 * 1024) throw new InvalidDataException("Files must be smaller than 8 MB.");
        string? ext = null;
        if (!sound) {
            if (bytes.AsSpan().StartsWith(new byte[] {137,80,78,71,13,10,26,10})) ext = "png";
            else if (bytes[0] == 255 && bytes[1] == 216 && bytes[2] == 255) ext = "jpg";
            else if (System.Text.Encoding.ASCII.GetString(bytes,0,6) is "GIF87a" or "GIF89a") ext = "gif";
            else if (System.Text.Encoding.ASCII.GetString(bytes,0,4) == "RIFF" && System.Text.Encoding.ASCII.GetString(bytes,8,4) == "WEBP") ext = "webp";
        } else {
            if (System.Text.Encoding.ASCII.GetString(bytes,0,4) == "RIFF" && System.Text.Encoding.ASCII.GetString(bytes,8,4) == "WAVE") ext = "wav";
            else if (System.Text.Encoding.ASCII.GetString(bytes,0,4) == "OggS") ext = "ogg";
            else if (System.Text.Encoding.ASCII.GetString(bytes,0,3) == "ID3" || bytes[0] == 255 && (bytes[1] & 224) == 224) ext = "mp3";
        }
        if (ext is null) throw new InvalidDataException(sound ? "Use MP3, OGG or WAV." : "Use PNG, JPG, GIF or WebP. SVG is not supported.");
        var dir = Path.Combine(Site,"overlay",sound ? "sounds" : "images"); Directory.CreateDirectory(dir);
        var name = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant() + "." + ext;
        var dest = Path.Combine(dir,name);
        if (!File.Exists(dest)) {
            if (new DirectoryInfo(dir).EnumerateFiles().Sum(f => f.Length) + bytes.Length > 64 * 1024 * 1024) throw new InvalidDataException("Your media library is full (64 MB).");
            File.WriteAllBytes(dest,bytes);
        }
        return name;
    }
    public static void AtomicWrite(string path,string contents) {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try { File.WriteAllText(temp,contents); File.Move(temp,path,true); }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
}
