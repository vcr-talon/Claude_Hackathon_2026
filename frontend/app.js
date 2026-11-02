// コンクリート数量算出 画面
// 平面図と3D表示は同じThree.jsのシーンを使い、カメラだけを切り替える（要件 D19・D27）。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const $ = (id) => document.getElementById(id);
const CAT_COLORS = { 柱: 0xc62828, 梁: 0xef6c00, 壁: 0x0288d1, スラブ: 0xa0a4a8, 基礎: 0x6d4c41, 階段: 0x6a1b9a, その他: 0x546e7a };
const ZONE_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];
const ZONE_COLORS = { A: 0xe53935, B: 0x1e88e5, C: 0x43a047, D: 0xfb8c00, E: 0x8e24aa, F: 0x00897b };
const SELECT_COLOR = 0xffd600;
const ERROR_COLOR = 0xff1744;
const DIM_COLOR = 0xd5d8dc;
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const fmt = (v, d = 2) => v.toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d });
const mm = (z) => Math.round(z * 1000).toLocaleString('ja-JP');
const signed = (v) => (v > 0 ? `+${v}` : v < 0 ? `${v}` : '');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = {
  meta: null,
  z0: 0, z1: 0,
  boundaries: [], // {axis, offset(mm), points:[[x,y],[x,y]]}
  seeds: [], // {label, x, y}
  regions: [], // 直近の計算で得た分割範囲 [[外周, 穴...], ...][]
  categories: new Set(),
  selected: new Set(),
  selectedOnly: false,
  mode: 'view',
  zoneLabel: 'A',
  view: 'plan',
  pending: null, // {axis, editIndex}
  result: null,
  units: [], // 打設区分 {name, z0, z1, rangeText, label, polygons, categories, member_ids}
  unitResult: null,
};

// ---------- Three.js の準備 ----------
const viewport = $('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.localClippingEnabled = true;
viewport.appendChild(renderer.domElement);
const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.className = 'labels';
viewport.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf5f6f8);
const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f96, 1.6);
hemi.position.set(0, 0, 1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(0.6, -1, 2);
scene.add(sun);

const modelGroup = new THREE.Group();
const overlay = new THREE.Group(); // 通り芯・境界線・工区（高さ範囲の上端に置く）
const gridGroup = new THREE.Group();
const zoneGroup = new THREE.Group();
const lineGroup = new THREE.Group();
overlay.add(gridGroup, zoneGroup, lineGroup);
scene.add(modelGroup, overlay);

// 高さ範囲の切断面：z0以上、z1以下だけを描画する
const clipBottom = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const clipTop = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
const clips = [clipBottom, clipTop];

const planCam = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 20000);
planCam.up.set(0, 1, 0);
const perspCam = new THREE.PerspectiveCamera(40, 1, 0.5, 20000);
perspCam.up.set(0, 0, 1);
const planCtl = new OrbitControls(planCam, renderer.domElement);
planCtl.enableRotate = false;
planCtl.screenSpacePanning = true;
planCtl.zoomToCursor = true;
planCtl.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
const perspCtl = new OrbitControls(perspCam, renderer.domElement);
perspCtl.enabled = false;
let camera = planCam;

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  const halfH = (planCam.top - planCam.bottom) / 2;
  planCam.left = -halfH * w / h;
  planCam.right = halfH * w / h;
  planCam.updateProjectionMatrix();
  perspCam.aspect = w / h;
  perspCam.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

// ---------- 形状 ----------
let meshes = [];
const matCache = new Map();
const edgeMat = new THREE.LineBasicMaterial({ color: 0x37474f, clippingPlanes: clips, transparent: true, opacity: 0.45 });

function surfaceMat(color, opacity = 1) {
  const key = `${color}-${opacity}`;
  if (!matCache.has(key)) {
    matCache.set(key, new THREE.MeshLambertMaterial({
      color, side: THREE.DoubleSide, clippingPlanes: clips, transparent: opacity < 1, opacity,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    }));
  }
  return matCache.get(key);
}

function decode(b64, Type) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Type(buf.buffer);
}

