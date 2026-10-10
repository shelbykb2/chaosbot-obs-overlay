// ChaosBot's optional mascot is a separate layer; it cannot supply or duplicate our widgets.
let companion;
async function check(){try{const s=await(await fetch('/api/status')).json();if(s.companion&&!companion){companion=document.createElement('iframe');companion.src='/companion/';companion.title='ChaosBot';document.body.append(companion);}else if(!s.companion&&companion){companion.remove();companion=null;}}catch{}}
check();setInterval(check,3000);
