// 画面側：/api/* の呼び出しを計算エンジンにつなぐ。
// 計算は Web Worker（画面とは別のところ）で動かし、計算中も画面が止まらないようにする。
// Worker を作れない・動かないブラウザでは、同じエンジンを画面と同じところで動かす（今までと同じ動き）。
import ENGINE_CODE from 'virtual:engine-code';

const json = (status, text) => new Response(text, { status, headers: { 'Content-Type': 'application/json' } });
const say = (msg) => { const el = document.getElementById('loading'); if (el) el.textContent = msg; };

// 画面と同じところでエンジンを動かす（Worker が使えないとき）
let inPage = null;
function loadInPage() {
  inPage ??= new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([ENGINE_CODE], { type: 'text/javascript' }));
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => { globalThis.KontentEngine.setProgress(say); resolve(globalThis.KontentEngine); };
    s.onerror = () => reject(new Error('計算エンジンを読み込めませんでした'));
    document.head.appendChild(s);
  });
  return inPage;
}

// Web Worker を作る。準備ができたら true、作れない・準備に失敗したら false
let worker = null;
const pending = new Map();
let seq = 0;
const workerReady = new Promise((resolve) => {
  try {
    worker = new Worker(URL.createObjectURL(new Blob([ENGINE_CODE], { type: 'text/javascript' })));
  } catch (e) {
    console.warn('Web Worker を使えないため、画面と同じところで計算します', e);
    resolve(false);
    return;
  }
  worker.onmessage = (e) => {
    const d = e.data;
    if (d.progress) { say(d.progress); return; }
    if (d.ready) { resolve(true); return; }
    if (d.failed) { console.warn('Web Worker の準備に失敗したため、画面と同じところで計算します', d.failed); worker.terminate(); worker = null; resolve(false); return; }
    const p = pending.get(d.id);
    if (p) { pending.delete(d.id); p(json(d.status, d.text)); }
  };
  worker.onerror = (e) => {
    console.warn('Web Worker でエラーが起きたため、画面と同じところで計算します', e.message);
    e.preventDefault?.();
    worker?.terminate(); worker = null; resolve(false);
    for (const p of pending.values()) p(json(500, JSON.stringify({ detail: '計算が止まりました。ページを開き直してください' })));
    pending.clear();
  };
});

async function call(method, path, body) {
  if (await workerReady && worker) {
    const id = ++seq;
    // FormData はそのまま送れないので、IFCのファイル（File）だけを取り出して送る
    const msg = body instanceof FormData ? { __form: true, file: body.get('file') } : body;
    return new Promise((resolve) => { pending.set(id, resolve); worker.postMessage({ id, method, path, body: msg }); });
  }
  const engine = await loadInPage();
  return engine.handle(method, path, body);
}

export function installFetch() {
  const orig = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (!path.startsWith('/api/')) return orig(input, init);
    const method = (init.method || 'GET').toUpperCase();
    let body = init.body;
    if (typeof body === 'string') body = JSON.parse(body);
    return call(method, path.split('?')[0], body);
  };
}
