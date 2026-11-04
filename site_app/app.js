// 現場残量アプリの画面。数量の計算は calc.js（PCアプリで作った表を引いて足すだけ）
import { fmt, fullVolume, parseSiteData, presetMm, totals, remaining, truckPlan } from './calc.js';

const APP_VERSION = '1.2.2'; // sw.js の VERSION と合わせる（キャッシュで古い版が動いていないか確かめる用）
const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
const CAT_COLORS = { 柱: '#c62828', 梁: '#ef6c00', 壁: '#0288d1', スラブ: '#a0a4a8', 基礎: '#6d4c41', 階段: '#6a1b9a', その他: '#546e7a' };
const NEXT = { todo: 'pouring', pouring: 'done', done: 'todo' }; // タップで巡る順
const EMPTY = 0.0005; // m³。これ未満のスパン（建物の外の帯など）はタップの対象にしない
const THIN_SPAN = 2.0; // m。短い辺がこれ未満のスパンは数字を出さない（ふつうのスパンは3〜8m。通り芯が近い間や端の帯）
const TAP_SLOP = 10; // px。指を離したときの移動がこれ未満ならタップ
const STORE = 'site.work.'; // localStorage：スパンの状態と履歴（データファイル本体は保存しない）
const LAST = 'site.last';
const UNDO_MAX = 200;

let data = null; // 開いたデータファイル
let key = '';
let work = null; // { statuses, depth, cellDepth, truck, extra, undo, updated }
let cellEls = new Map(); // id → { path, text, cell }
let home = null; // 全体表示の viewBox
let vb = null; // いまの viewBox [x, y, w, h]（y は上下反転した座標）
let zones = []; // 工区で切ったデータのとき [{key, name}]。切り替えたときは選んだ工区だけを数え、他の工区は選べない
let bulk = false; // 「打設済みをまとめて」：なぞったスパンを一度に打設済みにする

// スパンのIDの「#A」「#A-2」から工区のキーを取る（工区で切っていなければ null）
const zoneOf = (cell) => (cell.id.includes('#') ? cell.id.split('#')[1].replace(/-\d+$/, '') : null);
const inZone = (cell) => !work.zone || zoneOf(cell) === work.zone;
const zoneLabel = (z) => (/^[A-F]$/.test(z.name) ? `${z.name}工区` : z.name);
const zoneCells = () => data.cells.filter(inZone);

// ---------- 保存（入力のたびに。Safariが裏のタブを破棄しても続きから再開できるように） ----------
function store(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できない環境では続行 */ }
}
function load(k) {
  try { return JSON.parse(localStorage.getItem(k)); } catch { return null; }
}
function save() {
  work.updated = new Date().toISOString();
  store(STORE + key, work);
  store(LAST, { title: data.title, source: data.source, updated: work.updated });
}

// 元に戻す：変更の直前の状態を積む
const snapshot = () => JSON.parse(JSON.stringify({ statuses: work.statuses, depth: work.depth, cellDepth: work.cellDepth, truck: work.truck, extra: work.extra }));
function pushUndo() {
  work.undo.push(snapshot());
  if (work.undo.length > UNDO_MAX) work.undo.shift();
}
function undo() {
  const prev = work.undo.pop();
  if (!prev) return;
  Object.assign(work, prev);
  save();
  syncInputs();
  updateCells();
  render();
  toast('元に戻しました');
}

// ---------- 通知 ----------
let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), kind === 'error' ? 5000 : 2500);
}

// ---------- データを開く ----------
function showStart() {
  $('work').classList.add('hidden');
  $('start').classList.remove('hidden');
  const last = load(LAST);
  $('lastWork').classList.toggle('hidden', !last);
  if (last) {
    $('lastWork').textContent = `前回の作業：${last.title}（${new Date(last.updated).toLocaleString('ja-JP')} 更新）。` +
      '同じデータファイルを開くと、続きから再開します';
  }
}

