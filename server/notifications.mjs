import {organizationAccess,accessibleOrganizations} from './team.mjs';
import {projectWork,effectiveAssignee,workPhase} from './work.mjs';

// Reuse authoritative routing and phase rules; inbox read markers on questions
// are not completion, and the shared agent queue does not need a human alert.
export async function notificationInbox(db,org,user,now){
  const projected=await projectWork(db,org,JSON.parse(org.state_json),user,now);
  return Promise.all(projected.state.tasks.filter(t=>effectiveAssignee(t,projected.work)===user.id&&workPhase(t)==='open').map(async t=>{
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([t.at||0,t.assignmentRevision||0,t.title||'',t.ui||null,t.body||''])));
    return {id:t.id,stamp:Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('')};
  }));
}
const notificationCursor=items=>JSON.stringify(Object.fromEntries(items.map(t=>[t.id,t.stamp])));
export async function handleNotificationApi(request,env,{db,user,now,fail,json,body}){
  const path=new URL(request.url).pathname;
  const settings=path.match(/^\/api\/organizations\/([a-f0-9-]{36})\/notifications$/);
  if(settings){
    const org=await organizationAccess(db,settings[1],user);if(!org)fail(404,'organization_not_found','Organisationen findes ikke, eller du har ikke adgang.');
    if(request.method==='PUT'){
      const input=await body(request);if(typeof input.enabled!=='boolean')fail(400,'invalid_notification_setting','Vælg om notifikationer er slået til.');
      const waiting=notificationCursor(await notificationInbox(db,org,user,now));
      await db.run(`INSERT INTO notification_preferences(user_id,organization_id,enabled,waiting_json,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(user_id,organization_id) DO UPDATE SET enabled=excluded.enabled,waiting_json=excluded.waiting_json,revision=notification_preferences.revision+1,updated_at=excluded.updated_at`,user.id,org.id,Number(input.enabled),waiting,now);
      return json({enabled:input.enabled});
    }
    if(request.method==='GET'){const row=await db.first('SELECT enabled FROM notification_preferences WHERE user_id=? AND organization_id=?',user.id,org.id);return json({enabled:!!row?.enabled});}
    fail(405,'method_not_allowed','Metoden understøttes ikke.');
  }
  if(path!=='/api/notifications')return null;
  if(!['GET','POST'].includes(request.method))fail(405,'method_not_allowed','Metoden understøttes ikke.');
  if(request.method==='POST')await body(request);
  const organizations=await accessibleOrganizations(db,user);const result=[];
  for(const summary of organizations){
    const org=await organizationAccess(db,summary.id,user);if(!org)continue;
    const items=await notificationInbox(db,org,user,now);
    const pref=await db.first('SELECT * FROM notification_preferences WHERE user_id=? AND organization_id=?',user.id,org.id);
    let fresh=[];
    if(request.method==='POST'&&pref?.enabled){
      const previous=JSON.parse(pref.waiting_json);const cursor=notificationCursor(items);
      fresh=items.filter(t=>previous[t.id]!==t.stamp);
      if(cursor!==pref.waiting_json){
        // Only one concurrent tab claims a batch. Retry on its next poll if it lost.
        const claim=await db.first(`UPDATE notification_preferences SET waiting_json=?,revision=revision+1,updated_at=?
          WHERE user_id=? AND organization_id=? AND enabled=1 AND revision=?
          AND EXISTS(SELECT 1 FROM organizations o WHERE o.id=? AND o.revision=? AND (o.owner_id=? OR EXISTS(SELECT 1 FROM organization_members m WHERE m.organization_id=o.id AND m.user_id=? AND m.status='active')))
          RETURNING revision`,cursor,now,user.id,org.id,pref.revision,org.id,org.revision,user.id,user.id);
        if(!claim)fresh=[];
      }
    }
    result.push({id:org.id,name:org.name,enabled:!!pref?.enabled,count:items.length,waitingIds:items.map(t=>t.id),newTaskIds:fresh.map(t=>t.id)});
  }
  return json({organizations:result});
}
