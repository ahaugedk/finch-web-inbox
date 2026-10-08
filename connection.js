// The connection marker coordinates browsers. Verified email remains the only account identity.
window.FinchConnection=(()=>{
  let channel=null,pending=null,timer=null,error='',startedHere=false,onChange=()=>{},onConnected=async()=>{};
  const params=new URLSearchParams(location.search),ua=[navigator.userAgent,...(navigator.userAgentData?.brands||[]).map(b=>b?.brand)].filter(Boolean).join(' ');
  const agentHint=/Claude/i.test(ua)?'Claude':/Codex/i.test(ua)?'Codex':/Copilot|VSCode|\bCode\/\d/i.test(ua)?'GitHub Copilot':/ChatGPT|OpenAI|Atlas/i.test(ua)?'ChatGPT':/Gemini/i.test(ua)?'Gemini':/Cursor/i.test(ua)?'Cursor':null;
  const agentBrowser=params.get('ua')==='agent'||(params.get('ua')!=='human'&&!!agentHint);
  function environment(){
    const api=document.modelContext||navigator.modelContext;
    return {agent:agentHint,family:agentHint==='Claude'?'claude':agentHint==='GitHub Copilot'?'copilot':['Codex','ChatGPT'].includes(agentHint)?'openai':'unknown',nativeWebMCP:typeof api?.registerTool==='function'||typeof api?.provideContext==='function',jsBridge:typeof window.webmcp?.call==='function'};
  }
  function promptInstructions(){
    const env=environment(),name=env.agent||'Din agent';
    const native='Brug browserværktøjets dokumenterede native WebMCP-interface, hent den aktuelle registrering og kald tools med deres præcise registrerede navne.';
    const bridge='JavaScript-broen må kun bruges, hvis dit værktøj udtrykkeligt understøtter kald i sidens normale JavaScript-kontekst: webmcp.listTools() viser input; await webmcp.call("start_conversation", {agent_name:"<dit navn>"}) forbinder agenten.';
    const transport=env.family==='openai'?`${name}: brug tab.capabilities.get("webmcp"), fetchTools(), tools.description() og tools.call(...). playwright.evaluate er en isoleret læsekontekst og kan ikke se window.webmcp. Brug native WebMCP.`:
      env.family==='claude'?`Claude: ${env.nativeWebMCP?native+' ':''}${bridge} Kald ikke broen fra en isoleret læsekontekst. Hvis din browser udstiller native WebMCP, skal det foretrækkes.`:
      env.family==='copilot'?`GitHub Copilot: brug browser-/MCP-integrationen, der er tilgængelig i denne chat. ${native} ${bridge} En VS Code-webview eller browser alene beviser ikke, at integrationskald er understøttet.`:
      `${env.nativeWebMCP?'Siden tilbyder native WebMCP. ':''}${native} ${env.jsBridge?bridge:'En JS-bro er kun en mulighed, hvis både siden og dit browserværktøj udtrykkeligt understøtter den.'} Miljøet er ikke sikkert identificeret; antag ikke bestemte JavaScript- eller browser-API’er.`;
    return transport+' Ved transportafvisning: gengiv den præcise fejl og omgå den ikke. Bed kun om adgang ved en tilladelsesfejl; overskredne konfigurationsgrænser kræver en rettelse i Finch.';
  }
  async function request(path,method='GET',data){const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',headers:data?{'Content-Type':'application/json'}:{},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(10000)});const result=await response.json();if(!response.ok){const e=new Error(result.message||'Forbindelsen kunne ikke klargøres.');e.status=response.status;throw e;}return result;}
  function url(base=location.href){const url=globalThis.FinchSite?.canonicalUrl(base)||new URL(base);url.searchParams.delete('s');url.searchParams.set('ua','agent');for(const key of ['org','invite'])if(!url.searchParams.has(key)&&/^[a-f0-9-]{36}$/.test(new URL(location.href).searchParams.get(key)||''))url.searchParams.set(key,new URL(location.href).searchParams.get(key));if(channel)url.searchParams.set('connect',channel.id);return url.href;}
  function retain(){const address=new URL(location.href);address.searchParams.delete('s');address.searchParams.set('connect',channel.id);history.replaceState(null,'',address);}
  async function adopt(result){const wasConnected=channel?.status==='connected',changed=!!error||!channel||['id','status','agent'].some(key=>channel[key]!==result[key]),newChannel=channel?.id!==result.id;channel=result;error='';if(newChannel)retain();if(changed)onChange();if(result.status==='connected'){clearInterval(timer);if(!wasConnected)await onConnected();}}
  async function poll(){if(!channel||channel.status==='connected')return;try{await adopt(await request('/api/connections/'+channel.id));}catch(e){if(e.status===404){clearInterval(timer);channel=null;error=e.message;onChange();}else if(error!==e.message){error=e.message;onChange();}}}
  async function initialize(options){onChange=options.onChange;onConnected=options.onConnected;return prepare();}
  async function prepare(){if(pending)return pending;error='';onChange();pending=(async()=>{try{const wanted=new URL(location.href).searchParams.get('connect');let result;if(/^[a-f0-9-]{36}$/.test(wanted||'')){try{result=await request('/api/connections/'+wanted);}catch(e){if(e.status!==404)throw e;}}
    if(!result)result=await request('/api/connections','POST',{});await adopt(result);if(channel.status!=='connected'){clearInterval(timer);timer=setInterval(poll,2000);}
  }catch(e){error=e.message;onChange();}finally{pending=null;}})();return pending;}
  async function start(agent){await pending;if(channel?.status==='connected'){startedHere=true;channel={...channel,agent};error='';onChange();return;}if(!channel)await prepare();if(!channel)throw new Error(error||'Forbindelsen kunne ikke klargøres.');const result=await request('/api/connections/'+channel.id+'/start','POST',{agent_name:agent});startedHere=true;await adopt(result);}
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();});
  document.addEventListener('click',event=>{if(event.target.closest('[data-connection-retry]'))prepare();});
  return {initialize,start,url,environment,promptInstructions,get connected(){return channel?.status==='connected';},get ready(){return !!channel;},get agent(){return channel?.agent||null;},get error(){return error;},get loginAllowed(){return agentBrowser||startedHere;},agentHint,agentBrowser};
})();
