const BASE='http://localhost:4000';
async function readSSE(res,on){const r=res.body.getReader(),d=new TextDecoder();let b='';for(;;){const{value,done}=await r.read();if(done)break;b+=d.decode(value,{stream:true});let i;while((i=b.indexOf('\n\n'))>=0){const bl=b.slice(0,i);b=b.slice(i+2);const ev=bl.match(/event:\s*(.+)/)?.[1]?.trim();const da=bl.match(/data:\s*([\s\S]+)/)?.[1]?.trim();if(ev)on(ev,da?JSON.parse(da):null);}}}
(async()=>{
  const email=`tk${Date.now()}@genspec.dev`;
  const token=(await (await fetch(BASE+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Tk',email,password:'secret123'})})).json()).accessToken;
  const H={Authorization:`Bearer ${token}`};
  const est=await (await fetch(BASE+'/estimates',{method:'POST',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({name:'T'})})).json();
  const form=new FormData(); form.append('message','Lập dự toán nhà phố 3 tầng 5x20 Bình Dương, giá mới nhất.');
  const res=await fetch(`${BASE}/estimates/${est.id}/copilot/stream`,{method:'POST',headers:H,body:form});
  let tok=0,chars=0,steps=0,prop=0,first=0; const t0=Date.now(); let sample='';
  await readSSE(res,(ev,d)=>{ if(ev==='token'){tok++;chars+=(d.text||'').length;if(!first)first=Date.now()-t0; if(sample.length<160)sample+=d.text;} else if(ev==='step')steps++; else if(ev==='proposal')prop=d.actions?.length; });
  console.log(`tokens=${tok} chars=${chars} firstTokenAt=${first}ms steps=${steps} actions=${prop} total=${Math.round((Date.now()-t0)/1000)}s`);
  console.log('sample text:', JSON.stringify(sample.slice(0,140)));
  console.log(tok>=5&&chars>200?'STREAMING OK ✓':'STILL FALLBACK ✗');
  process.exit(tok>=5?0:1);
})().catch(e=>{console.error(e.message);process.exit(1)});
