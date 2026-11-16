// 打設リストの区分ごとに書き出したファイル（D35）を、今のアプリがそのまま扱えることの確認
// データは架空の数値（BIMデータは含めない）。形は PCアプリの「タブレット用」ボタンが書き出すものと同じ
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSiteData, totals } from '../calc.js';
import { equalLayout } from '../layout.js';
import { zoneKeyOf, zoneTitle } from '../record.js';

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} と ${b} の差が ${tol} を超える`);
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

// 区分「1SL-4500 ～ 1SL-2000 1工区・2工区」（2つの工区）。高さ 2.5 m・刻み 0.5。
// スパン X1～X2 は工区の境界（x=4）で2つに切れている。先に入れた区分と重なる部分は除いて書き出した
const FILE = {
  format: 'ifc-concrete-qto/site', version: 1, title: '1SL-4500 ～ 1SL-2000 1工区・2工区',
  conditions: ['高さ範囲：1SL-4500 ～ 1SL-2000', '工区：1工区・2工区', '数える材料：コンクリート', '先に入れた区分と重なる部分は除いています'],
  z0: -4.5, z1: -2.0, con_top: -2.0, step: 0.5, total: 9.0, overlap_note: 0, truck_m3: 4.25, extra_pct: 0,
  storeys: [{ name: '1SL', elevation: 0 }], bounds: [-1, -1, 9, 7],
  grids: [{ tag: 'X1', start: [0, -3], end: [0, 9] }, { tag: 'X2', start: [8, -3], end: [8, 9] },
    { tag: 'Y1', start: [-3, 0], end: [11, 0] }, { tag: 'Y2', start: [-3, 6], end: [11, 6] }],
  footprints: [{ category: '基礎', box: [1, 1, 3, 3] }],
  zones: [{ key: 'A', name: '1工区' }, { key: 'B', name: '2工区' }],
  boundaries: [rect(0, 0, 4, 6), rect(4, 0, 8, 6)], // 区分の工区の外形
  cells: [
    { id: 'X1-Y1#A', label: 'X1～X2・Y1～Y2（1工区）', ring: rect(0, 0, 4, 6), from_top: [0, 0.4, 0.8, 1.2, 1.6, 2.0], slab: 3.0 },
    { id: 'X1-Y1#B', label: 'X1～X2・Y1～Y2（2工区）', ring: rect(4, 0, 8, 6), from_top: [0, 0.2, 0.4, 0.6, 0.8, 1.0], slab: 3.0 },
  ],
  uncomputed: [],
};

test('区分ごとのファイルを開ける', () => {
  const d = parseSiteData(JSON.stringify(FILE));
  assert.equal(d.title, FILE.title);
  assert.ok(d.conditions.includes('先に入れた区分と重なる部分は除いています'));
});

test('全スパンが未打設なら残りはファイルの total（打設リストの区分の数量）', () => {
  const t = totals(FILE, () => 'todo', () => null);
  near(t.planned, FILE.total, 0.01);
  near(t.remaining, FILE.total, 0.01);
});

test('スパンは工区の境界で分かれ、工区ごとに切り替えられる', () => {
  assert.deepEqual(FILE.cells.map(zoneKeyOf), ['A', 'B']);
  assert.equal(zoneTitle(FILE, 'A'), '1工区');
  // 工区 A だけを数えると、A のスパンの分だけ
  const onlyA = { ...FILE, cells: FILE.cells.filter((c) => zoneKeyOf(c) === 'A') };
  near(totals(onlyA, () => 'todo', () => null).planned, 5.0);
});

test('平面図：工区の外形（閉じた線）も境界線として描ける', () => {
  const g = equalLayout(FILE);
  assert.equal(g.rings.size, 2);
  assert.equal(g.boundaries.length, 2);
  assert.equal(g.boundaries[0].length, 5);
});
