// Installed-shape validation. This intentionally refuses the normal OBS WebSocket port.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const fixture=new URL('../test-artifacts/obs-portable/',import.meta.url);
const config=JSON.parse(readFileSync(new URL('config/obs-studio/plugin_config/obs-websocket/config.json',fixture),'utf8'));
assert.equal(config.server_port,4459,'Only the isolated OBS fixture may be controlled.');
const socket=new WebSocket('ws://127.0.0.1:4459');
const requests=new Map();let serial=0;
const hash=x=>createHash('sha256').update(x).digest('base64');
const ready=new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(new Error('Fixture OBS handshake timed out')),10000);
  socket.addEventListener('error',()=>reject(new Error('Fixture OBS socket failed')));
  socket.addEventListener('message',event=>{
    const message=JSON.parse(String(event.data));
    if(message.op===0){const a=message.d.authentication;socket.send(JSON.stringify({op:1,d:{rpcVersion:1,eventSubscriptions:0,...(a?{authentication:hash(hash(config.server_password+a.salt)+a.challenge)}:{})}}));}
    if(message.op===2){clearTimeout(timeout);resolve();}
    if(message.op===7){const pending=requests.get(message.d.requestId);requests.delete(message.d.requestId);if(message.d.requestStatus.result)pending?.resolve(message.d.responseData??{});else pending?.reject(new Error(message.d.requestType+': '+message.d.requestStatus.comment));}
  });
});
async function request(type,data={}){
  const id=String(++serial);
  return new Promise((resolve,reject)=>{requests.set(id,{resolve,reject});socket.send(JSON.stringify({op:6,d:{requestType:type,requestId:id,requestData:data}}));});
}
try{
  await ready;
  assert.equal((await request('GetStreamStatus')).outputActive,false);
  const {currentProgramSceneName:sceneName}=await request('GetCurrentProgramScene');
  const kinds=(await request('GetInputKindList')).inputKinds;
  const existing=(await request('GetInputList')).inputs.map(x=>x.inputName);
  const background='Plugin validation background',overlay='Plugin validation overlay';
  if(!existing.includes(background))await request('CreateInput',{sceneName,inputName:background,inputKind:kinds.includes('color_source_v3')?'color_source_v3':'color_source',inputSettings:{color:0xff202020,width:1280,height:720},sceneItemEnabled:true});
  if(!existing.includes(overlay)){
    const item=await request('CreateInput',{sceneName,inputName:overlay,inputKind:'browser_source',inputSettings:{url:'http://127.0.0.1:5260/',width:1920,height:1080,fps:15,shutdown:true},sceneItemEnabled:true});
    await request('SetSceneItemTransform',{sceneName,sceneItemId:item.sceneItemId,sceneItemTransform:{positionX:0,positionY:0,scaleX:1280/1920,scaleY:720/1080}});
  }
  await new Promise(resolve=>setTimeout(resolve,4000));
  const shot=await request('GetSourceScreenshot',{sourceName:sceneName,imageFormat:'png',imageWidth:1280,imageHeight:720});
  writeFileSync(new URL('../test-artifacts/obs-output-final.png',import.meta.url),Buffer.from(shot.imageData.split(',')[1],'base64'));
  let mirror;
  for(let attempt=0;attempt<25;attempt++){
    mirror=await fetch('http://127.0.0.1:5260/mirror.jpg');
    if(mirror.ok)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(mirror.status,200);
  writeFileSync(new URL('../test-artifacts/mirror-final.jpg',import.meta.url),Buffer.from(await mirror.arrayBuffer()));
  console.log('Fixture OBS rendered the installed browser overlay; output and mirror captured.');
}finally{socket.close();}
