import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const demos=path.resolve(here,'..');
const read=async name=>{
  const target=path.resolve(here,name);
  if(!target.startsWith(demos+path.sep))throw new Error('Resource outside demos: '+name);
  return fs.readFile(target,'utf8');
};
const source=await read('index.html');
const scene='data:image/png;base64,'+(await fs.readFile(path.join(demos,'frontend-lab/assets/game-scene.png'))).toString('base64');
const roomArcs='data:image/png;base64,'+(await fs.readFile(path.join(demos,'frontend-lab/assets/room-arcs-v1.png'))).toString('base64');
const tableArc='data:image/png;base64,'+(await fs.readFile(path.join(demos,'frontend-lab/assets/table-arc-v1.png'))).toString('base64');
const screenIllustration='data:image/png;base64,'+(await fs.readFile(path.join(demos,'frontend-lab/assets/screen-illustration-v3.png'))).toString('base64');
const pattern=/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?>|<script\s+src="([^"]+)"\s*>\s*<\/script\s*>/gi;
let output='',previous=0;
for(const match of source.matchAll(pattern)){
  output+=source.slice(previous,match.index);
  let text=await read(match[1]||match[2]);
  if(match[1]){
    text=text.split('../assets/room-arcs-v1.png').join(roomArcs).split('../assets/table-arc-v1.png').join(tableArc).split('../assets/screen-illustration-v3.png').join(screenIllustration);
    if(/@import\b|url\s*\(/i.test(text.replace(/url\("data:image\/png;base64,[A-Za-z0-9+/=]+"\)/g,'')))throw new Error('External CSS resource');
    output+='<style>\n'+text+'\n</style>';
  }else{
    if(/\b(?:fetch|WebSocket|XMLHttpRequest|EventSource|sendBeacon)\s*\(/.test(text))throw new Error('Network operation in prototype');
    output+='<script>\n'+text.split('assets/game-scene.png').join(scene).replace(/<\/script/gi,'<\\/script')+'\n</script>';
  }
  previous=match.index+match[0].length;
}
output+=source.slice(previous);
const license=await fs.readFile(path.join(demos,'frontend-lab/assets/PHOSPHOR-LICENSE.txt'),'utf8');
output=output.replace('</head>','<!-- Phosphor Icons license\n'+license+'\n-->\n</head>');
const target=path.join(demos,'下一版体验.html');
await fs.writeFile(target,output,'utf8');
console.log('Built '+target);