async function openFile(file) {
  $('startError').classList.add('hidden');
  try {
    start(parseSiteData(await file.text()));
  } catch (e) {
    $('startError').textContent = e.message;
    $('startError').classList.remove('hidden');
  }
}

function start(d) {
  data = d;
  key = `${d.source}|${d.title}|${d.exported_at}`;
  const saved = load(STORE + key);
  work = saved ?? { statuses: {}, depth: 0, cellDepth: {}, truck: d.truck_m3 ?? 4.25, extra: d.extra_pct ?? 0, undo: [], updated: null };
  // 工区の一覧（書き出しに無い古いファイルでも、スパンのIDから拾う）
  zones = d.zones?.length ? d.zones : [...new Set(d.cells.map(zoneOf).filter(Boolean))].map((k) => ({ key: k, name: k }));
  if (!zones.some((z) => z.key === work.zone)) work.zone = zones[0]?.key ?? null;
  setBulk(false);
  $('title').textContent = d.title;
  renderZoneTabs();
  $('start').classList.add('hidden');
  $('work').classList.remove('hidden');
  buildPlan();
  syncInputs();
  updateCells();
  render();
  $('showMissing').classList.toggle('hidden', !d.uncomputed?.length);
  if (saved?.updated) toast(`前回の続きから再開しました（${new Date(saved.updated).toLocaleTimeString('ja-JP')} 更新）`);
  if (d.uncomputed?.length && !saved) showMissing();
}

function showMissing() {
  const list = data.uncomputed ?? [];
  $('missingLead').textContent = `形状を計算できなかったため、次の ${list.length} 件は数量に含まれていません`;
  $('missingList').innerHTML = '';
  for (const u of list) {
    const li = document.createElement('li');
    li.textContent = `${u.category ?? ''} ${u.name || '(名称なし)'}：${u.reason}`;
    $('missingList').appendChild(li);
  }
  $('missing').classList.remove('hidden');
}

