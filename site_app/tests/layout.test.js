// 平面図の「等間隔」表示の単体テスト。描き方だけを変え、スパンの並び・数量は変えないこと
// データは架空の数値（BIMデータは含めない）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { axisWarp, equalLayout, realLayout } from '../layout.js';

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} と ${b} の差が ${tol} を超える`);
const width = (ring) => Math.max(...ring.map((p) => p[0])) - Math.min(...ring.map((p) => p[0]));
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

test('通り芯の間はどこも同じ幅、外側の帯はその半分', () => {
  // 通り芯 0・7.2・7.8・14（間隔 7.2・0.6・6.2）、建物の範囲 -1〜15
  const f = axisWarp([7.8, 0, 14, 7.2], -1, 15);
  const avg = 14 / 3;
  near(f(0), 0);
  near(f(7.2), avg);
  near(f(7.8), 2 * avg);
  near(f(14), 14);
  near(f(-1), -avg / 2);
  near(f(15), 14 + avg / 2);
  near(f(7.5), 1.5 * avg); // 狭い間の真ん中は、そろえた間の真ん中
});

test('並びの順番は変わらない（単調に増える）', () => {
  const f = axisWarp([0, 3.8, 6.5, 12.9, 14.3, 21.5, 22.1], -1.09, 23);
  let prev = -Infinity;
  for (let v = -30; v <= 50; v += 0.37) {
    const w = f(v);
    assert.ok(w > prev, `${v} で順番が入れ替わった`);
    prev = w;
  }
});

test('通り芯が1本以下の向きは、そのまま', () => {
  const f = axisWarp([5], 0, 10);
  near(f(3), 3);
  near(axisWarp([], 0, 10)(7), 7);
});

const DATA = {
  bounds: [-1, -1, 15, 9],
  grids: [
    { tag: 'X1', start: [0, 12], end: [0, -4] }, { tag: 'X2', start: [7.2, 12], end: [7.2, -4] },
    { tag: 'X3', start: [7.8, 12], end: [7.8, -4] }, { tag: 'X4', start: [14, 12], end: [14, -4] },
    { tag: 'Y1', start: [-4, 0], end: [18, 0] }, { tag: 'Y2', start: [-4, 8], end: [18, 8] },
    { tag: 'S1', start: [0, 0], end: [14, 8] }, // 斜めの通り芯：そろえる位置には使わない
  ],
  footprints: [{ category: '柱', box: [6.9, -0.3, 7.5, 0.3] }],
  boundaries: [[[10, -5], [10, 13]]],
  cells: [
    { id: 'a', ring: rect(0, 0, 7.2, 8) }, { id: 'b', ring: rect(7.2, 0, 7.8, 8) }, { id: 'c', ring: rect(7.8, 0, 14, 8) },
  ],
};

test('等間隔：狭いスパン（0.6m）も、広いスパン（7.2m）と同じ幅で描く', () => {
  const g = equalLayout(DATA);
  const avg = 14 / 3;
  for (const id of ['a', 'b', 'c']) near(width(g.rings.get(id)), avg);
  // 隣り合うスパンは、すき間なくつながったまま
  near(Math.max(...g.rings.get('a').map((p) => p[0])), Math.min(...g.rings.get('b').map((p) => p[0])));
  // 通り芯・部材の外形・境界線も同じ割合で動く
  near(g.grids.find((x) => x.tag === 'X3').start[0], 2 * avg);
  near(g.footprints[0].box[0], 6.9 / 7.2 * avg); // X1〜X2 の間（7.2m）の中
  near(g.footprints[0].box[2], avg + 0.3 / 0.6 * avg); // X2〜X3 の間（0.6m）の真ん中
  assert.equal(g.boundaries[0].length, 2);
  // 元のデータ（数量の計算に使う）は書き換えない
  assert.deepEqual(DATA.cells[1].ring, rect(7.2, 0, 7.8, 8));
});

test('実寸：座標はそのまま', () => {
  const g = realLayout(DATA);
  assert.deepEqual(g.rings.get('b'), rect(7.2, 0, 7.8, 8));
  assert.deepEqual(g.bounds, DATA.bounds);
});
