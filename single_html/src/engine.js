// 計算エンジンの入口（Web Worker の中で動かす。動かせないときは画面と同じところで動かす）。
// build.mjs がこのファイルを1つのスクリプトにまとめ、文字列として画面側（client.js）に埋め込む。
import { handle, setProgress, ready } from './api.js';

globalThis.KontentEngine = { handle, setProgress, ready };

// Web Worker の中なら、画面からの依頼（/api/* の呼び出し）を受けて答えを返す
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  setProgress((msg) => self.postMessage({ progress: msg }));
  ready.then(() => self.postMessage({ ready: true }), (e) => self.postMessage({ failed: String(e?.message || e) }));
  self.onmessage = async (e) => {
    const { id, method, path, body } = e.data;
    // IFCを開くときは FormData の代わりに { file } が届く。api.js は body.get('file') で読む
    const b = body && body.__form ? { get: (k) => body[k] } : body;
    let status = 500, text;
    try {
      const res = await handle(method, path, b);
      status = res.status; text = await res.text();
    } catch (err) {
      text = JSON.stringify({ detail: String(err?.message || err) });
    }
    self.postMessage({ id, status, text });
  };
}