function buildMeshes(solids) {
  modelGroup.clear();
  meshes = solids.map((s) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(decode(s.pos, Float32Array), 3));
    g.setIndex(new THREE.BufferAttribute(decode(s.idx, Uint32Array), 1));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 25), edgeMat);
    const flat = g.toNonIndexed();
    flat.computeVertexNormals();
    flat.computeBoundingBox();
    const bb = flat.boundingBox;
    const mesh = new THREE.Mesh(flat, surfaceMat(CAT_COLORS[s.category] ?? CAT_COLORS['その他']));
    mesh.userData = { ...s, pos: null, idx: null, bbox: bb };
    mesh.add(edges);
    modelGroup.add(mesh);
    return mesh;
  });
}

function paint() {
  const dimOthers = state.selectedOnly && state.selected.size > 0;
  for (const m of meshes) {
    const u = m.userData;
    m.visible = state.categories.has(u.category) && u.bbox.max.z > state.z0 && u.bbox.min.z < state.z1;
    let color = CAT_COLORS[u.category] ?? CAT_COLORS['その他'];
    let opacity = 1;
    if (!u.ok) color = ERROR_COLOR;
    else if (state.selected.has(u.member_id)) color = SELECT_COLOR;
    else if (dimOthers) { color = DIM_COLOR; opacity = 0.35; }
    m.material = surfaceMat(color, opacity);
  }
}

// ---------- 通り芯 ----------
const axisLines = new Map();
function buildGrid() {
  gridGroup.clear();
  axisLines.clear();
  for (const a of state.meta.grids) {
    const [x0, y0] = a.start, [x1, y1] = a.end;
    const d = new THREE.Vector2(x1 - x0, y1 - y0).normalize().multiplyScalar(3);
    const p0 = new THREE.Vector3(x0 - d.x, y0 - d.y, 0), p1 = new THREE.Vector3(x1 + d.x, y1 + d.y, 0);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p0, p1]),
      new THREE.LineDashedMaterial({ color: 0x607d8b, dashSize: 1.2, gapSize: 0.5, depthTest: false }));
    line.computeLineDistances();
    line.renderOrder = 5;
    gridGroup.add(line);
    axisLines.set(a.tag, line);
    for (const p of [p0, p1]) {
      const div = document.createElement('div');
      div.className = 'gridtag';
      div.textContent = a.tag;
      const label = new CSS2DObject(div);
      label.position.copy(p);
      gridGroup.add(label);
    }
  }
}

function highlightAxis(tag) {
  for (const [t, line] of axisLines) line.material.color.set(t === tag ? 0x1565c0 : 0x607d8b);
}

function offsetAxisLine(a, offsetMm) {
  const off = offsetMm / 1000;
  const [x0, y0] = a.start, [x1, y1] = a.end;
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
  let nx = dy / len, ny = -dx / len;
  if ((Math.abs(nx) >= Math.abs(ny) && nx < 0) || (Math.abs(nx) < Math.abs(ny) && ny < 0)) { nx = -nx; ny = -ny; }
  return [[x0 + nx * off, y0 + ny * off], [x1 + nx * off, y1 + ny * off]];
}

// ---------- 境界線・工区の描画 ----------
function extendedLine(points, color, dashed = false) {
  const [b0, b1, b2, b3] = state.meta.bounds;
  const reach = Math.hypot(b2 - b0, b3 - b1);
  const [p, q] = [points[0], points[points.length - 1]];
  const d = new THREE.Vector2(q[0] - p[0], q[1] - p[1]).normalize().multiplyScalar(reach);
  const pts = [new THREE.Vector3(p[0] - d.x, p[1] - d.y, 0), new THREE.Vector3(q[0] + d.x, q[1] + d.y, 0)];
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 0.8, gapSize: 0.4, depthTest: false })
    : new THREE.LineBasicMaterial({ color, depthTest: false });
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
  if (dashed) line.computeLineDistances();
  line.renderOrder = 9;
  return line;
}

function drawLines() {
  lineGroup.clear();
  state.boundaries.forEach((b, i) => {
    if (state.pending?.editIndex === i) return;
    lineGroup.add(extendedLine(b.points, 0xd50000));
  });
  if (state.pending) {
    const axis = state.meta.grids.find((a) => a.tag === state.pending.axis);
    lineGroup.add(extendedLine(offsetAxisLine(axis, Number($('pendingOff').value) || 0), 0x1565c0, true));
  }
  for (const s of state.seeds) {
    const div = document.createElement('div');
    div.className = 'seedtag';
    div.style.color = hex(ZONE_COLORS[s.label] ?? 0x333333);
    div.textContent = s.label;
    const label = new CSS2DObject(div);
    label.position.set(s.x, s.y, 0);
    lineGroup.add(label);
  }
}

