async function mailDeliveryError(response,kind){
  const result=await response.json().catch(()=>null);
  const known=['validation_error','invalid_api_key','restricted_api_key','not_found','rate_limit_exceeded','daily_quota_exceeded','monthly_quota_exceeded'];
  // Never log request bodies, recipients, codes, keys or the provider's free text.
  console.error('finch_mail_delivery_failed',{kind,status:response.status,provider_error:known.includes(result?.name)?result.name:'unavailable'});
  const label=kind==='rejection'?'Rejection':kind==='invitation'?'Invitation':'Email';
  throw new Error(`${label} delivery failed (${response.status}).`);
}
export function inboundRejectionEmail(env,{sender,subject,reason,authentication={},messageId}){
  const clean=value=>String(value||'').replace(/[\r\n\x00]/g,' ').slice(0,200);
  let next='Kontakt administratoren for mailindgangen, eller prøv igen med en anden afsenderadresse.';
  if(reason.includes('ikke tilladt')||reason.includes('adgang er ændret'))next='Bed organisationens administrator om at tillade din afsenderadresse under Opgaver via email, og send derefter mailen igen.';
  else if(reason.includes('slået fra'))next='Bed organisationens administrator om at slå Opgaver via email til, og send derefter mailen igen.';
  else if(reason.includes('DMARC'))next='Finch kræver i øjeblikket DMARC-resultatet pass for at oprette en opgave. Bed din mailadministrator kontrollere afsenderdomænets mailopsætning, eller brug en anden afsenderadresse.';
  const verdict=value=>['pass','fail','gray','none','processing_failed'].includes(value)?value:'ukendt';
  const auth=reason.includes('DMARC')?`\nKontrolresultater: SPF ${verdict(authentication.spf)}, DKIM ${verdict(authentication.dkim)}, DMARC ${verdict(authentication.dmarc)}.\n`:'';
  const headers={'Auto-Submitted':'auto-replied','X-Auto-Response-Suppress':'All'};
  if(typeof messageId==='string'&&/^<[^<>\s]{1,250}>$/.test(messageId)){headers['In-Reply-To']=messageId;headers.References=messageId;}
  return {from:env.EMAIL_FROM,to:[sender],subject:`Finch: Opgaven kunne ikke oprettes — ${clean(subject)||'uden emne'}`,
    text:`Din mail med emnet "${clean(subject)||'uden emne'}" blev modtaget, men Finch kunne ikke oprette en arbejdsopgave ved mailindgangen.\n\nÅrsag: ${clean(reason)}\n${auth}\n${next}\n\nDette er en automatisk afvisningsbesked. Der er ikke oprettet en opgave fra denne mail.`,headers};
}
export async function sendInboundRejection(env,payload,idempotencyKey){
  if(!env.RESEND_API_KEY||!env.EMAIL_FROM)throw new Error('Email delivery is not configured.');
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':idempotencyKey},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)});
  if(!response.ok)await mailDeliveryError(response,'rejection');
  const result=await response.json();if(typeof result.id!=='string'||!result.id)throw new Error('Rejection delivery response invalid.');return result;
}

export async function sendLoginCode(env, { email, code, challengeId }) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new Error('Email delivery is not configured.');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `finch-login-${challengeId}`,
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [email],
      subject: 'Din login-kode til Finch',
      text: `Din login-kode er ${code}.\n\nKoden gælder i 10 minutter og kan bruges én gang. Indtast den i den browser, hvor du bad om den.\n\nHvis du ikke har bedt om koden, kan du ignorere denne email.`,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) await mailDeliveryError(response,'login');
}

export async function sendOrganizationInvitation(env,{email,organizationName,inviteId,inviteUrl,revision}) {
  if(!env.RESEND_API_KEY || !env.EMAIL_FROM)throw new Error('Email delivery is not configured.');
  const response=await fetch('https://api.resend.com/emails',{
    method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`finch-invite-${inviteId}-${revision}`},
    body:JSON.stringify({from:env.EMAIL_FROM,to:[email],subject:`Invitation til ${organizationName} i Finch`,
      text:`Du er inviteret til ${organizationName} i Finch.\n\nÅbn ${inviteUrl}\n\nAcceptér invitationen på siden uden login. Du får en kvittering og en prompt til at fortsætte i Codex eller Claude. Når du åbner organisationens arbejde dér, logger du ind med ${email}.\n\nLinket gælder i 7 dage og er personligt. Del det ikke med andre. Hvis du ikke ønsker at deltage, kan du ignorere eller afvise invitationen.`}),
    signal:AbortSignal.timeout(10000),
  });
  if(!response.ok)await mailDeliveryError(response,'invitation');
}
