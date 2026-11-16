// 単一HTML版の計算エンジンに、py_side.py と同じ呼び出しを送り、結果を保存する。
//   node single_html/tools/js_side.mjs <IFC> <py_side.pyの出力> <出力JSON>
import fs from 'fs';
import * as WEBIFC from 'web-ifc';
import { _test, ready } from '../src/api.js';
import { loadModel } from '../src/qto.js';
const [ , , ifc, pyjson, outjson] = process.argv;
await ready;
const t0 = performance.now();
_test.model = await loadModel(_test.api, WEBIFC, new Uint8Array(fs.readFileSync(ifc)), ifc.split(/[\\/]/).pop());
console.log('load', ((performance.now() - t0) / 1000).toFixed(1), 's');
const d = JSON.parse(fs.readFileSync(pyjson));
const out = { meta: _test.routes['GET /api/model'](), cases: [] };
for (const c of d.cases) {
  const t = performance.now(); let js, status = 200;
  try { js = _test.scoped(() => _test.routes[`POST ${c.url}`](c.body)); } catch (e) { status = 500; js = { detail: String(e.stack) }; }
  out.cases.push({ kind: c.kind, url: c.url, status, js, sec: (performance.now() - t) / 1000 });
  console.log(c.url, status, ((performance.now() - t) / 1000).toFixed(1), 's');
}
fs.writeFileSync(outjson, JSON.stringify(out));