// ---------- 平面図（SVG）：上下を反転して北を上にする ----------
const el = (tag, attrs = {}) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
const ringPath = (ring) => ring.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(3)} ${(-y).toFixed(3)}`).join('') + 'Z';
function centroid(ring) {
  const pts = ring.slice(0, -1);
  return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
}

function buildPlan() {
  const svg = $('plan');
  svg.replaceChildren();
  const [x0, y0, x1, y1] = data.bounds;
  const size = Math.max(x1 - x0, y1 - y0), m = size * 0.06 + 2;
  home = [x0 - m, -y1 - m, x1 - x0 + 2 * m, y1 - y0 + 2 * m];
  setViewBox(home);

  // 部材の位置（外接矩形）を種別ごとに1本のパスで薄く描く
  const byCat = {};
  for (const f of data.footprints ?? []) {
    const [a, b, c, d] = f.box;
    (byCat[f.category] ??= []).push(`M${a.toFixed(3)} ${(-d).toFixed(3)}h${(c - a).toFixed(3)}v${(d - b).toFixed(3)}h${(a - c).toFixed(3)}Z`);
  }
  const fp = el('g');
  for (const [cat, ds] of Object.entries(byCat)) {
    fp.appendChild(el('path', { class: 'fp', d: ds.join(''), fill: CAT_COLORS[cat] ?? CAT_COLORS['その他'], 'fill-opacity': cat === 'スラブ' ? 0.15 : 0.45 }));
  }

  // スパン（タップする面）と残り数量
  const cellsG = el('g'), nums = el('g');
  cellEls = new Map();
  for (const c of data.cells) {
    const empty = fullVolume(c) < EMPTY;
    const path = el('path', { d: ringPath(c.ring), class: `cell ${empty ? 'empty' : 'todo'}`, 'data-id': c.id });
    cellsG.appendChild(path);
    if (empty) continue;
    const xs = c.ring.map((p) => p[0]), ys = c.ring.map((p) => p[1]);
    const short = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const fs = Math.min(Math.max(short * 0.28, size * 0.006), size * 0.02);
    const [cx, cy] = centroid(c.ring);
    const text = el('text', { x: cx.toFixed(3), y: (-cy).toFixed(3), class: 'cellnum', 'font-size': fs.toFixed(3) });
    nums.appendChild(text);
    // 細いスパン（通り芯が近い間・建物の端の帯）は小さな数字が並んで読めないので出さない（色と数量の合計はそのまま）
    cellEls.set(c.id, { path, text, cell: c, thin: short < THIN_SPAN });
  }

  // 通り芯と記号
  const grid = el('g', { class: 'grid' });
  const r = size * 0.012;
  for (const g of data.grids ?? []) {
    const [sx, sy] = g.start, [ex, ey] = g.end, len = Math.hypot(ex - sx, ey - sy) || 1;
    const ux = (ex - sx) / len, uy = (ey - sy) / len;
    grid.appendChild(el('line', { x1: sx, y1: -sy, x2: ex, y2: -ey }));
    for (const [px, py] of [[sx - ux * r * 1.4, sy - uy * r * 1.4], [ex + ux * r * 1.4, ey + uy * r * 1.4]]) {
      grid.appendChild(el('circle', { cx: px, cy: -py, r }));
      const t = el('text', { x: px, y: -py, 'font-size': r * 1.05 });
      t.textContent = g.tag;
      grid.appendChild(t);
    }
  }
  // 工区割の境界線（PCアプリと同じ赤）。両端の区間をモデルの外まで延ばす
  const lines = el('g');
  const reach = Math.hypot(x1 - x0, y1 - y0);
  for (const pts of data.boundaries ?? []) {
    if (pts.length < 2) continue;
    const out = ([fx, fy], [tx, ty]) => {
      const l = Math.hypot(tx - fx, ty - fy) || 1;
      return [tx + (tx - fx) / l * reach, ty + (ty - fy) / l * reach];
    };
    const n = pts.length, ext = [out(pts[1], pts[0]), ...pts.slice(1, -1), out(pts[n - 2], pts[n - 1])];
    lines.appendChild(el('path', { class: 'bline', d: ext.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(3)} ${(-y).toFixed(3)}`).join('') }));
  }
  svg.append(fp, grid, cellsG, lines, nums);
}

function renderZoneTabs() {
  const box = $('zoneTabs');
  box.classList.toggle('hidden', zones.length < 2);
  box.replaceChildren(...zones.map((z) => {
    const b = document.createElement('button');
    b.className = `btn${z.key === work.zone ? ' active' : ''}`;
    b.textContent = zoneLabel(z);
    b.addEventListener('click', () => {
      work.zone = z.key;
      save();
      renderZoneTabs();
      updateCells();
      render();
    });
    return b;
  }));
}

function setBulk(on) {
  bulk = on;
  $('bulk').classList.toggle('active', on);
  $('bulk').textContent = on ? 'まとめて選択中（押すと終了）' : '打設済みをまとめて';
}

function setViewBox(v) {
  vb = v;
  $('plan').setAttribute('viewBox', v.map((n) => n.toFixed(3)).join(' '));
}

// ---------- 表示の更新（平面図は作り直さず、色と数字だけ書き換える） ----------
const statusOf = (id) => work.statuses[id] ?? 'todo';
const depthOf = (id) => work.cellDepth[id] ?? work.depth;

function updateCells() {
  for (const [id, { path, text, cell, thin }] of cellEls) {
    if (!inZone(cell)) { // 選んでいない工区は薄くして、タップしても反応しない
      path.setAttribute('class', 'cell other');
      text.textContent = '';
      continue;
    }
    const s = statusOf(id);
    path.setAttribute('class', `cell ${s}${work.cellDepth[id] !== undefined ? ' own' : ''}`);
    text.setAttribute('class', `cellnum ${s}`);
    const v = remaining(cell, s, depthOf(id), data);
    text.textContent = s === 'done' || thin || v < 0.05 ? '' : fmt(v, 1); // 0.0 と出るごく小さいスパンも数字を出さない
  }
}

