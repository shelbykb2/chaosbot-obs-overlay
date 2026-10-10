import {useEffect,useState} from 'preact/hooks';
import {CANVAS} from './model';
import {register,type StageProps} from './registry';
import {Region} from '../shared/Region';

const rect=(el:StageProps['el'])=>({x:el.rect.x/CANVAS.w,y:el.rect.y/CANVAS.h,w:el.rect.w/CANVAS.w,h:el.rect.h/CANVAS.h});
const colors=[{value:'#9455FF',name:'Purple'},{value:'#ffffff',name:'White'},{value:'#2EE6C5',name:'Teal'},{value:'#FF4F9A',name:'Pink'}];
const color=(v:unknown)=>typeof v==='string'&&/^#[a-f0-9]{6}$/i.test(v)?v:'#9455FF';
function Countdown({el}:StageProps){
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t);},[]);
  const start=Date.parse(String(el.props.reset||''));
  const minutes=Math.min(180,Math.max(1,Number(el.props.minutes)||5));
  const seconds=Math.max(0,Math.ceil(((Number.isFinite(start)?start:now)+minutes*60000-now)/1000));
  const time=`${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`;
  return <Region rect={rect(el)} design={{w:el.rect.w,h:el.rect.h}}><div style={{width:'100%',height:'100%',display:'flex',flexDirection:'column',justifyContent:'center',alignItems:'center',color:color(el.props.color),fontFamily:'Segoe UI, sans-serif',textShadow:'0 2px 20px rgba(0,0,0,.35)'}}><span style={{fontSize:Math.max(12,el.rect.h*.17)+'px'}}>{String(el.props.label||'Starting soon')}</span><strong style={{fontSize:Math.max(24,el.rect.h*.55)+'px',fontVariantNumeric:'tabular-nums'}}>{seconds?time:String(el.props.finished||'We are live')}</strong></div></Region>;
}
register({type:'countdown',label:'Countdown',blurb:'A timer for starting soon or a break',icon:'',tone:'menu-ic-text',size:{w:600,h:220},min:{w:160,h:80},avoidByDefault:true,defaults:{minutes:5,label:'Starting soon',finished:'We are live',color:'#ffffff',reset:new Date().toISOString()},fields:[{kind:'text',key:'label',label:'Label',max:80},{kind:'slider',key:'minutes',label:'Minutes',min:1,max:180,step:1},{kind:'text',key:'finished',label:'When the timer ends',max:80},{kind:'swatches',key:'color',label:'Colour',options:colors},{kind:'goalReset',key:'reset',label:'Start timer',hint:'Starts this countdown now.'}],Stage:Countdown});
function Frame({el}:StageProps){return <Region rect={rect(el)} design={{w:el.rect.w,h:el.rect.h}}><div style={{width:'100%',height:'100%',border:`${Math.min(24,Math.max(1,Number(el.props.thickness)||4))}px solid ${color(el.props.color)}`,borderRadius:Math.min(160,Math.max(0,Number(el.props.radius)||0))+'px',boxSizing:'border-box',boxShadow:el.props.glow?'0 0 28px '+color(el.props.color):'none',pointerEvents:'none'}}>{el.props.label&&<span style={{position:'absolute',left:'18px',bottom:'-17px',background:color(el.props.color),padding:'5px 14px',borderRadius:'8px',color:'#101020',font:'bold 20px Segoe UI'}}>{String(el.props.label)}</span>}</div></Region>;}
register({type:'webcam',label:'Webcam frame',blurb:'A frame around your existing OBS webcam',icon:'',tone:'menu-ic-shape',size:{w:480,h:270},min:{w:80,h:60},avoidByDefault:true,defaults:{color:'#9455FF',thickness:4,radius:16,glow:false,label:''},fields:[{kind:'swatches',key:'color',label:'Colour',options:colors},{kind:'slider',key:'thickness',label:'Thickness',min:1,max:24,step:1,unit:'px'},{kind:'slider',key:'radius',label:'Rounded corners',min:0,max:160,step:1,unit:'px'},{kind:'toggle',key:'glow',label:'Glow'},{kind:'text',key:'label',label:'Label',max:80}],Stage:Frame});
