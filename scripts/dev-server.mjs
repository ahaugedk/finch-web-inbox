import http from 'node:http';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { sqliteD1 } from './sqlite-d1.mjs';
import { handleApi } from '../server/api.mjs';
import { localR2 } from './local-r2.mjs';

const root = process.cwd(); await mkdir('.dev-data', { recursive: true });
const db = sqliteD1('.dev-data/finch.sqlite');
db.sqlite.exec('CREATE TABLE IF NOT EXISTS _dev_migrations (name TEXT PRIMARY KEY)');
for (const file of (await readdir('drizzle')).filter((f) => f.endsWith('.sql')).sort()) {
  if (!db.sqlite.prepare('SELECT name FROM _dev_migrations WHERE name = ?').get(file)) {
    db.sqlite.exec(await readFile(`drizzle/${file}`, 'utf8'));
    db.sqlite.prepare('INSERT INTO _dev_migrations (name) VALUES (?)').run(file);
  }
}
const env = { DB: db, AUTH_SECRET: process.env.AUTH_SECRET || 'local-development-secret-not-for-production', RESEND_API_KEY: process.env.RESEND_API_KEY, EMAIL_FROM: process.env.EMAIL_FROM, INBOUND_EMAIL_DOMAIN:process.env.INBOUND_EMAIL_DOMAIN, RESEND_INBOUND_API_KEY:process.env.RESEND_INBOUND_API_KEY, PUBLIC_ORIGIN:process.env.PUBLIC_ORIGIN, RESEND_WEBHOOK_SECRET:process.env.RESEND_WEBHOOK_SECRET };
env.BUCKET = localR2(path.join(root, '.dev-data/files'));
const dependencies = env.RESEND_API_KEY ? {} : { sendMail: async (_, { email, code }) => console.log(`[LOCAL ONLY] Login code for ${email}: ${code}`),sendInvitation:async(_, {email,organizationName,inviteUrl})=>console.log(`[LOCAL ONLY] Invitation for ${email} to ${organizationName}: ${inviteUrl}`),sendInboundRejection:async(_,payload)=>{console.log(`[LOCAL ONLY] Rejection notice to ${payload.to[0]}: ${payload.subject}`);return {id:'local-only'};} };
const dashboardLibraryFiles=['echarts.min.js','tabulator.min.js','tabulator.min.css'];
const dashboardLibrarySource=await Promise.all(dashboardLibraryFiles.map(file=>readFile(path.join(root,'assets/dashboard',file),'utf8')));
dependencies.dashboardLibraries=async()=>({scripts:dashboardLibrarySource.slice(0,2),css:dashboardLibrarySource[2]});
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs':'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
http.createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url, incoming.headers.host==='localhost:8787'?'http://localhost:8787':'http://127.0.0.1:8787');
    if (url.pathname.startsWith('/api/')) {
      const bytes = []; let size = 0;
      for await (const chunk of incoming) { size += chunk.length; if (size > 10 * 1024 * 1024 + 4096) throw new Error('Request too large'); bytes.push(chunk); }
      const request = new Request(url, { method: incoming.method, headers: incoming.headers, ...(!['GET', 'HEAD'].includes(incoming.method) ? { body: Buffer.concat(bytes) } : {}) });
      const response = await handleApi(request, env, dependencies);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer())); return;
    }
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
    if (!['index.html', 'app.js', 'storage.js', 'file-model.js', 'file-media.js', 'list-ui.js','grid-ui.js','table-editor.js','data.js','data-controls.js', 'pages.js', 'brand-model.js', 'branding.js', 'settings.js','settings-grids.js', 'work.js', 'notifications.js', 'notification-sw.js', 'onboarding.js', 'content.js','site-config.js','connection.js','invitations.js', 'styles.css'].includes(relative) && !/^assets\/(?:fonts|pdfjs|dashboard)\/[a-z0-9.-]+$/.test(relative)) {
      outgoing.writeHead(404); outgoing.end('Not found'); return;
    }
    const data = await readFile(path.join(root, relative));
    outgoing.writeHead(200, { 'Content-Type': types[path.extname(relative)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); outgoing.end(data);
  } catch { outgoing.writeHead(503); outgoing.end('Unavailable'); }
}).listen(8787, '127.0.0.1', () => console.log('Finch preview: http://127.0.0.1:8787 (local SQLite; test login codes appear only in this terminal)'));