function render() {
  const t = totals({ ...data, cells: zoneCells() }, statusOf, depthOf); // 工区を選んでいればその工区だけ
  const active = [...cellEls.values()].filter(({ cell }) => inZone(cell)).map(({ cell }) => cell.id);
  const rest = active.filter((id) => statusOf(id) !== 'done').length;
  const pouring = active.filter((id) => statusOf(id) === 'pouring').length;
  $('planned').textContent = `${fmt(t.planned)} m³`;
  $('done').textContent = `${fmt(t.done)} m³`;
  $('rest').textContent = `${fmt(t.remaining)} m³`;
  const plan = truckPlan(t.remaining, work.truck, work.extra);
  $('trucks').textContent = (plan.extra ? `発注の目安：割増 ${plan.extra}% 込み ${fmt(plan.need)} m³　` : '発注の目安（割増なし）：') + plan.text;
  $('restInfo').textContent = `残り ${rest} スパン${pouring ? `（うち打設中 ${pouring}）` : ''}`;
  $('undo').disabled = !work.undo.length;
  const topName = (data.storeys ?? []).find((s) => Math.abs(s.elevation - data.z1) < 0.005)?.name;
  $('depthNote').textContent = `コン天＝${topName ?? '高さ範囲の上端'}の高さ。0 mm なら天端まで打ち上がり。` +
    (pouring ? 'この高さは、今打っているスパン（オレンジ）の柱・梁にだけ効きます（打設中が複数なら全部に同じ値）'
      : '今打っているスパンがありません（スパンをタップすると打設中になります）');
}

function syncInputs() {
  $('depth').value = work.depth;
  $('truck').value = work.truck;
  $('extra').value = work.extra;
}

