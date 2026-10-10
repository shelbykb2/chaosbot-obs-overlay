import {useEffect,useState} from 'preact/hooks';
import {privateApi} from './pluginBridge';

interface Settings {aiProvider:string;apiKey:string;hasApiKey:boolean;model:string;baseUrl:string;spotifyClientId:string;twitchClientId:string;hasChaosBotLicense:boolean;chaosBotTier:string;}
export function Connections() {
  const [open,setOpen]=useState(false);
  const [settings,setSettings]=useState<Settings|null>(null);
  const [status,setStatus]=useState<any>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [device,setDevice]=useState('');
  useEffect(()=>{const fn=()=>setOpen(true);window.addEventListener('overlay-connections',fn);return()=>window.removeEventListener('overlay-connections',fn);},[]);
  useEffect(()=>{
    if(!open)return;
    privateApi('settings').then(setSettings).catch(e=>setError(e.message));
    const tick=()=>fetch('/api/status').then(r=>r.json()).then(setStatus).catch(()=>{});
    tick();const timer=setInterval(tick,1500);return()=>clearInterval(timer);
  },[open]);
  if(!open)return null;
  const update=(key:keyof Settings,value:string)=>setSettings(s=>s?{...s,[key]:value}:s);
  const field=(key:keyof Settings,label:string,type: 'text' | 'password' | 'url' = 'text',hint?:string)=>(<label class="connection-field"><span>{label}</span>{type==='password'?<input type="password" aria-label={label} value={String(settings?.[key]??'')} autoComplete="off" onInput={e=>update(key,e.currentTarget.value)} />:<input type="text" aria-label={label} value={String(settings?.[key]??'')} autoComplete="off" onInput={e=>update(key,e.currentTarget.value)} />}{hint&&<small>{hint}</small>}</label>);
  const save=async()=>{if(!settings)return;await privateApi('settings',settings);};
  const act=async(provider:string,disconnect=false)=>{
    setBusy(true);setError('');
    try{await save();const result=await privateApi(`${disconnect?'disconnect':'connect'}/${provider}`,{});if(result.code)setDevice(result.code);if(result.user_code)setDevice(result.user_code);setSettings(await privateApi('settings'));}
    catch(e){setError(e instanceof Error?e.message:'Could not connect.');}finally{setBusy(false);}
  };
  return <div class="connection-shade" onClick={e=>{if(e.target===e.currentTarget)setOpen(false);}}><section class="connections" role="dialog" aria-modal="true" aria-labelledby="connection-title">
    <div class="connection-title"><div><h2 id="connection-title">Connections</h2><p>Your overlay stays live while OBS is open.</p></div><button class="btn" onClick={()=>setOpen(false)} aria-label="Close connections">Close</button></div>
    {error&&<p class="connection-error" role="alert">{error}</p>}
    {!settings?<p>Loading connections…</p>:<>
      <section><h3>Twitch</h3><p>{status?.twitch?.status??'Disconnected'} {status?.twitch?.name&&`· ${status.twitch.name}`}</p>
        <details><summary>Advanced Twitch settings</summary>{field('twitchClientId','Twitch client ID','text','The plugin includes its own public app. Change this only to use your own public Twitch application.')}</details>
        <div class="connection-buttons"><button class="btn" disabled={busy} onClick={()=>act('twitch')}>Connect Twitch</button><button class="btn btn-sub" disabled={busy} onClick={()=>act('twitch',true)}>Disconnect</button></div>
        {device&&<p role="status">Enter code <strong>{device}</strong> on the Twitch page opened in your browser.</p>}
      </section>
      <section><h3>Spotify</h3><p>{status?.spotify?.status??'Disconnected'}</p>
        {field('spotifyClientId','Spotify client ID','text','Register http://127.0.0.1:5261/auth/spotify/callback as the redirect URI in your Spotify application.')}
        <div class="connection-buttons"><button class="btn" disabled={busy} onClick={()=>act('spotify')}>Connect Spotify</button><button class="btn btn-sub" disabled={busy} onClick={()=>act('spotify',true)}>Disconnect</button></div>
      </section>
      <section><h3>Generate an overlay</h3><p>Choose ChaosBot Pro, or use your own API key. Generated layouts are previewed before you apply them.</p>
        <label class="connection-field"><span>Generation service</span><select value={settings.aiProvider||'hosted'} onChange={e=>update('aiProvider',e.currentTarget.value)}><option value="hosted">ChaosBot Pro</option><option value="openai">OpenAI · my API key</option><option value="anthropic">Anthropic · my API key</option><option value="gemini">Gemini · my API key</option><option value="custom">Compatible provider · my API key</option></select></label>
        {(settings.aiProvider||'hosted')==='hosted'?<><p>{settings.hasChaosBotLicense?`Account connected · ${settings.chaosBotTier}`:'Sign in with your ChaosBot account. Pro is required for hosted generation.'}</p><div class="connection-buttons"><button class="btn" disabled={busy} onClick={()=>act('chaosbot')}>Sign in to ChaosBot</button><button class="btn btn-sub" disabled={busy} onClick={()=>act('chaosbot',true)}>Sign out</button></div></>:<>
          {field('model','Model')}{field('apiKey','API key','password','Stored encrypted for your Windows account. Keys are never included in layouts or sent to ChaosBot.')}
          {settings.aiProvider==='custom'&&field('baseUrl','API base URL','url','An OpenAI-compatible API, such as https://api.example.com/v1.')}
        </>}
      </section>
      <div class="connection-buttons"><button class="btn" disabled={busy} onClick={async()=>{setBusy(true);try{await save();setOpen(false);}catch(e){setError(e instanceof Error?e.message:'Could not save.');}finally{setBusy(false);}}}>Save connections</button></div>
    </>}
  </section></div>;
}
