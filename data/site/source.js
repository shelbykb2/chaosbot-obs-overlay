// ChaosBot's optional mascot is a separate layer; it cannot supply or duplicate our widgets.
let companion, checking=false;
async function check(){
  if(checking)return;
  checking=true;
  try{
    const s=await(await fetch('/api/status')).json();
    if(!s.companion){companion?.remove();companion=null;return;}
    // A running bot may not have synced its optional mascot page yet.
    if(!companion){
      const page=await fetch('/companion/',{cache:'no-store'});
      if(!page.ok)return;
      companion=document.createElement('iframe');companion.src='/companion/';companion.title='ChaosBot';document.body.append(companion);
    }
  }catch{}finally{checking=false;}
}
check();setInterval(check,3000);
