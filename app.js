"use strict";

// 単位はすべて cm。家具の x, y は左上の座標。
const STORAGE_KEY = "lab-layout-v1";
const SNAP = 5;           // ドラッグ時のスナップ幅 (cm)
const GRID = 50;          // 背景グリッド間隔 (cm)
const MARGIN = 30;        // 部屋の外側の余白 (cm)
const SVG_NS = "http://www.w3.org/2000/svg";

const PRESETS = [
  { name: "机", w: 120, d: 60, color: "#9ec5e8" },
  { name: "椅子", w: 45, d: 45, color: "#f2c48d" },
  { name: "本棚", w: 90, d: 30, color: "#b9a38a" },
  { name: "ロッカー", w: 90, d: 45, color: "#b8c4d0" },
  { name: "ホワイトボード", w: 180, d: 10, color: "#e5e7eb" },
  { name: "会議テーブル", w: 240, d: 120, color: "#a7d7b5" },
];

const state = loadState();
let selectedId = null;
let drag = null;

const $ = (id) => document.getElementById(id);
const roomSvg = $("room");
const statusEl = $("status");

// ---------- 状態の保存・読み込み ----------

function loadState() {
  const fallback = { room: { w: 800, d: 600 }, items: [], nextId: 1 };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && saved.room && Array.isArray(saved.items)) return saved;
  } catch (e) { /* 保存データなし・破損時は初期状態 */ }
  return fallback;
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) { /* 保存できなくても動作は継続 */ }
}

// ---------- 幾何・衝突判定 ----------

function size(item) {
  return item.rot ? { w: item.d, d: item.w } : { w: item.w, d: item.d };
}

function inRoom(w, d, x, y) {
  return x >= 0 && y >= 0 && x + w <= state.room.w && y + d <= state.room.d;
}

// 辺が接するだけ (隣り合う) の場合は重なりとみなさない
function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.d && b.y < a.y + a.d;
}

// 指定位置に置けるか (部屋の内側で、他の家具と重ならない)
function canPlace(item, x, y, w, d) {
  if (!inRoom(w, d, x, y)) return false;
  const rect = { x, y, w, d };
  return state.items.every((o) => {
    if (o.id === item.id) return true;
    const s = size(o);
    return !overlaps(rect, { x: o.x, y: o.y, w: s.w, d: s.d });
  });
}

// 現在位置から目標位置へ 1cm ずつ進める。
// 障害物 (先に置かれた家具・壁) にぶつかったらその軸の移動だけ止め、反対の軸は滑らせる。
// 1cm 刻みなので、素早く動かしても他の家具をすり抜けない。
function moveToward(item, tx, ty) {
  const { w, d } = size(item);
  let blocked = false;
  for (let guard = 0; guard < 5000 && (item.x !== tx || item.y !== ty); guard++) {
    let moved = false;
    if (item.x !== tx) {
      const nx = item.x + Math.sign(tx - item.x);
      if (canPlace(item, nx, item.y, w, d)) { item.x = nx; moved = true; }
    }
    if (item.y !== ty) {
      const ny = item.y + Math.sign(ty - item.y);
      if (canPlace(item, item.x, ny, w, d)) { item.y = ny; moved = true; }
    }
    if (!moved) { blocked = true; break; }
  }
  return blocked;
}

// 新規追加用: 部屋の中で空いている場所を左上から探す
function findFreeSpot(w, d) {
  const dummy = { id: -1 };
  for (let y = 0; y + d <= state.room.d; y += SNAP) {
    for (let x = 0; x + w <= state.room.w; x += SNAP) {
      if (canPlace(dummy, x, y, w, d)) return { x, y };
    }
  }
  return null;
}

// ---------- 描画 ----------

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function fitFont(label, w, d, max) {
  const len = Math.max(1, [...label].length);
  return Math.max(6, Math.min(max, (w * 0.9) / len, d * 0.5));
}

