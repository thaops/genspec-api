const BASE='http://localhost:4000';
(async()=>{
  const email=`db${Date.now()}@genspec.dev`;
  const token=(await (await fetch(BASE+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Db',email,password:'secret123'})})).json()).accessToken;
  const H={Authorization:`Bearer ${token}`};
  const est=await (await fetch(BASE+'/estimates',{method:'POST',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({name:'T'})})).json();
  const form=new FormData(); form.append('message','Thêm 1 công tác bê tông móng M250 khối lượng 10 m3, giá vật liệu xi măng cát đá.');
  const res=await fetch(`${BASE}/estimates/${est.id}/copilot/stream`,{method:'POST',headers:H,body:form});
  let tok=0; const r=res.body.getReader(),d=new TextDecoder();let b='';
  for(;;){const{value,done}=await r.read();if(done)break;b+=d.decode(value,{stream:true});let i;while((i=b.indexOf('\n\n'))>=0){const bl=b.slice(0,i);b=b.slice(i+2);if(/event:\s*token/.test(bl))tok++;}}
  console.log('client tokens=',tok);
})().catch(e=>console.error(e.message));
