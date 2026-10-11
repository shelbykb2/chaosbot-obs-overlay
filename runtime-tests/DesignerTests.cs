using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Overlay;

namespace Overlay.RuntimeTests;
public static class DesignerTests {
    public static async Task RunAsync() {
        var folder=Path.Combine(Path.GetTempPath(),"OverlayDesigner.Tests-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(folder);
        try {
            var vault=new Vault(Path.Combine(folder,"vault.dat"));
            using var handler=new ProviderHandler();using var http=new HttpClient(handler);
            var body=new JsonObject {["system"]="Only return validated layout JSON.",["user"]="A purple chat box.",["picture"]=false};
            vault.SetMany(new(){["aiProvider"]="hosted",["tier"]="free",["license"]="test-only-license"});
            try{await new Designer(vault,http).Generate(body);throw new Exception("Free account used hosted AI.");}catch(InvalidDataException){}
            Check(handler.Calls==0,"The Free account is rejected before an outbound request.");
            vault.SetMany(new(){["aiProvider"]="openai",["model"]="test-model",["apiKey"]="test-only-key"});
            Check(await new Designer(vault,http).Generate(body)=="layout","OpenAI generation returns the provider response.");
            Check(handler.Url=="https://api.openai.com/v1/responses"&&handler.Bearer=="test-only-key","The user key goes to OpenAI's Responses API.");
            Check(!handler.Body.Contains("test-only-license")&&!handler.Body.Contains("test-only-key"),"Secrets are headers, never layout prompts.");
            vault.SetMany(new(){["aiProvider"]="hosted",["tier"]="pro",["license"]="test-only-license",["fingerprint"]="test-fingerprint"});
            Check(await new Designer(vault,http).Generate(body)=="layout","Pro generation uses the hosted completion contract.");
            Check(handler.Url=="https://chaoscloud.shelbykb.dev/v1/complete"&&handler.License=="test-only-license"&&handler.Bearer=="","Hosted generation sends the signed license and no user API key.");
        } finally{Directory.Delete(folder,true);}
    }
    static void Check(bool yes,string reason){if(!yes)throw new Exception(reason);}
    sealed class ProviderHandler:HttpMessageHandler {
        public int Calls;public string Url="",Bearer="",Body="",License="";
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct){
            Calls++;Url=request.RequestUri!.ToString();Bearer=request.Headers.Authorization?.Parameter??"";License=request.Headers.TryGetValues("X-ChaosBot-License",out var l)?l.Single():"";Body=await request.Content!.ReadAsStringAsync(ct);
            return new(HttpStatusCode.OK){Content=new StringContent(Url.Contains("chaoscloud")?"""{"text":"layout"}""":"""{"output":[{"content":[{"type":"output_text","text":"layout"}]}]}""",Encoding.UTF8,"application/json")};
        }
    }
}