// ---------- タップ：未打設 → 打設中 → 打設済み → 未打設 ----------
function tapCell(id) {
  if (!cellEls.has(id) || !inZone(cellEls.get(id).cell)) return;
  pushUndo();
  const next = NEXT[statusOf(id)];
  if (next === 'todo') delete work.statuses[id]; else work.statuses[id] = next;
  save();
  updateCells();
  render();
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 画面の点 → 図面の座標（preserveAspectRatio="meet" の余白を考慮）
function toWorld(px, py, v = vb) {
  const r = $('plan').getBoundingClientRect();
  const s = Math.max(v[2] / r.width, v[3] / r.height);
  const ox = (r.width - v[2] / s) / 2, oy = (r.height - v[3] / s) / 2;
  return { x: v[0] + (px - r.left - ox) * s, y: v[1] + (py - r.top - oy) * s, s, ox, oy, r };
}

function cellAtScreen(px, py) {
  const w = toWorld(px, py);
  for (const [id, { cell }] of cellEls) if (inZone(cell) && pointInRing(w.x, -w.y, cell.ring)) return id;
  return null;
}

// 「打設済みをまとめて」：1回なぞった分をまとめて打設済みに（打設済みのスパンからなぞり始めたら未打設に戻す）
function paintTo(px, py) {
  // 指を速く動かすと間のスパンを飛ばすので、前の位置から8pxごとに拾う
  const from = gesture.last ?? { x: px, y: py };
  const n = Math.max(1, Math.ceil(Math.hypot(px - from.x, py - from.y) / 8));
  for (let i = 1; i <= n; i++) paintAt(from.x + (px - from.x) * i / n, from.y + (py - from.y) * i / n);
  gesture.last = { x: px, y: py };
}

function paintAt(px, py) {
  const id = cellAtScreen(px, py);
  if (!id || gesture.ids.has(id)) return;
  if (!gesture.to) {
    pushUndo(); // なぞり1回分を1つの取り消し単位に
    gesture.to = statusOf(id) === 'done' ? 'todo' : 'done';
  }
  gesture.ids.add(id);
  if (gesture.to === 'todo') delete work.statuses[id]; else work.statuses[id] = 'done';
  updateCells();
  render();
}

// ---------- 拡大・移動：1本指で移動、2本指で拡大（viewBox を書き換える） ----------
const pointers = new Map();
let gesture = null;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
function clampZoom(w) { return Math.min(Math.max(w, home[2] / 25), home[2] * 2); }

function zoomAt(px, py, k, base = vb) {
  const w0 = toWorld(px, py, base);
  const w = clampZoom(base[2] * k), kk = w / base[2], h = base[3] * kk, s = w0.s * kk;
  setViewBox([w0.x - (px - w0.r.left - w0.ox) * s, w0.y - (py - w0.r.top - w0.oy) * s, w, h]);
}

function onDown(e) {
  try { $('plan').setPointerCapture(e.pointerId); } catch { /* 取れなくても操作は続ける */ }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1 && bulk) { // まとめて選択中：1本指はなぞり（2本指の拡大・移動はそのまま）
    gesture = { type: 'paint', ids: new Set(), to: null, last: null };
    paintTo(e.clientX, e.clientY);
  } else if (pointers.size === 1) gesture = { type: 'tap', start: { x: e.clientX, y: e.clientY }, vb: [...vb] };
  else if (pointers.size === 2) {
    if (gesture?.type === 'paint' && gesture.to) save();
    const [a, b] = [...pointers.values()];
    gesture = { type: 'pinch', d0: dist(a, b), m0: mid(a, b), vb: [...vb] };
  }
}
function onMove(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!gesture) return;
  if (gesture.type === 'paint') { paintTo(e.clientX, e.clientY); return; }
  if (gesture.type === 'tap' && Math.hypot(e.clientX - gesture.start.x, e.clientY - gesture.start.y) >= TAP_SLOP) gesture.type = 'pan';
  if (gesture.type === 'pan') {
    const s = toWorld(0, 0, gesture.vb).s;
    setViewBox([gesture.vb[0] - (e.clientX - gesture.start.x) * s, gesture.vb[1] - (e.clientY - gesture.start.y) * s, gesture.vb[2], gesture.vb[3]]);
  } else if (gesture.type === 'pinch' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const m = mid(a, b);
    // 2本指の中点の下にある点を指に付いてこさせる
    const w0 = toWorld(gesture.m0.x, gesture.m0.y, gesture.vb);
    const k = gesture.d0 / Math.max(dist(a, b), 1);
    const w = clampZoom(gesture.vb[2] * k), kk = w / gesture.vb[2], s = w0.s * kk;
    setViewBox([w0.x - (m.x - w0.r.left - w0.ox) * s, w0.y - (m.y - w0.r.top - w0.oy) * s, w, gesture.vb[3] * kk]);
  }
}
function onUp(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (gesture?.type === 'paint' && gesture.to) save();
  if (gesture?.type === 'tap' && e.type === 'pointerup') {
    const id = e.target.closest?.('[data-id]')?.dataset.id;
    const hit = id && cellEls.has(id) ? id : cellAtScreen(e.clientX, e.clientY);
    if (hit) tapCell(hit);
  }
  // 2本指から1本に減ったときは、残った指で誤ってタップしないよう操作を終える
  gesture = null;
}

// ---------- 入力 ----------
function bindNumber(id, field) {
  let pushed = false;
  $(id).addEventListener('focus', () => { pushed = false; });
  $(id).addEventListener('input', () => {
    if (!pushed) { pushUndo(); pushed = true; } // 入力欄1回分を1つの取り消し単位に
    work[field] = Math.max(0, Number($(id).value) || 0);
    save();
    updateCells();
    render();
  });
}