function drawZones() {
  zoneGroup.clear();
  for (const z of state.result?.zones ?? []) {
    if (!z.polygons) continue;
    for (const rings of z.polygons) {
      const shape = new THREE.Shape(rings[0].map(([x, y]) => new THREE.Vector2(x, y)));
      shape.holes = rings.slice(1).map((r) => new THREE.Path(r.map(([x, y]) => new THREE.Vector2(x, y))));
      const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({
        color: ZONE_COLORS[z.label] ?? 0x888888, transparent: true, opacity: 0.16, depthTest: false, side: THREE.DoubleSide,
      }));
      mesh.renderOrder = 3;
      zoneGroup.add(mesh);
    }
  }
}

// ---------- 視点 ----------
function fit() {
  const [x0, y0, x1, y1] = state.meta.bounds;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, w = x1 - x0, h = y1 - y0;
  const aspect = viewport.clientWidth / viewport.clientHeight;
  const halfH = Math.max(h / 2, w / 2 / aspect) * 1.12;
  Object.assign(planCam, { left: -halfH * aspect, right: halfH * aspect, top: halfH, bottom: -halfH, zoom: 1 });
  planCam.position.set(cx, cy, state.meta.z_range[1] + 100);
  planCtl.target.set(cx, cy, 0);
  planCam.updateProjectionMatrix();
  planCtl.update();
  const span = Math.max(w, h);
  perspCam.position.set(cx - span * 0.7, cy - span * 1.3, state.z1 + span * 0.9);
  perspCtl.target.set(cx, cy, (state.z0 + state.z1) / 2);
  perspCtl.update();
}

function setView(view) {
  state.view = view;
  camera = view === 'plan' ? planCam : perspCam;
  planCtl.enabled = view === 'plan';
  perspCtl.enabled = view !== 'plan';
  document.querySelectorAll('button.view').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  updateHint();
}

// ---------- 高さ範囲 ----------
const elev = (name) => state.meta.storeys.find((s) => s.name === name).elevation;

function fillStoreys() {
  for (const id of ['storey', 'upBase', 'lowBase']) {
    $(id).innerHTML = state.meta.storeys.map((s) => `<option>${esc(s.name)}</option>`).join('');
  }
  const names = state.meta.storeys.map((s) => s.name);
  $('storey').value = names.includes('5SL') ? '5SL' : names[0];
  onStoreyChange();
}

function onStoreyChange() {
  const names = state.meta.storeys.map((s) => s.name);
  const i = names.indexOf($('storey').value);
  $('lowBase').value = names[i];
  $('upBase').value = names[Math.min(i + 1, names.length - 1)];
  $('lowOff').value = 0;
  $('upOff').value = 0;
  applyRange();
}

function applyRange() {
  const lo = elev($('lowBase').value) + (Number($('lowOff').value) || 0) / 1000;
  const up = elev($('upBase').value) + (Number($('upOff').value) || 0) / 1000;
  state.z0 = Math.min(lo, up);
  state.z1 = Math.max(lo, up);
  clipBottom.constant = -state.z0;
  clipTop.constant = state.z1;
  overlay.position.z = state.z1 + 0.02;
  const lowTxt = `${$('lowBase').value}${signed(Number($('lowOff').value) || 0)}`;
  const upTxt = `${$('upBase').value}${signed(Number($('upOff').value) || 0)}`;
  $('rangeText').textContent = `${lowTxt} ～ ${upTxt}（${mm(state.z0)} ～ ${mm(state.z1)} mm）`;
  paint();
  scheduleCompute();
}

