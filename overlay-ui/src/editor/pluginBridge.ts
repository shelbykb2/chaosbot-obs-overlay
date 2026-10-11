import type { Incoming } from './bridge';

export const pluginEditor = () => location.port === '5261';
let listener: ((m: Incoming) => void) | null = null;
let pending = Promise.resolve();
let mirrorTimer = 0;
let held: string | null = null;
let lastDoc = '';
let docTick = false;

export async function privateApi(path: string, body?: unknown) {
  const response = await fetch('/api/private/' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'That operation could not finish.');
  return data;
}

function emit(type: string, body: unknown) { listener?.({type,body} as Incoming); }

async function picture(live: boolean) {
  try {
    const res = await fetch('http://127.0.0.1:5260/mirror.jpg');
    if (!res.ok) return;
    const blob = await res.blob();
    const src = await new Promise<string>((resolve,reject)=>{const r = new FileReader();r.onload=()=>resolve(String(r.result));r.onerror=reject;r.readAsDataURL(blob);});
    if(live && !mirrorTimer) return;
    held = src;
    emit('still',{src,live});
  } catch { /* OBS has not produced a frame yet. */ }
}

export function pluginSend(type: string, body: Record<string,unknown>) {
  if(type === 'openSettings') {window.dispatchEvent(new Event('overlay-connections'));return;}
  if(type === 'copyUrl') {
    navigator.clipboard.writeText('http://127.0.0.1:5260/' + (body.which === 'spotify' ? 'spotify/' : ''))
      .then(()=>emit('copied',{which:body.which})).catch(()=>emit('toast',{text:'Select the address and copy it.'}));return;
  }
  if(type === 'mirror') {
    if(mirrorTimer) clearInterval(mirrorTimer);
    mirrorTimer=0;
    if(body.on) {mirrorTimer=window.setInterval(()=>void picture(true),500);void picture(true);}
    else {if(held) localStorage.setItem('overlay-held-picture',held);emit('still',{src:held,live:false});}
    return;
  }
  const work = async () => {
    try {
      const result = await privateApi('bridge',{v:1,type,body});
      if(type === 'commit') lastDoc=JSON.stringify(body.doc);
      if(type === 'ready') {lastDoc=JSON.stringify(result.body.doc);held=localStorage.getItem('overlay-held-picture');}
      emit(result.type,result.body);
      if(type === 'ready' && held) emit('still',{src:held,live:false});
    } catch(e) {
      const text=e instanceof Error ? e.message : 'Could not connect to the overlay service.';
      emit(type === 'describe' ? 'describeFailed' : type === 'addImage' ? 'imageFailed' : type === 'addSound' ? 'soundFailed' : 'error',{name:body.name,text});
    }
  };
  if(type === 'describe') void work();
  else pending=pending.then(work,work);
}

export function pluginListen(fn: (m: Incoming) => void) {
  listener=fn;
  window.setInterval(async ()=>{
    if(docTick) return;
    docTick=true;
    try {
      const doc=(await (await fetch('/overlay/scenes.json')).json()).doc;
      const key=JSON.stringify(doc);
      if(lastDoc && key!==lastDoc) {lastDoc=key;emit('doc',{doc});}
      const games=await privateApi('games');emit('games',{games});
    } catch { /* The next tick recovers after runtime restart. */ }
    finally {docTick=false;}
  },1200);
}
