// Notifications only: no fetch interception, cache or offline account data.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick',event=>{
  event.notification.close();const data=event.notification.data||{};
  if(!/^[a-f0-9-]{36}$/.test(data.orgId||''))return;
  event.waitUntil((async()=>{
    const tabs=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const url=new URL('/',self.location.origin);url.searchParams.set('org',data.orgId);
    if(data.taskId)url.searchParams.set('task',data.taskId);
    const tab=tabs.find(t=>new URL(t.url).searchParams.get('org')===data.orgId)||tabs[0];
    if(tab){await tab.focus();tab.postMessage({type:'finch-notification-open',...data});}
    else await self.clients.openWindow(url.href);
  })());
});
