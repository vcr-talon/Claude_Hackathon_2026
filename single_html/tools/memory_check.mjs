// メモリが増え続けないかの点検。IFCと工区割の保存ファイルを読み、打設リストと全体の計算を繰り返す。
//   node --expose-gc single_html/tools/memory_check.mjs <IFC> <工区割の保存ファイル> [回数]
// 「ext」（WASMのメモリ）が回を重ねても増えなければよい。1回ごとに増えるなら delete() 漏れ（api.js の後始末を確認）
import fs from 'fs'; import * as WEBIFC from 'web-ifc';
import { _test, ready } from '../src/api.js';
import { loadModel } from '../src/qto.js';
const [, , ifc, planPath, times = '6'] = process.argv;
await ready;
_test.model = await loadModel(_test.api, WEBIFC, new Uint8Array(fs.readFileSync(ifc)), ifc.split(/[\\/]/).pop());
const plan = JSON.parse(fs.readFileSync(planPath));
const units = plan.units.map((u) => ({ name: u.name, parts: u.parts }));
const parts = units.flatMap((u) => u.parts);
const z0 = Math.min(...parts.map((p) => p.z0)), z1 = Math.max(...parts.map((p) => p.z1));
const mb = (x) => (x / 1048576).toFixed(0);
const first = [];
for (let rep = 1; rep <= Number(times); rep++) {
  const t = performance.now();
  _test.scoped(() => _test.routes['POST /api/units']({ units, exclude_registered: true }));
  _test.scoped(() => _test.routes['POST /api/compute']({ z0, z1, exclude_parts: parts }));
  global.gc?.(); const m = process.memoryUsage();
  if (rep === 2) first.push(m.external);
  console.log(`${rep}回目 ${((performance.now() - t) / 1000).toFixed(1)}秒 rss ${mb(m.rss)}MB ext ${mb(m.external)}MB`);
  if (rep === Number(times) && first.length && m.external - first[0] > 50 * 1048576) { console.error('WASMのメモリが増え続けています'); process.exit(1); }
}
