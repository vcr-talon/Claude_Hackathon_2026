// 打設の記録：操作の履歴と、スパンごとの最終状態のCSV（docs/site_app_spec.md 3-e）。画面から切り離した純粋な関数
import { fullVolume, remaining } from './calc.js';

export const STATUS_NAME = { todo: '未打設', pouring: '打設中', done: '打設済み' };
const EMPTY = 0.0005; // m³。これ未満のスパン（建物の外の帯など）は最終状態に出さない

// スパンのIDの「#A」「#A-2」から工区のキーを取る（工区で切っていなければ null）
export const zoneKeyOf = (cell) => (cell.id.includes('#') ? cell.id.split('#')[1].replace(/-\d+$/, '') : null);

// 工区の表示名：「A」なら「A工区」、名前を付けていればその名前
export function zoneTitle(data, key) {
  if (!key) return '';
  const name = (data.zones ?? []).find((z) => z.key === key)?.name ?? key;
  return /^[A-F]$/.test(name) ? `${name}工区` : name;
}

// 日時を「2026-11-04 10:23:05」に（端末の時刻で）
export function stamp(iso) {
  const d = new Date(iso), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const cell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const m3 = (v) => (typeof v === 'number' ? v.toFixed(3) : '');

// CSV（Excel で開けるよう BOM 付き UTF-8・CRLF）。記録は古い順、最終状態は全スパン
export function recordCsv(data, work, { statusOf, depthOf, now = new Date().toISOString() }) {
  const rows = [
    ['打設記録', data.title],
    ['データ', `${data.source}（${stamp(data.exported_at)} 書き出し）`],
    ['作成', stamp(now)],
    [],
    ['履歴（古い順）'],
    ['時刻', '工区', '操作', 'スパン', '打ち上がり（コン天−mm）', '残り（m3）'],
    ...(work.log ?? []).map((e) => [stamp(e.at), e.zone ?? '', e.action, (e.spans ?? []).join('・'),
      e.depthMm ?? '', m3(e.remaining)]),
    [],
    ['スパンごとの最終状態'],
    ['工区', 'スパン', '状態', '打ち上がり（コン天−mm）', '残り（m3）', '全量（m3）'],
  ];
  for (const c of data.cells) {
    const full = fullVolume(c);
    if (full < EMPTY) continue;
    const s = statusOf(c.id);
    rows.push([zoneTitle(data, zoneKeyOf(c)), c.label, STATUS_NAME[s],
      s === 'pouring' ? depthOf(c.id) : '', m3(remaining(c, s, depthOf(c.id), data)), m3(full)]);
  }
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
