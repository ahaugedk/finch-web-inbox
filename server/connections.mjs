// A short-lived UI rendezvous, never an account/session or organization access token.
export async function handleConnectionApi(request,env,ctx){
  const {db,now,fail,json,body,id,limit,sign}=ctx,url=new URL(request.url);
  if(url.pathname==='/api/connections'&&request.method==='POST'){
    const ip=request.headers.get('CF-Connecting-IP')||'unknown';await limit(db,`connection-ip:${await sign(env,ip)}`,30,3600,now);
    await db.run('DELETE FROM agent_connections WHERE expires_at<=?',now);
    const connectionId=id(),expiresAt=now+30*60*1000;await db.run('INSERT INTO agent_connections(id,created_at,expires_at) VALUES(?,?,?)',connectionId,now,expiresAt);
    return json({id:connectionId,status:'waiting',agent:null,expires_at:expiresAt},201);
  }
  const match=url.pathname.match(/^\/api\/connections\/([a-f0-9-]{36})(\/start)?$/);if(!match)return null;
  const connection=await db.first('SELECT id,agent_name,expires_at FROM agent_connections WHERE id=? AND expires_at>?',match[1],now);if(!connection)fail(404,'connection_expired','Forbindelseslinket er udløbet. Kopiér en ny prompt fra siden.');
  if(match[2]&&request.method==='POST'){
    const input=await body(request),name=typeof input.agent_name==='string'?input.agent_name.trim().slice(0,40):'';if(!name)fail(400,'agent_name_required','Angiv agentens navn.');
    // Repeated starts are safe. The channel carries only an agent display name.
    await db.run('UPDATE agent_connections SET agent_name=?,connected_at=? WHERE id=? AND expires_at>?',name,now,connection.id,now);
    return json({id:connection.id,status:'connected',agent:name,expires_at:connection.expires_at});
  }
  if(!match[2]&&request.method==='GET')return json({id:connection.id,status:connection.agent_name?'connected':'waiting',agent:connection.agent_name||null,expires_at:connection.expires_at});
  fail(405,'method_not_allowed','Metoden understøttes ikke.');
}