// ---------- モード ----------
function setMode(mode) {
  state.mode = state.mode === mode ? 'view' : mode;
  if (state.mode !== 'boundary') cancelPending();
  document.querySelectorAll('button.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
  $('boundaryHelp').classList.toggle('hidden', state.mode !== 'boundary');
  $('zoneLabels').classList.toggle('hidden', state.mode !== 'zone');
  $('zoneHelp').classList.toggle('hidden', state.mode !== 'zone');
  $('selectHelp').classList.toggle('hidden', state.mode !== 'select');
  planCtl.mouseButtons.LEFT = state.mode === 'select' ? null : THREE.MOUSE.PAN;
  highlightAxis(null);
  updateHint();
}

function updateHint() {
  const base = state.view === 'plan' ? '左ドラッグ：移動　ホイール：拡大縮小' : '左ドラッグ：回転　右ドラッグ：移動　ホイール：拡大縮小';
  const extra = {
    boundary: state.view === 'plan' ? '　｜　通り芯をクリックして境界線を作成' : '　｜　境界線は平面表示で引いてください',
    zone: state.view === 'plan' ? `　｜　範囲をクリックして工区「${state.zoneLabel}」を付ける` : '　｜　工区名は平面表示で付けてください',
    select: '　｜　部材をクリックで選択',
    view: '　｜　部材をクリックで情報表示',
  }[state.mode];
  $('hint').textContent = base + extra;
}

function startPending(axisTag, editIndex = null) {
  state.pending = { axis: axisTag, editIndex };
  $('pendingAxis').textContent = axisTag;
  $('pendingOff').value = editIndex !== null ? state.boundaries[editIndex].offset : 0;
  $('pending').classList.remove('hidden');
  $('pendingOff').focus();
  $('pendingOff').select();
  drawLines();
}

function confirmPending() {
  if (!state.pending) return;
  const axis = state.meta.grids.find((a) => a.tag === state.pending.axis);
  const offset = Number($('pendingOff').value) || 0;
  const b = { axis: axis.tag, offset, points: offsetAxisLine(axis, offset) };
  if (state.pending.editIndex !== null) state.boundaries[state.pending.editIndex] = b;
  else state.boundaries.push(b);
  cancelPending();
  renderBoundaryList();
  scheduleCompute();
}

function cancelPending() {
  state.pending = null;
  $('pending').classList.add('hidden');
  drawLines();
}

function renderBoundaryList() {
  $('boundaryList').innerHTML = state.boundaries.map((b, i) =>
    `<li><span data-edit="${i}" title="クリックで修正">境界${i + 1}：${esc(b.axis)}通り ${b.offset >= 0 ? '+' : ''}${b.offset.toLocaleString('ja-JP')} mm</span>` +
    `<button data-del="${i}">削除</button></li>`).join('');
  drawLines();
}

function renderZoneLabels() {
  $('zoneLabels').innerHTML = ZONE_LABELS.map((l) =>
    `<button data-label="${l}" style="color:${l === state.zoneLabel ? '#fff' : hex(ZONE_COLORS[l])};` +
    `background:${l === state.zoneLabel ? hex(ZONE_COLORS[l]) : '#fff'}">${l}</button>`).join('');
}

// ---------- 画面操作（クリック・ドラッグ） ----------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function setRay(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
}
function planPoint(ev) {
  setRay(ev);
  const p = new THREE.Vector3();
  return raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -overlay.position.z), p) ? p : null;
}
function pickMember(ev) {
  setRay(ev);
  const hits = raycaster.intersectObjects(meshes.filter((m) => m.visible), false);
  const hit = hits.find((h) => h.point.z >= state.z0 - 1e-3 && h.point.z <= state.z1 + 1e-3);
  return hit ? hit.object.userData : null;
}
function worldPerPixel() {
  return (planCam.top - planCam.bottom) / planCam.zoom / viewport.clientHeight;
}
function nearestAxis(p) {
  let best = null, bestD = Infinity;
  for (const a of state.meta.grids) {
    const [x0, y0] = a.start, [x1, y1] = a.end;
    const dx = x1 - x0, dy = y1 - y0;
    const d = Math.abs(dy * (p.x - x0) - dx * (p.y - y0)) / Math.hypot(dx, dy);
    if (d < bestD) { bestD = d; best = a; }
  }
  return bestD <= 14 * worldPerPixel() ? best : null;
}
function pointInRings(x, y, rings) {
  const inRing = (ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  return inRing(rings[0]) && !rings.slice(1).some(inRing);
}
const regionOf = (x, y) => state.regions.findIndex((polys) => polys.some((rings) => pointInRings(x, y, rings)));

function onClick(ev) {
  if (state.mode === 'boundary' && state.view === 'plan') {
    const p = planPoint(ev);
    const axis = p && nearestAxis(p);
    if (axis) startPending(axis.tag);
    return;
  }
  if (state.mode === 'zone' && state.view === 'plan') {
    const p = planPoint(ev);
    if (!p) return;
    if (!state.boundaries.length) { toast('先に境界線を引いてください'); return; }
    const r = regionOf(p.x, p.y);
    const existing = state.seeds.filter((s) => regionOf(s.x, s.y) === r);
    state.seeds = state.seeds.filter((s) => !existing.includes(s));
    if (!existing.some((s) => s.label === state.zoneLabel)) state.seeds.push({ label: state.zoneLabel, x: p.x, y: p.y });
    drawLines();
    scheduleCompute();
    return;
  }
  const u = pickMember(ev);
  if (state.mode === 'select') {
    if (!u) { if (!ev.shiftKey) state.selected.clear(); }
    else if (ev.shiftKey) state.selected.has(u.member_id) ? state.selected.delete(u.member_id) : state.selected.add(u.member_id);
    else state.selected = new Set(state.selected.size === 1 && state.selected.has(u.member_id) ? [] : [u.member_id]);
    onSelectionChanged();
    return;
  }
  if (u) {
    const m = state.meta.members[u.member_id];
    toast(`${m.category}　${m.name || '(名称なし)'}　所属階：${m.storey ?? '-'}　材料：${u.material}${u.ok ? '' : '　※未計算（形状不備）'}`);
  }
}

let down = null;
const selbox = document.createElement('div');
selbox.className = 'selbox hidden';
viewport.appendChild(selbox);
renderer.domElement.addEventListener('pointerdown', (ev) => { down = { x: ev.clientX, y: ev.clientY, button: ev.button }; });
renderer.domElement.addEventListener('pointermove', (ev) => {
  if (state.mode === 'boundary' && state.view === 'plan' && !state.pending) {
    const p = planPoint(ev);
    highlightAxis(p ? nearestAxis(p)?.tag : null);
  }
  if (down && down.button === 0 && state.mode === 'select' && state.view === 'plan') {
    const r = viewport.getBoundingClientRect();
    Object.assign(selbox.style, {
      left: `${Math.min(down.x, ev.clientX) - r.left}px`, top: `${Math.min(down.y, ev.clientY) - r.top}px`,
      width: `${Math.abs(ev.clientX - down.x)}px`, height: `${Math.abs(ev.clientY - down.y)}px`,
    });
    selbox.classList.remove('hidden');
  }
});
renderer.domElement.addEventListener('pointerup', (ev) => {
  if (!down) return;
  const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
  if (down.button === 0 && moved < 5) onClick(ev);
  else if (down.button === 0 && state.mode === 'select' && state.view === 'plan') boxSelect(down, ev);
  selbox.classList.add('hidden');
  down = null;
});

function boxSelect(a, b) {
  const p = planPoint({ clientX: a.x, clientY: a.y }), q = planPoint(b);
  if (!p || !q) return;
  const [x0, x1] = [Math.min(p.x, q.x), Math.max(p.x, q.x)], [y0, y1] = [Math.min(p.y, q.y), Math.max(p.y, q.y)];
  if (!b.shiftKey) state.selected.clear();
  for (const m of meshes) {
    if (!m.visible) continue;
    const bb = m.userData.bbox;
    const cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2;
    if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) state.selected.add(m.userData.member_id);
  }
  onSelectionChanged();
}

