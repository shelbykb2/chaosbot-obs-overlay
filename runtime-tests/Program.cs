using System.Text.Json.Nodes;
using Overlay;

await Overlay.RuntimeTests.FeedTests.RunAsync();
Overlay.RuntimeTests.AudioTests.Run();
await Overlay.RuntimeTests.DesignerTests.RunAsync();
var root=Path.Combine(Path.GetTempPath(),"OverlayRuntime.Tests-"+Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
try {
    var s=new OverlayState(root);
    var doc=s.Document;
    doc["scenes"]![0]!["elements"]!.AsArray().Add(JsonNode.Parse("""{"id":"caption","type":"text","name":"Caption","rect":{"x":100,"y":200,"w":500,"h":80},"props":{"text":"Saved independently"}}"""));
    s.Save(doc);
    var restarted=new OverlayState(root);
    Require(restarted.Document["scenes"]![0]!["elements"]![0]!["props"]!["text"]!.GetValue<string>()=="Saved independently","A real disk save survives a new runtime.");
    var invalid=doc.DeepClone().AsObject();invalid["scenes"]![0]!["elements"]![0]!["rect"]!["x"]=-1;
    Reject(()=>s.Save(invalid));
    File.WriteAllText(Path.Combine(root,"overlay","scenes.json"),"{broken");
    Require(!s.ReadExternal(),"A partially synced layout preserves the last good state.");
    Reject(()=>s.StoreAsset("data:image/svg+xml;base64,"+Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes("<svg><script>alert(1)</script></svg>")),false));
    Reject(()=>Designer.ValidateBaseUrl("http://example.com/v1"));
    Reject(()=>Designer.ValidateBaseUrl("https://user:secret@example.com/v1"));
    Require(Designer.ExtractText("openai",JsonNode.Parse("""{"output":[{"content":[{"type":"output_text","text":"layout"}]}]}""")!)=="layout","OpenAI Responses content is extracted.");
    Require(Designer.ExtractText("anthropic",JsonNode.Parse("""{"content":[{"type":"text","text":"layout"}]}""")!)=="layout","Anthropic content is extracted.");
    var vault=new Vault(Path.Combine(root,"vault.dat"));vault.Set("apiKey","test-only-api-key");
    Require(!System.Text.Encoding.UTF8.GetString(File.ReadAllBytes(Path.Combine(root,"vault.dat"))).Contains("test-only-api-key"),"Credentials are not plaintext on disk.");
    Require(new Vault(Path.Combine(root,"vault.dat")).Get("apiKey")=="test-only-api-key","The same Windows user can recover encrypted credentials.");
    Console.WriteLine("Layout, assets, provider contracts, and Windows credential protection passed.");
} finally {Directory.Delete(root,true);}
static void Require(bool good,string message){if(!good)throw new Exception(message);}
static void Reject(Action call){try{call();}catch(InvalidDataException){return;}throw new Exception("Malformed input was accepted.");}
