import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

// Evaluate actual production definitions without booting UI, login or persistence.
export function loadToolCatalog(){
  const context=vm.createContext({document:{addEventListener(){},getElementById(){return null;}},location:new URL('http://127.0.0.1/'),navigator:{},URL,URLSearchParams,crypto:webcrypto,console,TextEncoder,TextDecoder,structuredClone,addEventListener(){},FinchConnection:{}});
  context.window=context;
  for(const name of ['content.js','tool-catalog.js','file-model.js','brand-model.js','data-controls.js','data.js','pages.js','branding.js','work.js'])vm.runInContext(readFileSync(name,'utf8'),context,{filename:name});
  const app=readFileSync('app.js','utf8');
  vm.runInContext(app.slice(0,app.indexOf('  // Hvad agenten laver:'))+'\nwindow.testCatalog=toolCatalog;window.testTools=TOOLS;})();',context);
  return {catalog:context.testCatalog,tools:context.testTools,api:context.FinchToolCatalog,briefing:context.ORDERLY.BRIEFING};
}
