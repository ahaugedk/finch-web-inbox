import { readFile, readdir, mkdir, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const root = process.cwd();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const files = ['index.html', 'app.js', 'storage.js', 'file-model.js', 'file-media.js', 'list-ui.js','grid-ui.js','table-editor.js','data.js','data-controls.js', 'pages.js', 'brand-model.js', 'branding.js', 'settings.js','settings-grids.js', 'work.js', 'notifications.js', 'notification-sw.js', 'onboarding.js', 'content.js','site-config.js','connection.js','invitations.js', 'styles.css'];
async function collect(directory) {
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const filename = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await collect(filename); else if (entry.isFile()) files.push(filename);
  }
}
await collect('assets');
const assets = {};
for (const file of files) {const bytes=await readFile(path.join(root,file));const compressed=(file.startsWith('assets/pdfjs/')&&file.endsWith('.mjs'))||file.startsWith('assets/dashboard/');assets[`/${file}`]={type:types[path.extname(file)]||'application/octet-stream',bytes:(compressed?gzipSync(bytes):bytes).toString('base64'),...(compressed?{compressed:true}:{})};}
// Build one self-contained Worker so static assets don't depend on an unconfigured ASSETS binding.
let api = await readFile(path.join(root, 'server/api.mjs'), 'utf8');
api = api.replace(/^import .+;\n/gm, '');
const helpers = await Promise.all(['grid-ui.js','site-config.js','brand-model.js','file-model.js','data-controls.js','server/database.mjs', 'server/mail.mjs', 'server/data.mjs','server/data-work.mjs', 'server/pages.mjs','server/branding-assets.mjs','server/team.mjs','server/work.mjs','server/inbound.mjs','server/notifications.mjs','server/onboarding.mjs','server/page-files.mjs','server/page-runtime.mjs','server/connections.mjs'].map((p) => readFile(path.join(root, p), 'utf8')));
const worker = `${helpers.map(source=>source.replace(/^import .+;\n/gm,'')).join('\n')}\n${api}\nconst ASSETS = ${JSON.stringify(assets)};\nlet dashboardLibraryCache;\nasync function dashboardLibraries(){return dashboardLibraryCache ||= Promise.all(['/assets/dashboard/echarts.min.js','/assets/dashboard/tabulator.min.js','/assets/dashboard/tabulator.min.css'].map(async name=>{const asset=ASSETS[name],bytes=Uint8Array.from(atob(asset.bytes),c=>c.charCodeAt(0));return new Response(new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'))).text();})).then(parts=>({scripts:parts.slice(0,2),css:parts[2]}));}\n` + `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env,{dashboardLibraries});
    const redirect = globalThis.FinchSite.navigationRedirect(request, env.PUBLIC_ORIGIN);
    if (redirect) return new Response(null, {status: 302, headers: {Location: redirect, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'}});
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
    const asset = ASSETS[url.pathname === '/' ? '/index.html' : url.pathname];
    if (!asset) return new Response('Not found', { status: 404 });
    const bytes = Uint8Array.from(atob(asset.bytes), c => c.charCodeAt(0));
    const body=asset.compressed?new Response(bytes).body.pipeThrough(new DecompressionStream('gzip')):bytes;
    return new Response(request.method === 'HEAD' ? null : body, { headers: {
      'Content-Type': asset.type, 'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; font-src 'self' blob:; worker-src 'self' blob:; img-src 'self' data: blob:; media-src blob:; frame-src 'self' blob:; object-src 'none'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'"
    } });
  }
};
`;
await mkdir(path.join(root, 'dist/server'), { recursive: true });
await mkdir(path.join(root, 'dist/.openai'), { recursive: true });
await writeFile(path.join(root, 'dist/server/index.js'), worker);
const hosting = JSON.parse(await readFile(path.join(root, 'sites/orderly-agent/.openai/hosting.json'), 'utf8').catch(() => readFile(path.join(root, '.openai/hosting.json'), 'utf8')));
delete hosting.static; hosting.d1 = 'DB'; hosting.r2 = 'BUCKET';
await writeFile(path.join(root, 'dist/.openai/hosting.json'), JSON.stringify(hosting, null, 2) + '\n');
await cp(path.join(root, 'drizzle'), path.join(root, 'dist/.openai/drizzle'), { recursive: true });
console.log(`Built Worker with ${files.length} public assets and D1 migrations.`);
