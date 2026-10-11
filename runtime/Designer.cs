using System.Net.Http.Headers;
using System.Text.Json.Nodes;

namespace Overlay;

public sealed class Designer(Vault vault,HttpClient http) {
    readonly SemaphoreSlim single = new(1,1);
    DateTimeOffset lastStart;
    public async Task<string> Generate(JsonObject body) {
        var system=body["system"]?.GetValue<string>() ?? "";
        var user=body["user"]?.GetValue<string>() ?? "";
        if(system.Length is < 1 or > 24000 || user.Length is < 1 or > 8000) throw new InvalidDataException("Describe the layout in up to 8,000 characters.");
        if(!await single.WaitAsync(0)) throw new InvalidDataException("Still working on the last layout.");
        try {
            if(DateTimeOffset.UtcNow-lastStart<TimeSpan.FromSeconds(3)) throw new InvalidDataException("Give it a few seconds, then try again.");
            lastStart=DateTimeOffset.UtcNow;
            using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(60));
            var provider=vault.Get("aiProvider");
            var model=vault.Get("model");
            var key=vault.Get("apiKey");
            string? picture=null;
            if(body["picture"]?.GetValue<bool>()==true) {
                using var frame=await http.GetAsync("http://127.0.0.1:5260/mirror.jpg",timeout.Token);
                if(frame.IsSuccessStatusCode) {
                    var bytes=await frame.Content.ReadAsByteArrayAsync(timeout.Token);
                    if(bytes.Length<4*1024*1024) picture=Convert.ToBase64String(bytes);
                }
            }
            HttpRequestMessage request;
            if(provider=="hosted") {
                if(vault.Get("license").Length==0||vault.Get("tier")!="pro") throw new InvalidDataException("Connect a ChaosBot Pro account in Connections, or choose your own API key.");
                var payload=new JsonObject { ["family"]="openai",["system"]=system,["user"]=user,["reasoning_effort"]="none" };
                if(picture!=null) payload["image_b64"]=picture;
                request=new(HttpMethod.Post,"https://chaoscloud.shelbykb.dev/v1/complete") {Content=JsonContent.Create(payload)};
                request.Headers.Add("X-ChaosBot-License",vault.Get("license"));
                request.Headers.Add("X-ChaosBot-Fingerprint",vault.Get("fingerprint"));
            } else {
                if(string.IsNullOrWhiteSpace(key)||string.IsNullOrWhiteSpace(model)) throw new InvalidDataException("Set your provider, model and API key in Connections.");
                if(provider=="openai") {
                    var content=new JsonArray {new JsonObject {["type"]="input_text",["text"]=user}};
                    if(picture!=null) content.Add(new JsonObject {["type"]="input_image",["image_url"]="data:image/jpeg;base64,"+picture});
                    request=new(HttpMethod.Post,"https://api.openai.com/v1/responses") {Content=JsonContent.Create(new JsonObject {["model"]=model,["instructions"]=system,["input"]=new JsonArray {new JsonObject {["role"]="user",["content"]=content}},["max_output_tokens"]=4096,["store"]=false})};
                    request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",key);
                } else if(provider=="anthropic") {
                    var content=new JsonArray {new JsonObject {["type"]="text",["text"]=user}};
                    if(picture!=null) content.Add(new JsonObject {["type"]="image",["source"]=new JsonObject {["type"]="base64",["media_type"]="image/jpeg",["data"]=picture}});
                    request=new(HttpMethod.Post,"https://api.anthropic.com/v1/messages") {Content=JsonContent.Create(new JsonObject {["model"]=model,["system"]=system,["messages"]=new JsonArray {new JsonObject {["role"]="user",["content"]=content}},["max_tokens"]=4096})};
                    request.Headers.Add("x-api-key",key); request.Headers.Add("anthropic-version","2023-06-01");
                } else if(provider=="gemini") {
                    var parts=new JsonArray {new JsonObject {["text"]=user}};
                    if(picture!=null) parts.Add(new JsonObject {["inline_data"]=new JsonObject {["mime_type"]="image/jpeg",["data"]=picture}});
                    request=new(HttpMethod.Post,$"https://generativelanguage.googleapis.com/v1beta/models/{Uri.EscapeDataString(model)}:generateContent") {Content=JsonContent.Create(new JsonObject {["system_instruction"]=new JsonObject {["parts"]=new JsonArray {new JsonObject {["text"]=system}}},["contents"]=new JsonArray {new JsonObject {["parts"]=parts}},["generationConfig"]=new JsonObject {["maxOutputTokens"]=4096}})};
                    request.Headers.Add("x-goog-api-key",key);
                } else if(provider=="custom") {
                    var url=ValidateBaseUrl(vault.Get("baseUrl"));
                    var content=new JsonArray {new JsonObject {["type"]="text",["text"]=user}};
                    if(picture!=null) content.Add(new JsonObject {["type"]="image_url",["image_url"]=new JsonObject {["url"]="data:image/jpeg;base64,"+picture}});
                    request=new(HttpMethod.Post,url+"/chat/completions") {Content=JsonContent.Create(new JsonObject {["model"]=model,["messages"]=new JsonArray {new JsonObject {["role"]="system",["content"]=system},new JsonObject {["role"]="user",["content"]=content}},["max_tokens"]=4096})};
                    request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",key);
                } else throw new InvalidDataException("Choose a generation provider in Connections.");
            }
            using(request) using(var response=await http.SendAsync(request,timeout.Token)) {
                if(!response.IsSuccessStatusCode) throw new InvalidDataException((int)response.StatusCode switch {401=>"The sign-in or API key was rejected. Reconnect in Connections.",402 or 403=>"Your account does not have access to this generation service or model.",429=>"The generation service is busy or your allowance is used. Try again later.",_=>"The generation service could not answer. Try again."});
                var text=await response.Content.ReadAsStringAsync(timeout.Token);
                if(text.Length>1024*1024) throw new InvalidDataException("The service returned too much data.");
                var json=JsonNode.Parse(text)!;
                var answer=ExtractText(provider,json);
                if(string.IsNullOrWhiteSpace(answer)) throw new InvalidDataException("The service did not return a layout.");
                return answer;
            }
        } catch(OperationCanceledException) {throw new InvalidDataException("Generation took too long. Try a shorter description.");}
        finally { single.Release(); }
    }
    public static string ValidateBaseUrl(string raw) {
        if(!Uri.TryCreate(raw,UriKind.Absolute,out var uri)||uri.UserInfo.Length>0||uri.Query.Length>0||uri.Fragment.Length>0||(uri.Scheme!="https" && !(uri.Scheme=="http" && uri.IsLoopback))) throw new InvalidDataException("Use an HTTPS API address, or a local loopback address.");
        return uri.AbsoluteUri.TrimEnd('/');
    }
    public static string ExtractText(string provider,JsonNode json) => provider switch {
        "hosted"=>json["text"]?.GetValue<string>() ?? json["json"]?.ToJsonString() ?? "",
        "openai"=>string.Concat((json["output"] as JsonArray ?? new()).SelectMany(n=>n?["content"] as JsonArray ?? new()).Where(n=>n?["type"]?.GetValue<string>()=="output_text").Select(n=>n?["text"]?.GetValue<string>()??"")),
        "anthropic"=>string.Concat((json["content"] as JsonArray ?? new()).Where(n=>n?["type"]?.GetValue<string>()=="text").Select(n=>n?["text"]?.GetValue<string>()??"")),
        "gemini"=>string.Concat((json["candidates"]?[0]?["content"]?["parts"] as JsonArray ?? new()).Select(n=>n?["text"]?.GetValue<string>()??"")),
        _=>json["choices"]?[0]?["message"]?["content"]?.GetValue<string>()??""
    };
}
