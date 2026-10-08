import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const out=path.resolve('assets/dashboard');await mkdir(out,{recursive:true});
for(const [source,target] of [
 ['echarts/dist/echarts.min.js','echarts.min.js'],['echarts/LICENSE','ECHARTS-LICENSE'],['echarts/NOTICE','ECHARTS-NOTICE'],
 ['tabulator-tables/dist/js/tabulator.min.js','tabulator.min.js'],['tabulator-tables/dist/css/tabulator.min.css','tabulator.min.css'],['tabulator-tables/LICENSE','TABULATOR-LICENSE'],
])await copyFile(path.resolve('node_modules',source),path.join(out,target));
await writeFile(path.join(out,'tabulator-style.js'),'globalThis.FinchTabulatorCss='+JSON.stringify(await readFile(path.join(out,'tabulator.min.css'),'utf8'))+';\n');
console.log('Dashboard libraries copied from the locked npm dependencies.');
