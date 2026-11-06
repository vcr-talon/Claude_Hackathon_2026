// 現場残量アプリの計算の単体テスト（docs/site_app_spec.md 4章の検算例）。実行：cd site_app && npm test
// データは架空の数値（BIMデータは含めない）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aboveMm, conTop, excludedAbove, fullVolume, interp, parseSiteData, presetMm, remaining, totals, truckPlan } from '../calc.js';

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} と ${b} の差が ${tol} を超える`);

// 高さ 0.12 m・刻み 0.05 → 深さ [0, 0.05, 0.10, 0.12]（最後の刻みは端数 0.02）
const DATA = {
  format: 'ifc-concrete-qto/site', z0: 10.0, z1: 10.12, step: 0.05, total: 7.5, overlap_note: 0,
  cells: [
    { id: 'a', from_top: [0, 1.0, 1.6, 2.0], slab: 1.5, slab_bottom_mm: 200, beam_mid_mm: 300 },
    { id: 'b', from_top: [0, 0.5, 0.8, 1.0], slab: 3.0, slab_bottom_mm: 180, beam_mid_mm: null },
  ],
};
const HEIGHT = DATA.z1 - DATA.z0;
const sum = (status, d = 0) => totals(DATA, () => status, () => d);

test('全スパンが未打設なら残りはファイルの total（overlap_note 以内）', () => {
  near(sum('todo').remaining, DATA.total, Math.abs(DATA.overlap_note) + 1e-9);
  near(sum('todo').done, 0);
});

test('全スパンが打設済みなら残りは 0、打設済みは予定と同じ', () => {
  assert.equal(sum('done').remaining, 0);
  near(sum('done').done, sum('done').planned);
  assert.equal(sum('done').restCount, 0);
});

test('打設中で d=0（柱・梁は上端まで打設済み）ならスラブだけ', () => {
  assert.equal(remaining(DATA.cells[0], 'pouring', 0, DATA), 1.5);
});

test('打設中で d が部材の高さ以上なら未打設と同じ', () => {
  for (const d of [120, 121, 5000]) assert.equal(remaining(DATA.cells[0], 'pouring', d, DATA), fullVolume(DATA.cells[0]));
});

test('打設中で d=25（刻みの途中）は from_top[0] と [1] の中点＋スラブ', () => {
  near(remaining(DATA.cells[0], 'pouring', 25, DATA), (0 + 1.0) / 2 + 1.5);
});

test('最後の刻みは端数の幅で補間する', () => {
  // 深さ 0.11 は 0.10〜0.12（幅 0.02）の中点 → 1.6 と 2.0 の中点
  near(interp(DATA.cells[0].from_top, DATA.step, HEIGHT, 110), 1.8);
  near(interp(DATA.cells[0].from_top, DATA.step, HEIGHT, 50), 1.0); // 刻みちょうど
});

test('状態の混在：予定＝残り＋打設済み', () => {
  const st = { a: 'pouring', b: 'done' };
  const t = totals(DATA, (id) => st[id], () => 75);
  near(t.remaining, 1.0 + (1.6 - 1.0) * 0.5 + 1.5);
  near(t.planned, t.remaining + t.done);
  assert.equal(t.restCount, 1);
});

test('スパンごとの打ち上がり（長押しで入れた値）は、そのスパンだけに効く', () => {
  // a は共通の 25 mm、b だけ長押しで 110 mm にしたとき
  const own = { b: 110 };
  const t = totals(DATA, () => 'pouring', (id) => own[id] ?? 25);
  near(t.remaining, remaining(DATA.cells[0], 'pouring', 25, DATA) + remaining(DATA.cells[1], 'pouring', 110, DATA));
  near(t.remaining, (0.5 + 1.5) + ((0.8 + 1.0) / 2 + 3.0)); // b は深さ 0.10〜0.12 の中点
});

test('打ち上がり高さの目安は対象スパンの中央値（値のないスパンは除く）', () => {
  assert.equal(presetMm(DATA.cells, 'slab_bottom_mm'), 200); // [180, 200] の上側
  assert.equal(presetMm(DATA.cells, 'beam_mid_mm'), 300);
  assert.equal(presetMm([DATA.cells[1]], 'beam_mid_mm'), null);
});

test('生コン車の文面はPCアプリと同じ', () => {
  // PCアプリの残量・早見表に出た文面（hackathon_model.ifc で確認）
  assert.equal(truckPlan(12.933, 4.25, 0).text, '4.25 m³ × 3台 ＋ 最終車 0.18 m³（計 4 台）');
  assert.equal(truckPlan(23.769, 4.25, 0).text, '4.25 m³ × 5台 ＋ 最終車 2.52 m³（計 6 台）');
  assert.equal(truckPlan(3.961, 4.25, 0).text, '1台（3.96 m³）');
  assert.equal(truckPlan(8.5, 4.25, 0).text, '4.25 m³ × 2台（計 2 台）');
  assert.equal(truckPlan(0, 4.25, 0).text, '残りなし');
  const t = truckPlan(72.78, 4.25, 3); // 割増 3% → 74.9634
  near(t.need, 74.9634, 1e-9);
  assert.equal(t.text, '4.25 m³ × 17台 ＋ 最終車 2.71 m³（計 18 台）');
});

test('このアプリ用でないファイルは開かない', () => {
  assert.throws(() => parseSiteData('{"format":"ifc-concrete-qto/plan"}'), /このアプリ用のデータではありません/);
  assert.throws(() => parseSiteData('壊れたファイル'), /このアプリ用のデータではありません/);
  assert.equal(parseSiteData(JSON.stringify(DATA)).cells.length, 2);
});

test('打設中でも高さが未計測（null）なら、柱・梁を全部残りに数える（少なく見積もらない）', () => {
  for (const c of DATA.cells) near(remaining(c, 'pouring', null, DATA), fullVolume(c));
  near(totals(DATA, () => 'pouring', () => null).remaining, sum('todo').remaining);
  // 0 mm（コン天まで打設済み）はスラブだけが残る。未計測とは違う
  near(remaining(DATA.cells[0], 'pouring', 0, DATA), 1.5);
});

// 範囲の上端がSLより上（例：6SL+600）のデータ。ここでは SL が上端の 70 mm 下にある
const ABOVE = { ...DATA, storeys: [{ name: '5SL', elevation: 10.0 }, { name: '6SL', elevation: 10.05 }] };

test('コン天は範囲の中の一番上のSL。書き出しの con_top があればそれを使う', () => {
  near(conTop(ABOVE), 10.05);
  assert.equal(aboveMm(ABOVE), 70);
  assert.equal(conTop(DATA), DATA.z1); // 階の情報がなければ範囲の上端
  assert.equal(aboveMm({ ...ABOVE, con_top: 10.12 }), 0);
  assert.equal(conTop({ ...DATA, storeys: [{ name: '5SL', elevation: 10.0 }] }), DATA.z1); // 下端のSLは使わない
});

test('上端がSLより上なら、打設済み高さはSLから測り、SLより上は残りに含めない', () => {
  const a = ABOVE.cells[0]; // from_top [0, 1.0, 1.6, 2.0]、SL は上端から 70 mm → SLより上は 1.24
  near(excludedAbove(a, 'pouring', 0, ABOVE), 1.24);
  near(remaining(a, 'pouring', 0, ABOVE), 1.5); // コン天（SL）まで打設済み：スラブだけ
  near(remaining(a, 'pouring', 30, ABOVE), 1.6 - 1.24 + 1.5); // SLから30mm下まで
  // 未計測・未打設は全量（SLより上も含む）。打設済みは0
  near(remaining(a, 'pouring', null, ABOVE), fullVolume(a));
  near(remaining(a, 'todo', 30, ABOVE), fullVolume(a));
  assert.equal(excludedAbove(a, 'pouring', null, ABOVE), 0);
  const t = totals(ABOVE, () => 'pouring', () => 0);
  near(t.excluded, 1.24 + interp(ABOVE.cells[1].from_top, 0.05, 0.12, 70));
  near(t.done + t.remaining, t.planned); // 含めなかった分は打設済みに入る
});

test('目安ボタンの値はコン天からの距離に直す。SLより上の部材の値は使わない', () => {
  assert.equal(presetMm(ABOVE.cells, 'slab_bottom_mm', ABOVE), 130); // [180, 200] − 70 の上側
  assert.equal(presetMm(ABOVE.cells, 'beam_mid_mm', ABOVE), 230);
  assert.equal(presetMm([{ beam_mid_mm: 50 }], 'beam_mid_mm', ABOVE), null);
  assert.equal(presetMm(DATA.cells, 'slab_bottom_mm', DATA), 200); // 上端がSLなら今までどおり
});
