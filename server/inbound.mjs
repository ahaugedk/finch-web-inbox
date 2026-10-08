import {organizationAccess,organizationTeam} from './team.mjs';
import {inboundRejectionEmail} from './mail.mjs';
const inboundEncoder=new TextEncoder();
const INBOUND_LIMITS={webhookBytes:256*1024,providerBytes:1024*1024,textChars:100000,fileBytes:10*1024*1024,totalFileBytes:20*1024*1024,attachments:10,stateBytes:2*1024*1024};
const inboundShort=(s,n)=>typeof s==='string'?s.trim().slice(0,n):'';
export function inboundMailbox(value){
  if(typeof value!=='string'||value.length>600||/[\r\n\x00]/.test(value))return null;
  const match=value.trim().match(/^(?:[^<>]*<([^<>]+)>|([^<>]+))$/);const email=(match?.[1]||match?.[2]||'').trim().toLowerCase();
  return email.length<=254&&/^[^\s@<>,;"()]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email)?email:null;
}
const inboundDomain=env=>/^[a-z0-9.-]+\.[a-z]{2,}$/.test(env.INBOUND_EMAIL_DOMAIN||'')?env.INBOUND_EMAIL_DOMAIN:null;
export const inboundAvailable=env=>!!(inboundDomain(env)&&env.RESEND_INBOUND_API_KEY&&env.RESEND_WEBHOOK_SECRET);
const inboundAddress=(env,row)=>row&&inboundDomain(env)?`org-${row.alias}@${inboundDomain(env)}`:null;
async function inboundBytes(response,maxBytes){
  if(Number(response.headers.get('Content-Length'))>maxBytes)throw new Error('inbound_too_large');
  const reader=response.body?.getReader();const chunks=[];let length=0;
  if(reader)for(;;){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>maxBytes){await reader.cancel();throw new Error('inbound_too_large');}chunks.push(value);}
  const bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return bytes;
}
export async function verifyInboundWebhook(request,secret,now){
  if(!secret?.startsWith('whsec_'))throw new Error('inbound_not_configured');
  const messageId=request.headers.get('svix-id'),stamp=request.headers.get('svix-timestamp'),signatures=request.headers.get('svix-signature');
  if(!messageId||messageId.length>200||!/^\d{1,12}$/.test(stamp||'')||Math.abs(now/1000-Number(stamp))>300||!signatures||signatures.length>2000)throw new Error('invalid_webhook_signature');
  const bytes=await inboundBytes(request,INBOUND_LIMITS.webhookBytes);const payload=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  const keyBytes=Uint8Array.from(atob(secret.slice(6)),c=>c.charCodeAt(0));
  const key=await crypto.subtle.importKey('raw',keyBytes,{name:'HMAC',hash:'SHA-256'},false,['verify']);
  let valid=false;
  for(const entry of signatures.split(' ')){const [version,signature]=entry.split(',');if(version!=='v1'||!signature)continue;try{if(await crypto.subtle.verify('HMAC',key,Uint8Array.from(atob(signature),c=>c.charCodeAt(0)),inboundEncoder.encode(`${messageId}.${stamp}.${payload}`)))valid=true;}catch{}}
  if(!valid)throw new Error('invalid_webhook_signature');
  const event=JSON.parse(payload);return {event,messageId};
}
export function resendInboundProvider(env){
  async function api(path,signal){const response=await fetch(`https://api.resend.com${path}`,{headers:{Authorization:`Bearer ${env.RESEND_INBOUND_API_KEY}`},signal});if(!response.ok)throw new Error('inbound_provider_unavailable');return JSON.parse(new TextDecoder().decode(await inboundBytes(response,INBOUND_LIMITS.providerBytes)));}
  return {
    getEmail:(emailId,signal)=>api(`/emails/receiving/${encodeURIComponent(emailId)}`,signal),
    getAttachments:async(emailId,signal)=>{const result=await api(`/emails/receiving/${encodeURIComponent(emailId)}/attachments`,signal);return {items:result.data,hasMore:!!result.has_more};},
    async download(attachment,signal){const url=new URL(attachment.download_url);if(url.protocol!=='https:'||url.username||url.password||!(url.hostname==='inbound-cdn.resend.com'||url.hostname.endsWith('.resend.com')))throw new Error('inbound_unsafe_download');const response=await fetch(url,{signal,redirect:'error'});if(!response.ok)throw new Error('inbound_attachment_unavailable');return inboundBytes(response,INBOUND_LIMITS.fileBytes);},
  };
}
export async function readInboundSettings(db,org,userId,env,now){
  const row=await db.first('SELECT * FROM organization_inbound_settings WHERE organization_id=?',org.id);const team=await organizationTeam(db,org,userId,now);
  return {available:inboundAvailable(env),enabled:!!row?.enabled,address:inboundAddress(env,row),revision:row?.revision||0,
    allowedSenders:JSON.parse(row?.allowed_senders_json||'[]'),
    members:team.members.filter(m=>m.status==='active').map(m=>({email:m.email,name:m.name||m.email,allowed:true})),
    limits:{attachmentMB:10,totalAttachmentMB:20,maxAttachments:10},
    recent:org.owner_id===userId?await db.all(`SELECT m.id,m.sender,m.subject,m.status,m.reason,m.task_id AS taskId,m.created_at AS createdAt,
      n.status AS rejectionNoticeStatus,n.reason AS rejectionNoticeReason,n.sent_at AS rejectionNoticeSentAt
      FROM inbound_messages m LEFT JOIN inbound_rejection_notices n ON n.inbound_message_id=m.id
      WHERE m.organization_id=? ORDER BY m.created_at DESC LIMIT 20`,org.id):[],
  };
}
function inboundAllowedSql(){return `(
  EXISTS(SELECT 1 FROM users u JOIN organizations o ON o.owner_id=u.id WHERE o.id=s.organization_id AND u.email=?) OR
  EXISTS(SELECT 1 FROM organization_members m WHERE m.organization_id=s.organization_id AND m.email=? AND m.status='active') OR
  EXISTS(SELECT 1 FROM json_each(s.allowed_senders_json) WHERE value=?))`;}
