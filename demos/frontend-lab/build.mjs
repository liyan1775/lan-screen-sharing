import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(root, '..', '前端设计实验室.html');
const readLocal = async (name, encoding = 'utf8') => {
  if (!/^[\w./-]+$/.test(name) || name.split('/').includes('..')) throw new Error(`不允许的资源路径：${name}`);
  return readFile(path.join(root, name), encoding);
};
const html = await readLocal('index.html');
const image = await readLocal('assets/game-scene.png', null);
const dataUrl = 'data:image/png;base64,' + image.toString('base64');
const roomArcs = 'data:image/png;base64,' + (await readLocal('assets/room-arcs-v1.png', null)).toString('base64');
const tableArc = 'data:image/png;base64,' + (await readLocal('assets/table-arc-v1.png', null)).toString('base64');
const screenIllustration = 'data:image/png;base64,' + (await readLocal('assets/screen-illustration-v3.png', null)).toString('base64');
const license = await readLocal('assets/PHOSPHOR-LICENSE.txt');
if (license.includes('-->')) throw new Error('许可证包含不能放进 HTML 注释的字符');

// Process matches in source order so the browser observes the original order.
const resourceTag = /<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?>|<script\s+src="([^"]+)"\s*>\s*<\/script\s*>/gi;
let result = '';
let previous = 0;
let imageReplacements = 0;
let match;
while ((match = resourceTag.exec(html))) {
  result += html.slice(previous, match.index);
  const name = match[1] || match[2];
  let content = await readLocal(name);
  if (match[1]) {
    content = content.split('../assets/room-arcs-v1.png').join(roomArcs).split('../assets/table-arc-v1.png').join(tableArc).split('../assets/screen-illustration-v3.png').join(screenIllustration);
    if (/@import\b|url\s*\(/i.test(content.replace(/url\("data:image\/png;base64,[A-Za-z0-9+/=]+"\)/g, ''))) throw new Error(`CSS 包含未内联的引用：${name}`);
    if (/<\/style/i.test(content)) throw new Error(`CSS 包含 style 结束标签：${name}`);
    result += `<style>\n${content}\n</style>`;
  } else {
    const original = content;
    content = content.split('assets/game-scene.png').join(dataUrl);
    if (content !== original) imageReplacements++;
    if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(/.test(content) || /\bimport\s*\(/.test(content)) throw new Error(`脚本包含网络或动态加载调用：${name}`);
    result += `<script>\n${content.replace(/<\/script/gi, '<\\/script')}\n</script>`;
  }
  previous = resourceTag.lastIndex;
}
result += html.slice(previous);
if (imageReplacements !== 1) throw new Error('脚本中未找到唯一的演示画面路径');
result = result.replace('</head>', `<!-- Phosphor Icons license\n${license}\n-->\n</head>`);
// Examine actual document tags, excluding script/style bodies and comments.
const documentTags = result.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
if (/<(?:link|script|img|iframe|audio|video|source)\b[^>]*\b(?:src|href)\s*=/i.test(documentTags) || /<link\b/i.test(documentTags)) throw new Error('生成文档仍包含外部资源标签');
if (/assets\/game-scene\.png/.test(result)) throw new Error('生成文档仍包含相对图片路径');
await writeFile(output, result, 'utf8');
console.log(`已生成 ${output}；CSS 和脚本已按原顺序内联，演示图片已嵌入。`);