function applyPreset(kind) {
  let mm;
  if (kind === 'none') mm = Math.round((data.z1 - data.z0) * 1000);
  else {
    const mine = [...cellEls.values()].map(({ cell }) => cell).filter(inZone);
    const pouring = mine.filter((c) => statusOf(c.id) === 'pouring');
    mm = presetMm(pouring.length ? pouring : mine, kind);
    if (mm === null) { toast(`打設中のスパンに${kind === 'slab_bottom_mm' ? 'スラブ' : '梁'}がありません。mm を直接入れてください`, 'error'); return; }
  }
  pushUndo();
  work.depth = mm;
  syncInputs();
  save();
  updateCells();
  render();
}

// ---------- 不具合を追うための記録（iPadでは開発者ツールを開けないため、設定画面で見てコピーできるようにする） ----------
let errors = load('site.errors') ?? [];
function logError(msg) {
  errors.push({ at: new Date().toISOString(), msg: String(msg).slice(0, 500) });
  errors = errors.slice(-50);
  store('site.errors', errors);
}
window.addEventListener('error', (e) => logError(`${e.message} (${e.filename}:${e.lineno})`));
window.addEventListener('unhandledrejection', (e) => logError(e.reason?.stack ?? e.reason));

function openSettings() {
  $('appVersion').textContent = APP_VERSION;
  $('errorLog').value = errors.length
    ? errors.map((x) => `${x.at}  ${x.msg}`).join('\n') + `\n（版 ${APP_VERSION}・${navigator.userAgent}）`
    : 'エラーはありません';
  $('settings').classList.remove('hidden');
}
async function copyErrors() {
  try {
    await navigator.clipboard.writeText($('errorLog').value);
    toast('コピーしました');
  } catch { // クリップボードが使えない端末では選択して手でコピーしてもらう
    $('errorLog').select();
    toast('選択した文字を長押ししてコピーしてください');
  }
}
function clearWork() {
  if (!confirm('この端末に保存した作業（スパンの状態・入力値）をすべて消します。よろしいですか？')) return;
  try {
    Object.keys(localStorage).filter((k) => k.startsWith(STORE) || k === LAST).forEach((k) => localStorage.removeItem(k));
  } catch { /* 保存できない環境 */ }
  $('settings').classList.add('hidden');
  toast('保存した作業を消しました');
  showStart();
}

// ---------- 起動 ----------
$('fileInput').addEventListener('change', (e) => {
  if (e.target.files[0]) openFile(e.target.files[0]);
  e.target.value = ''; // 同じファイルをもう一度選べるように
});
const svg = $('plan');
svg.addEventListener('pointerdown', onDown);
svg.addEventListener('pointermove', onMove);
svg.addEventListener('pointerup', onUp);
svg.addEventListener('pointercancel', onUp);
svg.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.15 : 1 / 1.15); }, { passive: false }); // PCで試すとき用
$('fit').addEventListener('click', () => setViewBox(home));
$('undo').addEventListener('click', undo);
$('bulk').addEventListener('click', () => {
  setBulk(!bulk);
  if (bulk) toast('なぞったスパンを打設済みにします（2本指で拡大・移動）');
});
bindNumber('depth', 'depth');
bindNumber('truck', 'truck');
bindNumber('extra', 'extra');
document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => applyPreset(b.dataset.preset)));
$('openOther').addEventListener('click', showStart);
$('showMissing').addEventListener('click', showMissing);
$('missingClose').addEventListener('click', () => $('missing').classList.add('hidden'));
document.querySelectorAll('[data-open-settings]').forEach((b) => b.addEventListener('click', openSettings));
$('settingsClose').addEventListener('click', () => $('settings').classList.add('hidden'));
$('copyErrors').addEventListener('click', copyErrors);
$('clearErrors').addEventListener('click', () => { errors = []; store('site.errors', errors); openSettings(); });
$('clearWork').addEventListener('click', clearWork);
// オフラインでも開けるようにする（HTTPSか localhost のときだけ動く）
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch((e) => logError(`Service Worker: ${e.message}`));
showStart();