async function inboundAllowed(db,orgId,sender){return !!await db.first(`SELECT s.organization_id FROM organization_inbound_settings s WHERE s.organization_id=? AND s.enabled=1 AND ${inboundAllowedSql()}`,orgId,sender,sender,sender);}
export async function handleInboundApi(request,env,{db,user,now,fail,json,body}){
  const route=new URL(request.url).pathname.match(/^\/api\/organizations\/([a-f0-9-]{36})\/settings\/inbound(?:\/emails\/([a-f0-9-]{36}))?$/);if(!route)return null;
  const org=await organizationAccess(db,route[1],user);if(!org)fail(404,'organization_not_found','Organisationen findes ikke, eller du har ikke adgang.');
  if(route[2]&&request.method==='GET'){
    const message=await db.first("SELECT content_json,task_id FROM inbound_messages WHERE organization_id=? AND provider_email_id=? AND status='accepted'",org.id,route[2]);
    if(!message)fail(404,'email_not_found','Mailen findes ikke i organisationen.');return json({email:JSON.parse(message.content_json),taskId:message.task_id});
  }
  if(!route[2]&&request.method==='GET')return json(await readInboundSettings(db,org,user.id,env,now));
  if(route[2]||request.method!=='PUT')fail(405,'method_not_allowed','Handlingen understøttes ikke.');
  if(user.id!==org.owner_id)fail(403,'owner_required','Kun administratoren kan ændre organisationens mailindgang.');
  const input=await body(request,180000);if(typeof input.enabled!=='boolean'||!Number.isSafeInteger(input.revision)||input.revision<0)fail(400,'invalid_inbound_settings','Angiv indstilling og seneste revision.');
  if(input.enabled&&!inboundAvailable(env))fail(503,'inbound_not_configured','Mailindgangen er endnu ikke klar.');
  function addresses(values,max){if(!Array.isArray(values)||values.length>max)fail(400,'invalid_senders','Listen har for mange adresser.');const result=values.map(v=>inboundMailbox(v));if(result.some(v=>!v||v.includes('*')))fail(400,'invalid_senders','Skriv fulde, gyldige emailadresser. Domæner og jokertegn er ikke tilladt.');return [...new Set(result)];}
  const allowed=addresses(input.allowedSenders||[],100);const writeId=crypto.randomUUID(),alias=crypto.randomUUID().replaceAll('-','');
  const results=await db.batch([
    db.statement(`INSERT INTO organization_inbound_settings(organization_id,alias,enabled,allowed_senders_json,blocked_members_json,revision,write_id,updated_at)
      SELECT ?,?,?,?,'[]',1,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM organization_inbound_settings WHERE organization_id=?) ON CONFLICT(organization_id) DO UPDATE SET enabled=excluded.enabled,allowed_senders_json=excluded.allowed_senders_json,
      blocked_members_json=excluded.blocked_members_json,revision=organization_inbound_settings.revision+1,write_id=excluded.write_id,updated_at=excluded.updated_at
      WHERE organization_inbound_settings.revision=? RETURNING revision`,org.id,alias,input.enabled?1:0,JSON.stringify(allowed),writeId,now,input.revision,org.id,input.revision),
    db.statement('UPDATE organizations SET revision=revision+1,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM organization_inbound_settings WHERE organization_id=? AND write_id=?)',now,org.id,org.id,writeId),
  ]);
  if(!results[0].results?.[0])fail(409,'revision_conflict','Mailindstillingen er ændret. Hent den igen.');
  return json(await readInboundSettings(db,org,user.id,env,now));
}
function inboundPlainHtml(html){
  if(typeof html!=='string')return '';
  if(html.startsWith('data:text/html')){const comma=html.indexOf(',');try{html=html.slice(0,comma).includes(';base64')?new TextDecoder().decode(Uint8Array.from(atob(html.slice(comma+1)),c=>c.charCodeAt(0))):decodeURIComponent(html.slice(comma+1));}catch{return '';}}
  return html.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'').replace(/<(?:br\b[^>]*|\/(?:p|div|li|tr|h[1-6]))\s*>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_,entity)=>{const names={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};if(entity[0]!=='#')return names[entity.toLowerCase()]||'';const n=entity[1].toLowerCase()==='x'?parseInt(entity.slice(2),16):Number(entity.slice(1));return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';}).trim();
}
async function inboundFileId(value){const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',inboundEncoder.encode(value)));const hex=Array.from(hash,n=>n.toString(16).padStart(2,'0')).join('').slice(0,32);return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;}
async function inboundStageAttachments(db,env,orgId,emailId,mail,provider,signal,now){
  const warnings=[],files=[];const declared=Array.isArray(mail.attachments)?mail.attachments:[];if(!declared.length)return {files,warnings};
  if(!env.BUCKET)throw new Error('inbound_files_unavailable');
  const metadata=await provider.getAttachments(emailId,signal);const attachments=Array.isArray(metadata)?metadata:metadata?.items;if(!Array.isArray(attachments))throw new Error('inbound_attachment_metadata');
  if(metadata?.hasMore||attachments.length>INBOUND_LIMITS.attachments)warnings.push('Kun de første 10 vedhæftninger er gemt.');
  let remaining=INBOUND_LIMITS.totalFileBytes;
  // Bound cumulative memory and store each file before fetching the next.
  for(const a of attachments.slice(0,INBOUND_LIMITS.attachments)){
    if(!/^[a-f0-9-]{36}$/.test(a.id||''))throw new Error('inbound_attachment_metadata');
    const name=inboundShort(a.filename,160).replace(/[\\/\x00-\x1f]/g,'_')||'Vedhæftning';
    if(!Number.isSafeInteger(a.size)||a.size<0||a.size>INBOUND_LIMITS.fileBytes||a.size>remaining){warnings.push(`${name}: ikke gemt (fil- eller totalgrænse).`);continue;}
    const bytes=await provider.download(a,signal);if(!(bytes instanceof Uint8Array)||bytes.length>INBOUND_LIMITS.fileBytes||bytes.length>remaining)throw new Error('inbound_too_large');remaining-=bytes.length;
    const fileId=await inboundFileId(`${orgId}:${emailId}:${a.id}`),objectKey=`${orgId}/${fileId}`;
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));const sha256=Array.from(digest,n=>n.toString(16).padStart(2,'0')).join('');
    await env.BUCKET.put(objectKey,bytes,{httpMetadata:{contentType:'application/octet-stream'}});
    files.push({id:fileId,name,content_type:inboundShort(a.content_type,120)||'application/octet-stream',size_bytes:bytes.length,sha256,objectKey,
      description:`Vedhæftet mailen ${inboundShort(mail.subject,200)}.`,createdAt:now,reference:`[[file:${fileId}|${name.replace(/[\[\]|]/g,' ')}]]`});
  }
  return {files,warnings};
}
function mailHeader(mail,name){return Object.entries(mail.headers||{}).filter(([key])=>key.toLowerCase()===name).map(([,value])=>value);}
async function rejectionSafety(db,env,settings,row,mail){
  if(mail.id!==row.provider_email_id||inboundMailbox(mail.from)!==row.sender)return 'Afsenderen kunne ikke bekræftes.';
  const recipients=mail.received_for?.length?mail.received_for:[...(mail.to||[]),...(mail.bcc||[])];
  if(!recipients.map(inboundMailbox).includes(inboundAddress(env,settings)))return 'Leveringsadressen kunne ikke bekræftes.';
  const auto=mailHeader(mail,'auto-submitted'),suppress=mailHeader(mail,'x-auto-response-suppress'),precedence=mailHeader(mail,'precedence');
  if(auto.some(v=>typeof v!=='string'||v.trim().toLowerCase()!=='no')||suppress.some(v=>typeof v!=='string'||/all|autoreply/i.test(v))||precedence.some(v=>typeof v!=='string'||/bulk|list|junk/i.test(v))||mailHeader(mail,'list-id').length)return 'Automatisk mail eller mailingliste; der sendes ikke autosvar.';
  if(row.sender===inboundMailbox(env.EMAIL_FROM)||row.sender.endsWith(`@${inboundDomain(env)}`))return 'Autosvar til systemets egne adresser er slået fra.';
  const paths=mailHeader(mail,'return-path');
  // Reject duplicated/array-encoded headers and null reverse paths, even with DMARC pass.
  const path=paths.length===1&&typeof paths[0]==='string'&&/^(?:<[^<>\s]+>|[^<>\s]+)$/.test(paths[0].trim())?inboundMailbox(paths[0]):null;
  if(paths.length&&(!path||paths.length!==1))return 'Ugyldig eller tom returadresse; der sendes ikke autosvar.';
  if(mail.authentication?.dmarc==='pass')return null;
  // GRAY is not enough to import a task. Only reply to an already permitted address
  // with provider-confirmed SPF and one matching SMTP reverse path.
  if(mail.authentication?.dmarc==='gray'&&mail.authentication.spf==='pass'&&path===row.sender&&await db.first(`SELECT s.organization_id FROM organization_inbound_settings s WHERE s.organization_id=? AND ${inboundAllowedSql()}`,settings.organization_id,row.sender,row.sender,row.sender))return null;
  return 'Afsenderens domæne kunne ikke bekræftes sikkert; der sendes ikke autosvar.';
}
async function deliverRejection(db,env,settings,row,provider,now,signal,context,cachedMail){
  const existing=await db.first('SELECT * FROM inbound_rejection_notices WHERE inbound_message_id=?',row.id);
  if(!existing||!['pending','sending'].includes(existing.status))return;
  if(existing.first_attempt_at!==null&&now-existing.first_attempt_at>=23*3600000){
    if(existing.lease_until>now)throw new Error('inbound_notice_processing');
    await db.run("UPDATE inbound_rejection_notices SET status='failed',reason=?,lease_until=0,updated_at=? WHERE id=? AND lease_until<=? AND status IN ('pending','sending')",'Afsendelsen kunne ikke bekræftes inden genforsøgsvinduet.',now,existing.id,now);return;
  }
  const leaseId=crypto.randomUUID();const notice=await db.first(`UPDATE inbound_rejection_notices SET status='sending',lease_id=?,lease_until=?,updated_at=?
    WHERE id=? AND (status='pending' OR (status='sending' AND lease_until<=?)) RETURNING *`,leaseId,now+60000,now,existing.id,now);
  if(!notice)throw new Error('inbound_notice_processing');
  const suppress=async reason=>db.run("UPDATE inbound_rejection_notices SET status='suppressed',reason=?,lease_until=0,updated_at=? WHERE id=? AND lease_id=?",reason,now,notice.id,leaseId);
  try{
    let payload;
    if(notice.payload_json)payload=JSON.parse(notice.payload_json);
    else{
      const mail=cachedMail||await provider.getEmail(row.provider_email_id,signal);const unsafe=await rejectionSafety(db,env,settings,row,mail);
      if(unsafe){await suppress(unsafe);return;}
      try{
        await context.limit(db,`inbound-notice-sender:${await context.sign(env,row.sender)}`,5,3600,now);
        await context.limit(db,`inbound-notice-org:${settings.organization_id}`,20,3600,now);
        await context.limit(db,'inbound-notice-site',100,86400,now);
      }catch(error){if(error.code!=='rate_limited')throw error;await suppress('Grænsen for automatiske afvisningsmails er nået.');return;}
      payload=inboundRejectionEmail(env,{sender:row.sender,subject:mail.subject,reason:row.reason,authentication:mail.authentication,messageId:mail.message_id});
      await db.run('UPDATE inbound_rejection_notices SET payload_json=?,first_attempt_at=?,updated_at=? WHERE id=? AND lease_id=?',JSON.stringify(payload),now,now,notice.id,leaseId);
    }
    const sent=await context.sendRejection(env,payload,`finch-inbound-rejection-${notice.id}`);
    if(typeof sent?.id!=='string'||!sent.id)throw new Error('inbound_notice_response');
    await db.run("UPDATE inbound_rejection_notices SET status='sent',reason='',provider_message_id=?,sent_at=?,lease_until=0,updated_at=? WHERE id=? AND lease_id=?",sent.id,now,now,notice.id,leaseId);
  }catch(error){await db.run("UPDATE inbound_rejection_notices SET status='pending',reason=?,lease_until=0,updated_at=? WHERE id=? AND lease_id=?",'Afvisningsmailen afventer genforsøg fra Resend.',now,notice.id,leaseId);throw error;}
}
async function inboundImport(db,env,settings,event,messageId,provider,now,signal,context){
  const emailId=event.data.email_id;const sender=inboundMailbox(event.data.from);if(!sender)return;
  const leaseId=crypto.randomUUID();
  const row=await db.first(`INSERT INTO inbound_messages(id,organization_id,provider_email_id,webhook_id,sender,subject,status,lease_id,lease_until,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'processing',?,?,?,?) ON CONFLICT(organization_id,provider_email_id) DO UPDATE SET lease_id=excluded.lease_id,lease_until=excluded.lease_until,status='processing',updated_at=excluded.updated_at
    WHERE inbound_messages.status='failed' OR (inbound_messages.status='processing' AND inbound_messages.lease_until<=?) RETURNING *`,
    crypto.randomUUID(),settings.organization_id,emailId,messageId,sender,inboundShort(event.data.subject,200),leaseId,now+60000,now,now,now);
  if(!row){const existing=await db.first('SELECT * FROM inbound_messages WHERE organization_id=? AND provider_email_id=?',settings.organization_id,emailId);if(existing?.status==='processing')throw new Error('inbound_processing');if(existing?.status==='rejected')await deliverRejection(db,env,settings,existing,provider,now,signal,context);return;}
  let mail;
  const reject=async reason=>{
    const results=await db.batch([
      db.statement("INSERT INTO inbound_rejection_notices(id,inbound_message_id,created_at,updated_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM inbound_messages WHERE id=? AND lease_id=? AND status='processing') ON CONFLICT(inbound_message_id) DO NOTHING",crypto.randomUUID(),row.id,now,now,row.id,row.lease_id),
      db.statement("UPDATE inbound_messages SET status='rejected',reason=?,lease_until=0,updated_at=? WHERE id=? AND lease_id=? AND status='processing' RETURNING *",reason,now,row.id,row.lease_id),
    ]);
    const rejected=results[1].results?.[0];
    if(!rejected)return;
    await deliverRejection(db,env,settings,rejected,provider,now,signal,context,mail);
  };
  try{
    if(!settings.enabled){await reject('Mailindgangen er slået fra.');return;}
    if(!await inboundAllowed(db,settings.organization_id,sender)){await reject('Afsenderadressen er ikke tilladt.');return;}
    mail=await provider.getEmail(emailId,signal);
    if(mail.id!==emailId||inboundMailbox(mail.from)!==sender){await reject('Mailens afsenderoplysninger stemmer ikke overens.');return;}
    if(mail.authentication?.dmarc!=='pass'){await reject('Afsenderens domæne kunne ikke bekræftes (DMARC).');return;}
    const recipients=(mail.received_for?.length?mail.received_for:[...(mail.to||[]),...(mail.bcc||[])]).map(inboundMailbox).filter(Boolean);
    if(!recipients.includes(inboundAddress(env,settings))){await reject('Mailen er ikke leveret til denne organisations adresse.');return;}
    const body=typeof mail.text==='string'&&mail.text.trim()?mail.text:inboundPlainHtml(mail.html);
    const attachments=await inboundStageAttachments(db,env,settings.organization_id,emailId,mail,provider,signal,now);
    if(body.length>INBOUND_LIMITS.textChars)attachments.warnings.push('Mailteksten er forkortet til 100.000 tegn.');
    const content={id:emailId,from:inboundShort(mail.from,600),sender,to:recipients,subject:inboundShort(mail.subject,1000),text:body.slice(0,INBOUND_LIMITS.textChars),
      receivedAt:mail.created_at,messageId:inboundShort(mail.message_id,500),authentication:{spf:mail.authentication.spf,dkim:mail.authentication.dkim,dmarc:'pass'},
      attachments:attachments.files.map(({objectKey,description,createdAt,...f})=>f),warnings:attachments.warnings};
    for(let attempt=0;attempt<4;attempt++){
      const org=await db.first('SELECT * FROM organizations WHERE id=?',settings.organization_id);const state=JSON.parse(org.state_json);
      if(state.tasks.length>=5000)throw new Error('inbound_workspace_full');
      let seq=Number.isSafeInteger(state.seq)?state.seq:0;let taskId;do{taskId=`S-${200+(++seq)}`;}while(state.tasks.some(t=>t.id===taskId));state.seq=seq;
      const stamp=new Date(now).toLocaleTimeString('da-DK',{timeZone:'Europe/Copenhagen',hour:'2-digit',minute:'2-digit'}).replace('.',':');
      const task={id:taskId,kind:'case',phase:'active',agentWorkStatus:'queued',from:state.agent||'Agenten',title:inboundShort(content.subject,80)||'Opgave fra mail',tag:'Mail',time:stamp,at:now,createdAt:now,
        preview:`Fra ${sender}`,ui:[],values:{},draft:{},updates:[],read:false,progress:0,inboundEmail:{id:emailId,sender,receivedAt:content.receivedAt,attachments:content.attachments,warnings:content.warnings},
        emails:[{direction:'in',from:content.from,to:inboundAddress(env,settings),subject:content.subject,body:content.text,at:Date.parse(mail.created_at)||now,inbound:true}]};
      state.tasks.push(task);state.events.push({id:`E-${crypto.randomUUID()}`,type:'inbound_email_received',caseId:taskId,at:now,delivered:false,detail:{email_id:emailId,sender}});state.events=state.events.slice(-100);
      state._workWriteId=crypto.randomUUID();const serialized=JSON.stringify(state);if(inboundEncoder.encode(serialized).length>INBOUND_LIMITS.stateBytes)throw new Error('inbound_workspace_full');
      const guard='EXISTS(SELECT 1 FROM organizations WHERE id=? AND revision=? AND state_json=?)';const guardValues=[org.id,org.revision+1,serialized];
      const results=await db.batch([
        db.statement(`UPDATE organizations SET state_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?
          AND EXISTS(SELECT 1 FROM inbound_messages WHERE id=? AND lease_id=? AND status='processing')
          AND EXISTS(SELECT 1 FROM organization_inbound_settings s WHERE s.organization_id=? AND s.revision=? AND s.enabled=1 AND ${inboundAllowedSql()}) RETURNING revision`,
          serialized,now,org.id,org.revision,row.id,leaseId,org.id,settings.revision,sender,sender,sender),
        ...attachments.files.map(f=>db.statement(`INSERT INTO stored_files(id,organization_id,name,description,content_type,size_bytes,sha256,object_key,source_url,created_at,updated_at)
          SELECT ?,?,?,?,?,?,?,?,'',?,? WHERE ${guard} ON CONFLICT(id) DO NOTHING`,f.id,org.id,f.name,f.description,f.content_type,f.size_bytes,f.sha256,f.objectKey,now,now,...guardValues)),
        db.statement(`INSERT INTO task_assignments(organization_id,task_id,assignee_id,reason,basis_json,updated_by,updated_at)
          SELECT ?,?,?,'Oprettet fra en tilladt mail. Administratoren modtager sagen, indtil agenten fordeler arbejdet efter grafens ansvar.','[]',?,? WHERE ${guard}`,org.id,taskId,org.owner_id,org.owner_id,now,...guardValues),
        db.statement(`UPDATE inbound_messages SET status='accepted',reason='',task_id=?,content_json=?,lease_until=0,updated_at=? WHERE id=? AND lease_id=? AND ${guard}`,
          taskId,JSON.stringify(content),now,row.id,leaseId,...guardValues),
      ]);
      if(results[0].results?.[0])return;
      const current=await db.first('SELECT enabled,revision FROM organization_inbound_settings WHERE organization_id=?',org.id);
      if(!current?.enabled||current.revision!==settings.revision||!await inboundAllowed(db,org.id,sender)){await reject('Mailindstillingen eller afsenderens adgang er ændret.',now);return;}
    }
    throw new Error('inbound_workspace_conflict');
  }catch(error){await db.run("UPDATE inbound_messages SET status='failed',reason=?,lease_until=0,updated_at=? WHERE id=? AND lease_id=? AND status='processing'",error.message==='inbound_workspace_full'?'Organisationens arbejdsrum er fuldt.':'Mailen afventer genforsøg fra Resend.',Date.now(),row.id,leaseId);throw error;}
}
export async function handleInboundWebhook(request,env,{db,now,fail,json,provider,sendRejection,limit,sign}){
  if(request.method!=='POST')fail(405,'method_not_allowed','Forventede POST.');
  if(!inboundAvailable(env))fail(503,'inbound_not_configured','Mailindgangen er endnu ikke klar.');
  let verified;try{verified=await verifyInboundWebhook(request,env.RESEND_WEBHOOK_SECRET,now);}catch(error){fail(error.message==='inbound_too_large'?413:401,'invalid_webhook','Ugyldig mailhændelse.');}
  const {event,messageId}=verified;if(event.type!=='email.received')return json({ok:true});
  if(!/^[a-f0-9-]{36}$/.test(event.data?.email_id||'')||!Array.isArray(event.data.to)||event.data.to.length>100)fail(400,'invalid_email_event','Ugyldig mailhændelse.');
  const aliases=[...new Set([...event.data.to,...(Array.isArray(event.data.bcc)?event.data.bcc:[])].map(inboundMailbox).filter(Boolean).filter(e=>e.endsWith(`@${inboundDomain(env)}`)).map(e=>e.split('@')[0]).filter(e=>/^org-[a-f0-9]{32}$/.test(e)).map(e=>e.slice(4)))];
  if(aliases.length>10)fail(400,'too_many_recipients','For mange organisationsadresser.');
  const signal=AbortSignal.timeout(12000);const transport=provider||resendInboundProvider(env);
  for(const alias of aliases){const settings=await db.first('SELECT * FROM organization_inbound_settings WHERE alias=?',alias);if(settings)await inboundImport(db,env,settings,event,messageId,transport,now,signal,{sendRejection,limit,sign});}
  return json({ok:true});
}