function render() {
  const { w: rw, d: rd } = state.room;
  roomSvg.setAttribute("viewBox", `${-MARGIN} ${-MARGIN} ${rw + MARGIN * 2} ${rd + MARGIN * 2}`);
  roomSvg.replaceChildren();

  el("rect", { x: 0, y: 0, width: rw, height: rd, fill: "#fafafa", stroke: "#111827", "stroke-width": 4 }, roomSvg);
  for (let x = GRID; x < rw; x += GRID) {
    el("line", { x1: x, y1: 0, x2: x, y2: rd, stroke: "#e5e7eb", "stroke-width": 1 }, roomSvg);
  }
  for (let y = GRID; y < rd; y += GRID) {
    el("line", { x1: 0, y1: y, x2: rw, y2: y, stroke: "#e5e7eb", "stroke-width": 1 }, roomSvg);
  }
  const dim = { fill: "#6b7280", "font-size": 14, "text-anchor": "middle" };
  const top = el("text", { ...dim, x: rw / 2, y: -10 }, roomSvg);
  top.textContent = `${rw} cm`;
  const left = el("text", { ...dim, x: -10, y: rd / 2, transform: `rotate(-90 -10 ${rd / 2})` }, roomSvg);
  left.textContent = `${rd} cm`;

  // 配列の順 = 置かれた順。後ろの要素ほど手前に描画される。
  for (const item of state.items) {
    const { w, d } = size(item);
    const g = el("g", { class: "item" + (item.id === selectedId ? " selected" : ""), "data-id": item.id }, roomSvg);
    el("rect", { x: item.x, y: item.y, width: w, height: d, fill: item.color, rx: 2 }, g);
    const cx = item.x + w / 2;
    const cy = item.y + d / 2;
    const fs = fitFont(item.name, w, d, 16);
    const t = el("text", { x: cx, y: d >= fs * 2.6 ? cy - fs * 0.6 : cy, "font-size": fs }, g);
    t.textContent = item.name;
    if (d >= fs * 2.6) {
      const s = el("text", { x: cx, y: cy + fs * 0.8, "font-size": fs * 0.75, opacity: 0.7 }, g);
      s.textContent = `${w}×${d}`;
    }
  }

  renderSelected();
}

function renderSelected() {
  const item = state.items.find((i) => i.id === selectedId);
  $("selected-card").hidden = !item;
  if (!item) return;
  const { w, d } = size(item);
  $("sel-info").textContent = `${item.name}  ${w} × ${d} cm  (${item.x}, ${item.y})`;
}

function renderPreview() {
  const svg = $("preview");
  svg.replaceChildren();
  const name = $("f-name").value.trim() || "(名称なし)";
  const w = Number($("f-w").value);
  const d = Number($("f-d").value);
  if (!(w > 0 && d > 0)) return;

  const pad = 20;
  const scale = Math.min(1, 300 / w, 110 / d); // 表示領域に収まるように縮小 (実寸比は維持)
  const pw = w * scale;
  const pd = d * scale;
  svg.setAttribute("viewBox", `${-pad} ${-pad} ${pw + pad * 2} ${pd + pad * 2}`);
  el("rect", { x: 0, y: 0, width: pw, height: pd, fill: $("f-color").value, stroke: "#334155", "stroke-width": 1.5, rx: 2 }, svg);
  const fs = fitFont(name, pw, pd, 14);
  el("text", { x: pw / 2, y: pd / 2, "font-size": fs }, svg).textContent = name;
  const dimAttrs = { fill: "#6b7280", "font-size": 10, "text-anchor": "middle" };
  el("text", { ...dimAttrs, x: pw / 2, y: -6 }, svg).textContent = `${w} cm`;
  el("text", { ...dimAttrs, x: -6, y: pd / 2, transform: `rotate(-90 -6 ${pd / 2})` }, svg).textContent = `${d} cm`;
}

function setStatus(text, warn = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("warn", warn);
}

// ---------- ドラッグ操作 ----------

function pointerToRoom(ev) {
  const pt = roomSvg.createSVGPoint();
  pt.x = ev.clientX;
  pt.y = ev.clientY;
  return pt.matrixTransform(roomSvg.getScreenCTM().inverse());
}

roomSvg.addEventListener("pointerdown", (ev) => {
  const g = ev.target.closest(".item");
  if (!g) {
    selectedId = null;
    render();
    return;
  }
  const item = state.items.find((i) => i.id === Number(g.dataset.id));
  const p = pointerToRoom(ev);
  selectedId = item.id;
  drag = { item, dx: p.x - item.x, dy: p.y - item.y, moved: false };
  // 選択した家具を最前面に描画する (配列順=優先順位なので、描画だけ後ろに回す)
  render();
  roomSvg.querySelector(`.item[data-id="${item.id}"]`).classList.add("dragging");
  roomSvg.setPointerCapture(ev.pointerId);
});

roomSvg.addEventListener("pointermove", (ev) => {
  if (!drag) return;
  const p = pointerToRoom(ev);
  const { item } = drag;
  const tx = Math.round((p.x - drag.dx) / SNAP) * SNAP;
  const ty = Math.round((p.y - drag.dy) / SNAP) * SNAP;
  const { w, d } = size(item);
  // 目標が部屋の外なら壁際に寄せる
  const cx = Math.min(Math.max(tx, 0), state.room.w - w);
  const cy = Math.min(Math.max(ty, 0), state.room.d - d);
  const before = { x: item.x, y: item.y };
  const blocked = moveToward(item, cx, cy);
  if (item.x !== before.x || item.y !== before.y) drag.moved = true;
  setStatus(blocked ? "他の家具と重なるため、これ以上動かせません" : "家具をドラッグして移動できます", blocked);
  updateDraggedElement(item);
});

