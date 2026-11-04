// 打設の記録（CSV）の単体テスト。データは架空の数値
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordCsv, stamp, zoneKeyOf, zoneTitle } from '../record.js';

const DATA = {
  format: 'ifc-concrete-qto/site', title: '5SL ～ 6SL A・B工区', source: 'x.ifc', exported_at: '2026-11-04T09:00:00+09:00',
  z0: 10.0, z1: 10.12, step: 0.05, zones: [{ key: 'A', name: 'A' }, { key: 'B', name: '東側' }],
  cells: [
    { id: '0,0#A', label: 'X1〜X2×Y1〜Y2（A）', from_top: [0, 1.0, 1.6, 2.0], slab: 1.5 },
    { id: '1,0#B', label: 'X2〜X3×Y1〜Y2（東側）', from_top: [0, 0.5, 0.8, 1.0], slab: 3.0 },
    { id: '2,0#B', label: '端,"帯"', from_top: [0, 0, 0, 0], slab: 0 }, // 量のないスパン（最終状態に出さない）
  ],
};
const WORK = {
  log: [
    { at: '2026-11-04T10:00:00+09:00', zone: 'A工区', action: '打設中', spans: ['X1〜X2×Y1〜Y2（A）'], depthMm: 0, remaining: 6.5 },
    { at: '2026-11-04T10:05:00+09:00', zone: 'A工区', action: '打設済み', spans: ['X1〜X2×Y1〜Y2（A）'], remaining: 4.0 },
  ],
};
const status = { '0,0#A': 'done', '1,0#B': 'pouring' };
const csv = () => recordCsv(DATA, WORK, { statusOf: (id) => status[id] ?? 'todo', depthOf: () => 50, now: '2026-11-04T10:10:00+09:00' });

test('Excel で開けるよう BOM 付き・CRLF', () => {
  const t = csv();
  assert.equal(t.charCodeAt(0), 0xfeff);
  assert.ok(t.includes('\r\n') && !/[^\r]\n/.test(t));
});

test('履歴は古い順に、時刻・工区・操作・スパン・打ち上がり・残り', () => {
  const lines = csv().slice(1).split('\r\n');
  const i = lines.indexOf('履歴（古い順）');
  assert.equal(lines[i + 1], '時刻,工区,操作,スパン,打設済み高さ（コン天からmm）,残り（m3）');
  assert.equal(lines[i + 2], `${stamp(WORK.log[0].at)},A工区,打設中,X1〜X2×Y1〜Y2（A）,0,6.500`);
  assert.equal(lines[i + 3], `${stamp(WORK.log[1].at)},A工区,打設済み,X1〜X2×Y1〜Y2（A）,,4.000`);
});

test('最終状態：打設済みは残り0、打設中は打ち上がりの値で残りを出す。量のないスパンは出さない', () => {
  const lines = csv().slice(1).split('\r\n');
  const i = lines.indexOf('スパンごとの最終状態');
  assert.equal(lines[i + 2], 'A工区,X1〜X2×Y1〜Y2（A）,打設済み,,0.000,3.500');
  assert.equal(lines[i + 3], '東側,X2〜X3×Y1〜Y2（東側）,打設中,50,3.500,4.000'); // 50mm は 0.05 の刻みちょうど → 0.5＋3.0
  assert.ok(!csv().includes('帯'));
});

test('カンマや引用符を含む名前は囲んで崩れないように', () => {
  const t = recordCsv({ ...DATA, title: 'A,"B"' }, { log: [] }, { statusOf: () => 'todo', depthOf: () => 0 });
  assert.ok(t.includes('打設記録,"A,""B"""'));
});

test('工区のキーと表示名', () => {
  assert.equal(zoneKeyOf({ id: '3,1#B-2' }), 'B');
  assert.equal(zoneKeyOf({ id: '3,1' }), null);
  assert.equal(zoneTitle(DATA, 'A'), 'A工区');
  assert.equal(zoneTitle(DATA, 'B'), '東側');
});