function onSelectionChanged() {
  $('selInfo').textContent = state.selected.size ? `${state.selected.size} 部材を選択中` : '';
  paint();
  if (state.selectedOnly) scheduleCompute();
}

let toastTimer = null;
function toast(msg) {
  $('hint').textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(updateHint, 5000);
}

// ---------- 計算 ----------
let computeTimer = null, computeSeq = 0;
function scheduleCompute() {
  clearTimeout(computeTimer);
  computeTimer = setTimeout(runCompute, 120);
}

async function runCompute() {
  if (!state.meta) return;
  const seq = ++computeSeq;
  const body = {
    z0: state.z0, z1: state.z1,
    boundaries: state.boundaries.map((b) => b.points),
    seeds: state.seeds,
    categories: [...state.categories],
    member_ids: state.selectedOnly ? [...state.selected] : null,
  };
  const res = await fetch('/api/compute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (seq !== computeSeq) return;
  if (!res.ok) {
    $('resultBody').innerHTML = `<div class="warn">計算できません：${esc((await res.json()).detail)}</div>`;
    return;
  }
  // 登録時に「計算した時点の条件」をそのまま使えるよう、条件も一緒に持っておく
  state.result = { ...(await res.json()), request: body, rangeText: $('rangeText').textContent };
  state.regions = state.result.regions;
  drawZones();
  renderResults();
}

function renderResults() {
  const r = state.result;
  const allCats = state.categories.size === state.meta.categories.length;
  const filters = [];
  if (!allCats) filters.push(`部材種別：${[...state.categories].join('・')}`);
  if (state.selectedOnly) filters.push(`選択部材のみ（${state.selected.size}部材）`);
  let html = `<div class="muted">高さ範囲：${esc($('rangeText').textContent)}</div>`;
  if (filters.length) html += `<div class="muted">絞り込み：${esc(filters.join('／'))}</div>`;
  const labeled = r.zones.filter((z) => z.polygons);
  if (state.boundaries.length && !labeled.length) {
    html += '<div class="help">工区名が未設定です。「工区名を付ける」で範囲をクリックしてください（下は範囲全体の数量）</div>';
  }
  if (r.zones.length > 1) {
    const sum = r.zones.reduce((a, z) => a + z.total, 0);
    html += `<div class="sum">工区合計 <div class="total">${fmt(sum)} m³</div>` +
      `<div class="muted">${r.zones.map((z) => `${esc(z.label)} ${fmt(z.total)}`).join(' ＋ ')}</div></div>`;
  }
  for (const z of r.zones) {
    const color = ZONE_COLORS[z.label];
    html += `<div class="zone"><h3>${color ? `<span class="chip" style="background:${hex(color)}"></span>工区 ` : ''}${esc(z.label)}</h3>`;
    html += `<div class="total">${fmt(z.total)} <small>m³</small></div>`;
    html += '<table class="mini">';
    for (const [cat, v] of Object.entries(z.by_category)) {
      if (v < 0.0005) continue;
      html += `<tr><td><span class="chip" style="background:${hex(CAT_COLORS[cat] ?? 0x546e7a)}"></span> ${esc(cat)}</td><td class="num">${fmt(v)}</td></tr>`;
    }
    html += '</table>';
    const mats = Object.entries(z.by_material);
    if (mats.length > 1) {
      html += '<table class="mini">' + mats.map(([m, v]) => `<tr><td>${esc(m)}</td><td class="num">${fmt(v)}</td></tr>`).join('') + '</table>';
    }
    html += `<div class="muted">対象 ${z.members.length} 部材　重複控除 ${fmt(z.overlap)} m³（単純合計 ${fmt(z.raw_sum)}）</div>`;
    if (z.uncomputed.length) {
      const ref = z.uncomputed.reduce((a, u) => a + (u.reference_volume || 0), 0);
      html += `<details><summary class="warn">⚠ 未計算 ${z.uncomputed.length} 件（参考体積 ${fmt(ref)} m³・総数量に含まず）</summary><table class="mini">` +
        z.uncomputed.map((u) => `<tr><td>${esc(u.category)} ${esc(u.name)}</td><td>${esc(u.reason)}</td></tr>`).join('') + '</table></details>';
    }
    html += `<details><summary>対象部材の一覧</summary><table class="mini">` +
      z.members.slice(0, 300).map((m) => `<tr><td>${esc(m.category)}</td><td>${esc(m.name)}</td><td class="num">${fmt(m.volume, 3)}</td></tr>`).join('') +
      '</table><div class="muted">部材ごとの値は範囲内に切り取った体積（重複控除前）</div></details>';
    if (z.total > 0) html += `<button class="reg" data-reg="${r.zones.indexOf(z)}">＋ 打設区分に登録</button>`;
    html += '</div>';
  }
  html += '<div class="muted">内訳は「柱→梁→壁→スラブ→基礎→階段→その他」の順で重なりを配分した参考値です。総数量は重複を除いた体積です。</div>';
  $('resultBody').innerHTML = html;
}

// ---------- 打設区分 ----------
function registerUnit(zi) {
  const r = state.result, z = r.zones[zi], req = r.request;
  const allCats = req.categories.length === state.meta.categories.length;
  let name = r.rangeText.split('（')[0];
  if (z.polygons) name += ` ${z.label}工区`;
  if (!allCats) name += `（${req.categories.join('・')}）`;
  if (req.member_ids) name += `（選択${req.member_ids.length}部材）`;
  state.units.push({
    name, z0: r.z0, z1: r.z1, rangeText: r.rangeText,
    label: z.polygons ? z.label : null, polygons: z.polygons,
    categories: allCats ? null : req.categories, member_ids: req.member_ids,
  });
  state.unitResult = null;
  renderUnits();
  runUnits();
}

let unitSeq = 0;
async function runUnits() {
  const seq = ++unitSeq;
  if (!state.units.length) { state.unitResult = null; renderUnits(); return; }
  const body = { units: state.units.map(({ name, z0, z1, polygons, categories, member_ids }) => ({ name, z0, z1, polygons, categories, member_ids })) };
  const res = await fetch('/api/units', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (seq !== unitSeq) return;
  if (!res.ok) { $('unitSummary').innerHTML = `<div class="warn">計算できません：${esc((await res.json()).detail)}</div>`; return; }
  state.unitResult = await res.json();
  renderUnits();
}

function renderUnits() {
  const ur = state.unitResult;
  const overlapping = new Set((ur?.overlaps ?? []).filter((o) => o.members.length).flatMap((o) => [o.a, o.b]));
  $('unitHelp').classList.toggle('hidden', state.units.length > 0);
  $('unitList').innerHTML = state.units.map((u, i) => {
    const res = ur?.units[i];
    const filters = [u.categories ? u.categories.join('・') : null, u.member_ids ? `選択${u.member_ids.length}部材` : null].filter(Boolean);
    return `<li class="${overlapping.has(i) ? 'overlap' : ''}"><div class="unitrow">` +
      `<span class="chip" style="background:${hex(ZONE_COLORS[u.label] ?? 0x90a4ae)}"></span>` +
      `<input class="name" data-uname="${i}" value="${esc(u.name)}" title="区分名（変更できます）">` +
      `<span class="num">${res ? `${fmt(res.total)} m³` : '計算中…'}</span><button data-udel="${i}">削除</button></div>` +
      `<div class="muted">区分${i + 1}：${esc(u.rangeText)}　${u.label ? `工区${esc(u.label)}` : '範囲全体'}` +
      `${filters.length ? `　絞り込み：${esc(filters.join('／'))}` : ''}` +
      `${res?.uncomputed_count ? `　<span class="warn">⚠ 未計算 ${res.uncomputed_count} 件</span>` : ''}</div></li>`;
  }).join('');
  renderUnitSummary();
}

function renderUnitSummary() {
  const ur = state.unitResult;
  if (!ur || !state.units.length) { $('unitSummary').innerHTML = ''; return; }
  const unitName = (i) => `区分${i + 1}「${esc(state.units[i].name)}」`;
  let html = `<div class="unitsum">区分の合計<span class="num">${fmt(ur.sum_total)} m³</span></div>`;
  // 同じ部材が2つの区分に入っている＝登録の誤りの可能性が高いので黄色で警告する
  const shared = ur.overlaps.filter((o) => o.members.length);
  // 別の部材どうしの食い込み（柱とスラブの取り合いなど）は、モデル上避けられないので注記にとどめる
  const contact = ur.overlaps.filter((o) => o.volume - o.shared_volume > 0.0005);
  if (shared.length) {
    html += '<div class="overlapbox">⚠ 同じ部材が複数の区分に入っています。重なった部分は区分の合計で二重に数えています。';
    for (const o of shared) {
      html += `<div style="margin-top:6px"><b>${unitName(o.a)} と ${unitName(o.b)}</b>：${fmt(o.shared_volume)} m³</div>` +
        `<details><summary>重なっている部材（${o.members.length}）</summary><table class="mini">` +
        o.members.slice(0, 100).map((m) => `<tr><td>${esc(m.category)}</td><td>${esc(m.name)}</td><td class="num">${fmt(m.volume, 3)}</td></tr>`).join('') +
        '</table></details>';
    }
    html += '</div>';
  }
  if (contact.length) {
    html += '<div class="muted" style="margin-top:6px">部材どうしの食い込み（柱とスラブの取り合いなど）を両方の区分で数えている部分：' +
      contact.map((o) => `区分${o.a + 1}と${o.b + 1}で ${fmt(o.volume - o.shared_volume, 3)} m³`).join('、') + '</div>';
  }
  if (ur.overlaps.length) {
    html += `<div class="unitsum" style="margin-top:6px">重複を除いた合計<span class="num">${fmt(ur.union_total)} m³</span></div>`;
  } else if (state.units.length > 1) {
    html += '<div class="muted" style="margin-top:4px">区分どうしの重なりはありません</div>';
  }
  $('unitSummary').innerHTML = html;
}

// ---------- 初期化 ----------
function renderSidebar() {
  const m = state.meta;
  $('modelInfo').textContent = `${m.source}（${m.schema}）　コンクリート立体 ${m.solid_count} 件` +
    (m.uncomputed.length ? `　未計算 ${m.uncomputed.length} 件` : '');
  $('materials').innerHTML = Object.entries(m.materials).map(([name, info]) =>
    `<tr><td>${info.included ? '✅ 対象' : '— 除外'}</td><td>${esc(name)}</td><td class="num">${info.count}</td></tr>`).join('');
  state.categories = new Set(m.categories);
  $('categories').innerHTML = m.categories.map((c) =>
    `<label><input type="checkbox" data-cat="${esc(c)}" checked><span class="chip" style="background:${hex(CAT_COLORS[c])}"></span>${esc(c)}</label>`).join('');
}

async function loadModel() {
  $('loading').classList.remove('hidden');
  const res = await fetch('/api/model');
  if (!res.ok) {
    $('loading').textContent = 'IFCファイルを開いてください（左上「IFCを開く」）';
    return;
  }
  state.meta = await res.json();
  state.boundaries = [];
  state.seeds = [];
  state.selected.clear();
  state.units = [];
  state.unitResult = null;
  renderUnits();
  buildMeshes(await (await fetch('/api/meshes')).json());
  buildGrid();
  renderSidebar();
  renderBoundaryList();
  fillStoreys();
  resize();
  fit();
  $('loading').classList.add('hidden');
}

$('storey').addEventListener('change', onStoreyChange);
for (const id of ['upBase', 'lowBase', 'upOff', 'lowOff']) $(id).addEventListener('change', applyRange);
document.querySelectorAll('button.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
document.querySelectorAll('button.view').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('fit').addEventListener('click', fit);
$('pendingOk').addEventListener('click', confirmPending);
$('pendingCancel').addEventListener('click', cancelPending);
$('pendingOff').addEventListener('input', drawLines);
$('pendingOff').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') confirmPending(); });
window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { cancelPending(); if (state.mode !== 'view') setMode(state.mode); } });
$('boundaryList').addEventListener('click', (ev) => {
  const del = ev.target.dataset.del, edit = ev.target.dataset.edit;
  if (del !== undefined) {
    // 範囲の形が変わり名前の対応が崩れるため、工区名は付け直してもらう
    state.boundaries.splice(Number(del), 1);
    state.seeds = [];
    renderBoundaryList(); drawLines(); scheduleCompute();
  }
  if (edit !== undefined) { if (state.mode !== 'boundary') setMode('boundary'); startPending(state.boundaries[Number(edit)].axis, Number(edit)); }
});
$('zoneLabels').addEventListener('click', (ev) => {
  if (!ev.target.dataset.label) return;
  state.zoneLabel = ev.target.dataset.label;
  renderZoneLabels();
  updateHint();
});
$('categories').addEventListener('change', (ev) => {
  const c = ev.target.dataset.cat;
  ev.target.checked ? state.categories.add(c) : state.categories.delete(c);
  paint();
  scheduleCompute();
});
$('resultBody').addEventListener('click', (ev) => {
  if (ev.target.dataset.reg !== undefined) registerUnit(Number(ev.target.dataset.reg));
});
$('unitList').addEventListener('click', (ev) => {
  if (ev.target.dataset.udel === undefined) return;
  state.units.splice(Number(ev.target.dataset.udel), 1);
  state.unitResult = null;
  renderUnits();
  runUnits();
});
$('unitList').addEventListener('input', (ev) => {
  if (ev.target.dataset.uname === undefined) return;
  state.units[Number(ev.target.dataset.uname)].name = ev.target.value;
  renderUnitSummary();
});
$('clearSel').addEventListener('click', () => { state.selected.clear(); onSelectionChanged(); });
$('selectedOnly').addEventListener('change', (ev) => { state.selectedOnly = ev.target.checked; paint(); scheduleCompute(); });
$('fileInput').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  $('loading').textContent = `${file.name} を読み込んでいます…（初回は数十秒かかります）`;
  $('loading').classList.remove('hidden');
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/open', { method: 'POST', body: fd });
  if (!res.ok) { $('loading').textContent = `読み込めませんでした：${(await res.json()).detail}`; return; }
  await loadModel();
});

renderZoneLabels();
resize();
setView('plan');
animate();
loadModel();