function updateDraggedElement(item) {
  const g = roomSvg.querySelector(`.item[data-id="${item.id}"]`);
  if (!g) return;
  const { w, d } = size(item);
  g.querySelector("rect").setAttribute("x", item.x);
  g.querySelector("rect").setAttribute("y", item.y);
  const texts = g.querySelectorAll("text");
  const fs = fitFont(item.name, w, d, 16);
  const two = texts.length > 1;
  texts[0].setAttribute("x", item.x + w / 2);
  texts[0].setAttribute("y", item.y + d / 2 - (two ? fs * 0.6 : 0));
  if (two) {
    texts[1].setAttribute("x", item.x + w / 2);
    texts[1].setAttribute("y", item.y + d / 2 + fs * 0.8);
  }
}

function endDrag() {
  if (!drag) return;
  if (drag.moved) saveState();
  drag = null;
  render();
}
roomSvg.addEventListener("pointerup", endDrag);
roomSvg.addEventListener("pointercancel", endDrag);

// ---------- 家具の追加・編集 ----------

function addFurniture() {
  const msg = $("add-msg");
  const name = $("f-name").value.trim();
  const w = Number($("f-w").value);
  const d = Number($("f-d").value);
  if (!name) { msg.textContent = "名称を入力してください"; return; }
  if (!(w > 0 && d > 0)) { msg.textContent = "幅と奥行は 0 より大きい値にしてください"; return; }
  const spot = findFreeSpot(w, d);
  if (!spot) { msg.textContent = "空きスペースがないため追加できません"; return; }

  const item = { id: state.nextId++, name, w, d, x: spot.x, y: spot.y, rot: false, color: $("f-color").value };
  state.items.push(item);
  selectedId = item.id;
  msg.textContent = "";
  saveState();
  render();
}

function rotateSelected() {
  const item = state.items.find((i) => i.id === selectedId);
  if (!item) return;
  const rotated = { ...item, rot: !item.rot };
  const { w, d } = size(rotated);
  if (!canPlace(item, item.x, item.y, w, d)) {
    setStatus("回転すると他の家具や壁と重なるため回転できません", true);
    return;
  }
  item.rot = rotated.rot;
  setStatus("家具をドラッグして移動できます");
  saveState();
  render();
}

function deleteSelected() {
  if (selectedId === null) return;
  state.items = state.items.filter((i) => i.id !== selectedId);
  selectedId = null;
  saveState();
  render();
}

function applyRoomSize() {
  const w = Math.round(Number($("room-w").value));
  const d = Math.round(Number($("room-d").value));
  if (!(w >= 100 && d >= 100)) { setStatus("部屋は 100cm 以上にしてください", true); return; }
  const fits = state.items.every((i) => {
    const s = size(i);
    return i.x + s.w <= w && i.y + s.d <= d;
  });
  if (!fits) {
    setStatus("はみ出す家具があるため、部屋を小さくできません", true);
    $("room-w").value = state.room.w;
    $("room-d").value = state.room.d;
    return;
  }
  state.room = { w, d };
  setStatus("家具をドラッグして移動できます");
  saveState();
  render();
}

// ---------- イベント登録 ----------

for (const p of PRESETS) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = p.name;
  b.addEventListener("click", () => {
    $("f-name").value = p.name;
    $("f-w").value = p.w;
    $("f-d").value = p.d;
    $("f-color").value = p.color;
    renderPreview();
  });
  $("presets").appendChild(b);
}

for (const id of ["f-name", "f-w", "f-d", "f-color"]) $(id).addEventListener("input", renderPreview);
$("f-add").addEventListener("click", addFurniture);
$("sel-rotate").addEventListener("click", rotateSelected);
$("sel-delete").addEventListener("click", deleteSelected);
$("room-apply").addEventListener("click", applyRoomSize);
$("reset").addEventListener("click", () => {
  if (state.items.length === 0 || !confirm("配置した家具をすべて削除しますか？")) return;
  state.items = [];
  selectedId = null;
  saveState();
  render();
});

document.addEventListener("keydown", (ev) => {
  if (/^(INPUT|TEXTAREA)$/.test(ev.target.tagName)) return;
  if (ev.key === "r" || ev.key === "R") rotateSelected();
  else if (ev.key === "Delete" || ev.key === "Backspace") deleteSelected();
});

$("room-w").value = state.room.w;
$("room-d").value = state.room.d;
render();
renderPreview();
