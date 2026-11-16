// 単一HTML版を作る：今の画面（../frontend/）をそのまま使い、計算エンジン（src/）とWASMを1つのHTMLに埋め込む
//   npm install → npm run build → dist/KONTENT.html
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FE = path.join(HERE, '..', 'frontend');
const b64 = (p) => fs.readFileSync(p).toString('base64');
fs.writeFileSync(path.join(HERE, 'src/wasm_data.js'),
  `export const WEBIFC_WASM = "${b64(path.join(HERE, 'node_modules/web-ifc/web-ifc.wasm'))}";\n` +
  `export const MANIFOLD_WASM = "${b64(path.join(HERE, 'node_modules/manifold-3d/manifold.wasm'))}";\n`);
const external = ['node:module', 'module', 'fs', 'path', 'crypto', 'worker_threads'];
// 1. 計算エンジン（src/engine.js ＋ WASM）を1つのスクリプトにする。画面側に文字列として埋め込み、Web Worker で動かす
const eng = await esbuild.build({
  entryPoints: [path.join(HERE, 'src/engine.js')], bundle: true, format: 'iife', platform: 'browser', minify: true, write: false, target: 'es2022',
  // 部品（manifold-3d・web-ifc）は自分の場所（import.meta.url）から WASM の場所を求めるが、1つのスクリプトにすると空になり、
  // 「Invalid URL」で止まる。WASM はファイルの中のデータを直接渡すので、場所は形だけの値でよい
  define: { 'import.meta.url': '"file:///kontent/engine.js"' },
  external, legalComments: 'none',
});
const engineCode = eng.outputFiles[0].text;
// 2. 画面（../frontend/app.js）と、計算エンジンにつなぐ部分（src/client.js）
const r = await esbuild.build({
  entryPoints: [path.join(HERE, 'src/main.js')], bundle: true, format: 'esm', platform: 'browser', minify: true, write: false, target: 'es2022',
  alias: { three: path.join(FE, 'vendor/three.module.js') },
  plugins: [
    { name: 'three-addons', setup(b) { b.onResolve({ filter: /^three\/addons\// }, (a) => ({ path: path.join(FE, 'vendor/addons', a.path.slice('three/addons/'.length)) })); } },
    { name: 'engine-code', setup(b) {
      b.onResolve({ filter: /^virtual:engine-code$/ }, () => ({ path: 'engine-code', namespace: 'engine' }));
      b.onLoad({ filter: /.*/, namespace: 'engine' }, () => ({ contents: `export default ${JSON.stringify(engineCode)};`, loader: 'js' }));
    } },
  ],
  external, legalComments: 'none',
});
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
let html = fs.readFileSync(path.join(FE, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(FE, 'style.css'), 'utf8');
const qr = 'data:image/svg+xml;base64,' + b64(path.join(FE, 'site_app_qr.svg'));
const before = html;
html = html.replace(/<link rel="stylesheet" href="style.css">/, () => `<style>\n${css}\n</style>`)
  .replace(/<script type="importmap">[\s\S]*?<\/script>/, '')
  .replace('src="site_app_qr.svg"', () => `src="${qr}"`)
  .replace(/<script type="module" src="app.js"><\/script>/, () => `<script type="module">${js}</script>`);
// index.html の書き方が変わって置き換えが効かなくなったら止める（壊れたHTMLを配らない）
for (const must of ['<style>', qr.slice(0, 40), '<script type="module">']) if (!html.includes(must)) throw new Error(`index.html の置き換えに失敗：${must.slice(0, 30)}`);
if (html.includes('src="app.js"') || html.includes('importmap') || before === html) throw new Error('index.html の置き換えに失敗');
fs.mkdirSync(path.join(HERE, 'dist'), { recursive: true });
const out = path.join(HERE, 'dist', 'KONTENT.html');
fs.writeFileSync(out, html);
console.log(out, (html.length / 1048576).toFixed(2), 'MB');
