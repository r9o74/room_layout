(() => {
  const SNAP = 5;          // cm
  const STORE = "lab-layout-tpl-v1";
  const NS = "http://www.w3.org/2000/svg";
  const ROOM = { w: 660, h: 480 };   // 部屋のサイズ (固定)
  const PRESETS = [
    ["長机A", 120, 60, 0], ["長机B", 200, 60, 0], ["長机C", 240, 60, 0],
    ["椅子", 50, 50, 1], ["卓", 80, 80, 2],
    ["プリンタ", 60, 50, 4], ["冷蔵庫", 60, 60, 5],
    ["丸椅子", 40, 40, 1, "circle"]
  ];
  // Template: fixed furniture. Cannot be moved, rotated, duplicated, resized or deleted; only the color can change.
  // This is the initial layout and what "すべて削除" returns to.
  const TEMPLATE = [
    ["柱", 0, 0, 50, 30, 4], ["シンク", 50, 0, 90, 50, 4], ["柱", 610, 0, 50, 30, 4],
    ["ホワイトボード", 650, 60, 10, 250, 3], ["傘立て", 610, 320, 50, 25, 4], ["エントランス", 560, 345, 100, 100, 5],
    ["柱", 0, 450, 50, 30, 4], ["靴箱", 560, 445, 50, 35, 4], ["柱", 610, 450, 50, 30, 4],
    ["ホワイトボード", 130, 470, 360, 10, 3]
  ];
  const templateItems = () =>
    TEMPLATE.map(([name, x, y, w, d, c], i) => ({ id: "t" + i, name, x, y, w, d, c, fixed: true }));
  // cloud: the saved layout being edited ({ id, name, author, updated_at }) or null.
  // dirty: changed since it was last saved / opened. pendingName: suggested name for the next "新規保存" (after a copy).
  // added: furniture was added (form / duplicate / paste) since the last save; "新規レイアウト" asks before discarding it.
  const initial = () => ({ room: { ...ROOM }, items: templateItems(), cloud: null, dirty: false, pendingName: null, added: false });

  let state = load() || initial();
  let sel = new Set();
  let panel = null;        // "color" | "size" | "name" | null: which panel of the floating menu is open
  let marquee = null;
  let blockerId = null, blockerTimer = 0;
  let drag = null;
  let fColor = 0;
  let clipboard = [];    // pieces copied with Ctrl/⌘+C (snapshots; pasting reuses the duplicate placement)
  let fShape = "rect";   // shape chosen in the add form: "rect" | "circle" | "tri"

  const $ = id => document.getElementById(id);
  const svg = $("plan");

  // Rebuild items from stored / downloaded data. The template always comes from the code (only its colors are kept),
  // and other items are sanitized because saved layouts can be written by anyone.
  function itemsFrom(list) {
    const arr = Array.isArray(list) ? list.filter(i => i && typeof i === "object") : [];
    const color = c => (Number.isInteger(c) && c >= 0 && c < 6 ? c : 0);
    const num = v => (Number.isFinite(+v) ? Math.round(+v) : -1);
    const fixed = templateItems();
    for (const f of fixed) {
      const o = arr.find(i => i.id === f.id);
      if (o) f.c = color(o.c);
    }
    const own = arr.filter(i => !i.fixed).map(i => ({
      id: typeof i.id === "string" && i.id && !/^t\d+$/.test(i.id) ? i.id.slice(0, 32) : uid(),
      name: String(i.name ?? "").slice(0, 24), x: num(i.x), y: num(i.y), w: num(i.w), d: num(i.d),
      c: color(i.c), r: ((num(i.r) % 4) + 4) % 4,
      ...(i.s === "circle" || i.s === "tri" ? { s: i.s } : {}),
      ...(i.u === true ? { u: true } : {})
    })).map(i => (i.s === "circle" ? { ...i, d: i.w } : i)).filter(i => i.name && i.w >= 10 && i.d >= 10 && i.x >= 0 && i.y >= 0 && i.x + i.w <= ROOM.w && i.y + i.d <= ROOM.h);
    return [...fixed, ...own];
  }
  function cloudOf(row) { return { id: row.id, name: row.name, author: row.author, updated_at: row.updated_at }; }
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE));
      if (!s || !Array.isArray(s.items)) return null;
      const cloud = s.cloud && typeof s.cloud.id === "string" ? cloudOf(s.cloud) : null;
      return { room: { ...ROOM }, items: itemsFrom(s.items), cloud, dirty: !!s.dirty, pendingName: typeof s.pendingName === "string" ? s.pendingName : null, added: !!s.added };
    } catch (e) { }
    return null;
  }
  function persist() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { } }
  // Called after every edit: remembers the layout in this browser and marks it as having unsaved changes.
  function save() { state.dirty = true; persist(); }
  function uid() { return Math.random().toString(36).slice(2, 9); }   // declared (hoisted) because load() runs first
  const snap = v => Math.round(v / SNAP) * SNAP;
  const byId = id => state.items.find(i => i.id === id);
  const selItems = () => state.items.filter(i => sel.has(i.id));
  // Selected items that can be moved / rotated / duplicated / deleted (none when a fixed item is selected)
  const movableSel = () => { const s = selItems(); return s.length && s.every(i => !i.fixed) ? s : []; };
  function setSel(ids) {
    const n = new Set(ids);
    if (n.size !== sel.size || [...n].some(i => !sel.has(i))) panel = null;
    sel = n;
  }

  // ---------- collision ----------
  // Shapes: rect (default), circle (w = d = diameter), tri (right triangle whose legs are the box edges).
  // For a triangle, r (quarter turns clockwise) decides which corner holds the right angle: 0 = bottom-left, 1 = top-left, 2 = top-right, 3 = bottom-right.
  const EPS = 1e-6;
  const shapeOf = o => (o.s === "circle" ? "circle" : o.s === "tri" ? "tri" : "rect");
  function polyOf(o) {
    const { x, y, w, d } = o, x2 = x + w, y2 = y + d;
    if (shapeOf(o) === "tri") {
      return [[[x, y2], [x2, y2], [x, y]], [[x, y], [x2, y], [x, y2]], [[x2, y], [x, y], [x2, y2]], [[x2, y2], [x, y2], [x2, y]]][((o.r || 0) % 4 + 4) % 4];
    }
    return [[x, y], [x2, y], [x2, y2], [x, y2]];
  }
  // Separating-axis test for convex shapes; shapes that only touch do not overlap.
  function convexOverlap(a, b) {
    const sa = shapeOf(a) === "circle" ? { c: [a.x + a.w / 2, a.y + a.d / 2], rad: a.w / 2 } : { pts: polyOf(a) };
    const sb = shapeOf(b) === "circle" ? { c: [b.x + b.w / 2, b.y + b.d / 2], rad: b.w / 2 } : { pts: polyOf(b) };
    const axes = [];
    for (const sh of [sa, sb]) if (sh.pts) sh.pts.forEach((p, i) => {
      const q = sh.pts[(i + 1) % sh.pts.length], nx = q[1] - p[1], ny = p[0] - q[0], l = Math.hypot(nx, ny);
      axes.push([nx / l, ny / l]);
    });
    for (const [c, other] of [[sa, sb], [sb, sa]]) if (c.c && other.pts) {   // circle vs polygon: axis to the nearest vertex
      let best = null, bd = Infinity;
      for (const p of other.pts) { const dd = Math.hypot(p[0] - c.c[0], p[1] - c.c[1]); if (dd < bd) { bd = dd; best = p; } }
      const l = bd || 1; axes.push([(best[0] - c.c[0]) / l, (best[1] - c.c[1]) / l]);
    }
    const proj = (sh, [ax, ay]) => {
      if (sh.c) { const m = sh.c[0] * ax + sh.c[1] * ay; return [m - sh.rad, m + sh.rad]; }
      const v = sh.pts.map(p => p[0] * ax + p[1] * ay); return [Math.min(...v), Math.max(...v)];
    };
    return axes.every(ax => { const [a0, a1] = proj(sa, ax), [b0, b1] = proj(sb, ax); return a1 - b0 > EPS && b1 - a0 > EPS; });
  }
  function overlap(a, b) {
    if (!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.d && b.y < a.y + a.d)) return false;   // boxes apart
    const ka = shapeOf(a), kb = shapeOf(b);
    if (ka === "rect" && kb === "rect") return true;
    if (ka === "circle" && kb === "circle") {
      const dx = a.x + a.w / 2 - (b.x + b.w / 2), dy = a.y + a.d / 2 - (b.y + b.d / 2), R = (a.w + b.w) / 2;
      return dx * dx + dy * dy < R * R - EPS;
    }
    return convexOverlap(a, b);
  }
  function blockerFor(r, ex) {
    if (r.x < 0 || r.y < 0 || r.x + r.w > state.room.w || r.y + r.d > state.room.h) return { wall: true };
    // A rug (u) can lie under ordinary furniture: only pieces of the same kind (both rugs / both not) block each other.
    const o = state.items.find(o => !ex.has(o.id) && !!r.u === !!o.u && overlap(r, o));
    return o ? { item: o } : null;
  }
  const hit = (item, x, y, w = item.w, d = item.d) => blockerFor({ x, y, w, d, s: item.s, r: item.r, u: item.u }, new Set([item.id]));
  const bounds = items => ({
    minX: Math.min(...items.map(m => m.x)), maxX: Math.max(...items.map(m => m.x + m.w)),
    minY: Math.min(...items.map(m => m.y)), maxY: Math.max(...items.map(m => m.y + m.d))
  });
  // Move a group by (rx, ry) in small steps so no piece can pass through a non-member.
  // Members are applied together, so the group keeps its shape.
  function moveGroup(members, rx, ry) {
    const ex = new Set(members.map(m => m.id));
    const { minX, maxX, minY, maxY } = bounds(members);
    rx = Math.max(-minX, Math.min(state.room.w - maxX, rx));
    ry = Math.max(-minY, Math.min(state.room.h - maxY, ry));
    const free = (dx, dy) => {
      for (const m of members) { const h = blockerFor({ x: m.x + dx, y: m.y + dy, w: m.w, d: m.d, s: m.s, r: m.r, u: m.u }, ex); if (h) return h; }
      return null;
    };
    let ax = 0, ay = 0, blocker = null;
    const steps = Math.ceil(Math.max(Math.abs(rx), Math.abs(ry)) / SNAP);
    for (let k = 1; k <= steps; k++) {
      const sx = snap(rx * k / steps), sy = snap(ry * k / steps);
      let h = free(sx, ay); if (!h) ax = sx; else if (h.item) blocker = h.item;
      h = free(ax, sy); if (!h) ay = sy; else if (h.item) blocker = h.item;
    }
    members.forEach(m => { m.x += ax; m.y += ay; });
    return { ax, ay, blocker };
  }
  function findSpot(w, d, s, r, u) {
    for (let y = 0; y + d <= state.room.h; y += 10)
      for (let x = 0; x + w <= state.room.w; x += 10)
        if (!hit({ id: null, s, r, u }, x, y, w, d)) return { x, y };
    return null;
  }
  function flashBlocker(b) {
    if (!b) return;
    blockerId = b.id; clearTimeout(blockerTimer);
    blockerTimer = setTimeout(() => { blockerId = null; render(); }, 600);
  }

  // ---------- rendering ----------
  const el = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };
  const fillOf = c => `var(--f${c})`, strokeOf = c => `var(--f${c}s)`;

  function gridDefs(root, id) {
    const defs = el("defs", {}, root);
    const pm = el("pattern", { id: id + "m", width: 10, height: 10, patternUnits: "userSpaceOnUse" }, defs);
    el("path", { d: "M10 0H0V10", fill: "none", stroke: "var(--grid-minor)", "stroke-width": 0.6 }, pm);
    const pM = el("pattern", { id: id + "M", width: 100, height: 100, patternUnits: "userSpaceOnUse" }, defs);
    el("rect", { width: 100, height: 100, fill: `url(#${id}m)` }, pM);
    el("path", { d: "M100 0H0V100", fill: "none", stroke: "var(--grid-major)", "stroke-width": 1.2 }, pM);
  }

  function render() {
    const { w: W, h: H } = state.room;
    const pad = Math.max(50, Math.max(W, H) * 0.07);
    const fs = Math.max(11, Math.max(W, H) / 60);
    svg.setAttribute("viewBox", `${-pad} ${-pad} ${W + pad * 2} ${H + pad * 2}`);
    svg.textContent = "";
    gridDefs(svg, "g");
    el("rect", { x: 0, y: 0, width: W, height: H, fill: "url(#gM)" }, svg);

    // meter ticks along top and left
    for (let m = 0; m <= W; m += 100) {
      el("line", { x1: m, y1: -pad * .45, x2: m, y2: -pad * .25, class: "dimline" }, svg);
      const t = el("text", { x: m, y: -pad * .55, "font-size": fs * .85, "text-anchor": "middle", class: "dim" }, svg);
      t.textContent = m / 100 + "m";
    }
    for (let m = 100; m <= H; m += 100) {
      el("line", { x1: -pad * .45, y1: m, x2: -pad * .25, y2: m, class: "dimline" }, svg);
      const t = el("text", { x: -pad * .5, y: m + fs * .3, "font-size": fs * .85, "text-anchor": "end", class: "dim" }, svg);
      t.textContent = m / 100 + "m";
    }
    const cap = el("text", { x: W, y: H + pad * .6, "font-size": fs * .9, "text-anchor": "end", class: "dim" }, svg);
    cap.textContent = `${W} × ${H} cm  (${(W * H / 10000).toFixed(1)} m²)`;

    // furniture: selected / dragged one drawn last so it sits on top
    const order = [...state.items].sort((a, b) => (!!b.u - !!a.u) || (sel.has(a.id) - sel.has(b.id)));
    for (const it of order)
      drawItem(svg, it, (it.fixed ? " fixed" : "") + (sel.has(it.id) ? " sel" : "") + (it.id === blockerId ? " blocker" : "") + (drag && sel.has(it.id) ? " dragging" : ""));
    el("rect", { x: 0, y: 0, width: W, height: H, class: "wall" }, svg);
    if (marquee && marquee.moved) el("rect", { class: "marquee", x: Math.min(marquee.x0, marquee.x1), y: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }, svg);
    renderSel(); renderList(); renderCurrent(); positionMenu();
  }

  // The visible body of a piece: rect, circle or right triangle.
  function bodyEl(parent, it, attrs) {
    const k = shapeOf(it);
    if (k === "circle") return el("circle", { cx: it.x + it.w / 2, cy: it.y + it.d / 2, r: it.w / 2, ...attrs }, parent);
    if (k === "tri") return el("polygon", { points: polyOf(it).map(p => p.join(",")).join(" "), "stroke-linejoin": "round", ...attrs }, parent);
    return el("rect", { x: it.x, y: it.y, width: it.w, height: it.d, rx: 2, ...attrs }, parent);
  }

  function drawItem(root, it, cls = "") {
    const g = el("g", { class: "item" + cls, "data-id": it.id }, root);
    bodyEl(g, it, { class: "body", fill: fillOf(it.c), stroke: strokeOf(it.c) });
    const kind = shapeOf(it);
    if (kind === "rect") {   // small tick on the "front" edge
      const fl = Math.min(it.w, it.d) * .5, r = it.r || 0, m = 4;
      const fm = [
        [it.x + it.w / 2 - fl / 2, it.y + it.d - m, it.x + it.w / 2 + fl / 2, it.y + it.d - m],
        [it.x + m, it.y + it.d / 2 - fl / 2, it.x + m, it.y + it.d / 2 + fl / 2],
        [it.x + it.w / 2 - fl / 2, it.y + m, it.x + it.w / 2 + fl / 2, it.y + m],
        [it.x + it.w - m, it.y + it.d / 2 - fl / 2, it.x + it.w - m, it.y + it.d / 2 + fl / 2]
      ][r % 4];
      el("line", { class: "front", x1: fm[0], y1: fm[1], x2: fm[2], y2: fm[3], stroke: strokeOf(it.c) }, g);
    }
    // label area: the middle of the shape, shrunk to what fits inside a circle / triangle
    let cx = it.x + it.w / 2, cy = it.y + it.d / 2, aw = it.w, ah = it.d;
    if (kind === "circle") { aw = it.w * .72; ah = it.d * .6; }
    if (kind === "tri") {
      const p = polyOf(it); cx = (p[0][0] + p[1][0] + p[2][0]) / 3; cy = (p[0][1] + p[1][1] + p[2][1]) / 3;
      aw = Math.min(it.w, it.d) * .55; ah = Math.min(it.w, it.d) * .5;
    }
    const s = Math.min(16, Math.max(7, Math.min(aw / (it.name.length * 1.1 + .5), ah / 2.6)));
    const vertical = kind === "rect" && it.d > it.w * 1.6 && it.w < 60;
    const t = el("text", { x: cx, y: cy - (ah > s * 2.6 ? s * .25 : -s * .35), "font-size": s, "text-anchor": "middle", "font-weight": 500 }, g);
    t.textContent = it.name;
    if (vertical) { t.setAttribute("transform", `rotate(90 ${cx} ${cy})`); t.setAttribute("y", cy + s * .35); t.setAttribute("font-size", Math.min(16, Math.max(7, Math.min(it.d / (it.name.length * 1.1 + .5), it.w / 2.2)))); }
    if (ah > s * 2.6 && !vertical) {
      const z = el("text", { x: cx, y: cy + s * 1.05, "font-size": s * .75, "text-anchor": "middle", class: "sz" }, g);
      z.textContent = kind === "circle" ? `R${it.w / 2}` : `${it.w}×${it.d}`;
    }
  }

  // Read-only drawing of a saved layout: a small thumbnail (no labels) or a full preview (grid + labels).
  function drawStatic(root, items, full, gridId = "v") {
    const pad = full ? 12 : 6;
    root.setAttribute("viewBox", `${-pad} ${-pad} ${ROOM.w + pad * 2} ${ROOM.h + pad * 2}`);
    root.textContent = "";
    root.classList.add("mini");
    if (full) { gridDefs(root, gridId); el("rect", { x: 0, y: 0, width: ROOM.w, height: ROOM.h, fill: `url(#${gridId}M)` }, root); }
    for (const it of items) {
      if (full) drawItem(root, it);
      else bodyEl(root, it, { class: "it", fill: fillOf(it.c), stroke: strokeOf(it.c) });
    }
    el("rect", { x: 0, y: 0, width: ROOM.w, height: ROOM.h, class: "wall" }, root);
  }

  function renderCurrent() {
    const box = $("current"); box.textContent = "";
    const span = (cls, text) => { const s = document.createElement("span"); s.className = cls; s.textContent = text; box.appendChild(s); };
    if (state.cloud) {
      span("nm", state.cloud.name);
      if (state.cloud.author) span("by", "・ " + state.cloud.author);
    } else span("new", state.pendingName ? `「${state.pendingName}」のコピー（未保存）` : "未保存のレイアウト");
    if (state.cloud && state.dirty) span("dirty", "未保存の変更あり");
    $("updateBtn").disabled = !state.cloud;
  }

  // ---------- floating menu ----------
  const fmenu = $("fmenu"), fcolors = $("fmenuColors"), fsize = $("fmenuSize"), fname = $("fmenuName");
  for (let c = 0; c < 6; c++) {
    const b = document.createElement("button"); b.type = "button"; b.dataset.color = c; b.setAttribute("aria-label", "色 " + (c + 1));
    b.innerHTML = '<span class="cdot"></span>';
    const d = b.firstChild; d.style.background = fillOf(c); d.style.borderColor = strokeOf(c);
    fcolors.insertBefore(b, $("fmRugWrap"));
  }
  function positionMenu() {
    const items = selItems();
    if (!items.length || drag || marquee) { fmenu.hidden = true; return; }
    const one = items.length === 1, movable = movableSel().length > 0;
    if ((!one || !movable) && (panel === "size" || panel === "name")) panel = null;
    fmenu.hidden = false;
    fmenu.querySelectorAll(".fmenu-row [data-act]").forEach(b => {   // toolbar only; buttons inside the panels manage themselves
      b.hidden = (b.hasAttribute("data-single") && !one) || (b.hasAttribute("data-movable") && !movable) ||
        (/^rot/.test(b.dataset.act) && items.every(i => i.s === "circle"));
    });
    const dot = $("fmenuDot"); dot.style.background = fillOf(items[0].c); dot.style.borderColor = strokeOf(items[0].c);
    fcolors.querySelectorAll("[data-color]").forEach(b => (b.firstChild.dataset.on = items.every(i => i.c === +b.dataset.color)));
    $("fmRugWrap").hidden = !movable; $("fmRug").checked = movable && items.every(i => i.u);
    fcolors.hidden = panel !== "color"; fsize.hidden = panel !== "size"; fname.hidden = panel !== "name";
    fmenu.querySelector('[data-act="color"]').setAttribute("aria-expanded", panel === "color");
    fmenu.querySelector('[data-act="size"]').setAttribute("aria-expanded", panel === "size");
    fmenu.querySelector('[data-act="rename"]').setAttribute("aria-expanded", panel === "name");
    const { minX: x0, maxX: x1, minY: y0, maxY: y1 } = bounds(items);
    const ctm = svg.getScreenCTM(), box = $("sheet").getBoundingClientRect();
    const pt = svg.createSVGPoint();
    pt.x = (x0 + x1) / 2; pt.y = y0; const top = pt.matrixTransform(ctm);
    pt.y = y1; const bot = pt.matrixTransform(ctm);
    const mw = fmenu.offsetWidth, mh = fmenu.offsetHeight, gap = 8;
    let x = top.x - box.left, y = top.y - box.top - mh - gap;
    if (y < 4) y = bot.y - box.top + gap;
    if (y + mh > box.height - 4) y = Math.max(4, top.y - box.top + 8);
    x = Math.max(mw / 2 + 4, Math.min(box.width - mw / 2 - 4, x));
    fmenu.style.left = x + "px"; fmenu.style.top = y + "px";
  }
  new ResizeObserver(positionMenu).observe($("sheet"));
  fmenu.addEventListener("pointerdown", e => e.stopPropagation());
  // Fills the size panel for one piece: width x depth, radius for a circle, or the two legs of a triangle.
  function openSizePanel(it) {
    const k = shapeOf(it);
    $("sWLabel").textContent = k === "circle" ? "半径 (cm)" : k === "tri" ? "辺A・横 (cm)" : "幅 (cm)";
    $("sDLabel").textContent = k === "tri" ? "辺B・縦 (cm)" : "奥行 (cm)";
    $("sX").hidden = $("sDWrap").hidden = $("sDMax").hidden = k === "circle";
    $("sWMax").title = k === "circle" ? "他の家具や壁に当たるまで、中心を保って半径を広げます" : "他の家具や壁に当たるまで両側に広げます";
    $("sW").value = k === "circle" ? it.w / 2 : it.w; $("sD").value = it.d; $("sErr").textContent = "";
  }
  // MAX: grow the piece along one axis as far as it goes. Each side is pushed out separately (so the position may shift
  // along that axis) until it would hit a wall or another piece. A circle grows evenly around its center.
  function maxSize(it, axis) {
    if (it.fixed) return;
    const free = (x, y, w, d) => w <= 1000 && d <= 1000 && !hit(it, x, y, w, d);
    const old = { x: it.x, y: it.y, w: it.w, d: it.d };
    let { x, y, w, d } = old;
    if (it.s === "circle") {
      while (free(x - SNAP, y - SNAP, w + SNAP * 2, d + SNAP * 2)) { x -= SNAP; y -= SNAP; w += SNAP * 2; d += SNAP * 2; }
    } else if (axis === "w") {
      while (free(x - SNAP, y, w + SNAP, d)) { x -= SNAP; w += SNAP; }
      while (free(x, y, w + SNAP, d)) w += SNAP;
    } else {
      while (free(x, y - SNAP, w, d + SNAP)) { y -= SNAP; d += SNAP; }
      while (free(x, y, w, d + SNAP)) d += SNAP;
    }
    if (w === old.w && d === old.d) { $("sErr").textContent = "これ以上広げられません。"; return; }
    Object.assign(it, { x, y, w, d });
    openSizePanel(it); save(); render();
    toast(it.s === "circle" ? `半径を ${w / 2}cm に広げました。` : `${axis === "w" ? "幅" : "奥行"}を ${axis === "w" ? w : d}cm に広げました。`);
  }
  function resize(it) {
    if (it.fixed) return;
    const circle = it.s === "circle", err = $("sErr");
    const w = snap(circle ? 2 * +$("sW").value : +$("sW").value), d = circle ? w : snap(+$("sD").value);
    if (!(w >= 10 && d >= 10 && w <= 1000 && d <= 1000)) { err.textContent = circle ? "半径は 5〜500cm で入力してください。" : "寸法は 10〜1000cm で入力してください。"; return; }
    if (w > state.room.w || d > state.room.h) { err.textContent = "部屋より大きいため変更できません。"; return; }
    const x = Math.min(it.x, state.room.w - w), y = Math.min(it.y, state.room.h - d);
    const h = hit(it, x, y, w, d);
    if (h && h.item) { flashBlocker(h.item); render(); err.textContent = `「${h.item.name}」と重なるため変更できません。`; return; }
    Object.assign(it, { x, y, w, d }); err.textContent = "";
    openSizePanel(it); save(); render();
  }
  fmenu.addEventListener("click", e => {
    const items = selItems(); if (!items.length) return;
    const movable = movableSel();
    const one = movable.length === 1 ? movable[0] : null;
    const cb = e.target.closest("[data-color]");
    if (cb) { items.forEach(i => (i.c = +cb.dataset.color)); save(); render(); return; }
    const b = e.target.closest("[data-act]"); if (!b) return;
    switch (b.dataset.act) {
      case "color": panel = panel === "color" ? null : "color"; positionMenu(); break;
      case "size":
        if (!one) break;
        if (panel === "size") panel = null;
        else { panel = "size"; openSizePanel(one); }
        positionMenu(); if (panel === "size") { $("sW").focus(); $("sW").select(); }
        break;
      case "rename":
        if (!one) break;
        if (panel === "name") panel = null;
        else { panel = "name"; $("nName").value = one.name; $("nErr").textContent = ""; }
        positionMenu(); if (panel === "name") { $("nName").focus(); $("nName").select(); }
        break;
      case "applyName": if (one) rename(one); break;
      case "applySize": if (one) resize(one); break;
      case "maxW": if (one) maxSize(one, "w"); break;
      case "maxD": if (one) maxSize(one, "d"); break;
      case "rotL": if (movable.length) rotate(movable, -1); break;
      case "rotR": if (movable.length) rotate(movable, 1); break;
      case "dup": if (movable.length) duplicate(movable); break;
    }
  });
  function rename(it) {
    const name = $("nName").value.trim();
    if (!name) { $("nErr").textContent = "名称を入力してください。"; return; }
    it.name = name.slice(0, 24); panel = null; save(); render();
    toast(`名称を「${it.name}」に変更しました。`);
  }
  fname.addEventListener("input", () => ($("nErr").textContent = ""));
  fname.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); const it = movableSel()[0]; if (it) rename(it); }
    else if (e.key === "Escape") { panel = null; positionMenu(); }
  });

  // Rug toggle for the selection. Switching must not leave a piece overlapping another of its (new) kind.
  $("fmRug").addEventListener("change", e => {
    const items = movableSel(), on = e.target.checked; if (!items.length) return;
    const kind = o => (items.includes(o) ? on : !!o.u);
    for (const m of items) {
      const clash = state.items.find(o => o !== m && kind(o) === on && overlap(m, o));
      if (clash) {
        flashBlocker(clash); e.target.checked = !on; render();
        toast(`「${clash.name}」と重なるため、敷物を${on ? "オン" : "オフ"}にできません。`); return;
      }
    }
    items.forEach(i => { if (on) i.u = true; else delete i.u; }); save(); render();
  });

  fsize.addEventListener("input", () => ($("sErr").textContent = ""));
  fsize.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); const it = movableSel()[0]; if (it) resize(it); }
    else if (e.key === "Escape") { panel = null; positionMenu(); }
  });

  function renderSel() {
    const bar = $("selbar"); bar.textContent = "";
    const items = selItems();
    if (!items.length) { bar.innerHTML = '<span class="empty">家具をクリックすると、近くにメニューが表示されます。Shift+クリックや範囲ドラッグで複数選択できます。</span>'; return; }
    const n = document.createElement("span"); n.className = "name";
    const m = document.createElement("span"); m.className = "meta";
    if (items.length === 1) { const it = items[0]; n.textContent = it.name; m.textContent = `${it.w} × ${it.d} cm ・ 位置 (${it.x}, ${it.y})` + (it.fixed ? " ・ 固定（色のみ変更可）" : ""); }
    else { n.textContent = `${items.length}個を選択中`; m.textContent = items.slice(0, 4).map(i => i.name).join("、") + (items.length > 4 ? " ほか" : "") + (items.some(i => i.fixed) ? " ・ 固定の家具を含むため色のみ変更可" : ""); }
    bar.append(n, m);
    if (movableSel().length) {
      const a = document.createElement("div"); a.className = "actions";
      a.innerHTML = '<button class="btn small danger" type="button" data-act="del">削除</button>';
      bar.append(a);
    }
  }

  function renderList() {
    const ul = $("list"); ul.textContent = "";
    for (const it of state.items) {
      const li = document.createElement("li");
      const b = document.createElement("button"); b.type = "button"; b.dataset.id = it.id;
      if (sel.has(it.id)) b.setAttribute("aria-current", "true");
      b.innerHTML = `<span class="dot" style="background:${fillOf(it.c)};border:1px solid ${strokeOf(it.c)}"></span><span class="nm"></span>${it.fixed ? '<span class="tag">固定</span>' : ""}<span class="sz">${it.w}×${it.d}</span>`;
      b.querySelector(".nm").textContent = it.name;
      li.appendChild(b); ul.appendChild(li);
    }
  }

  // ---------- preview ----------
  function renderPreview() {
    const p = $("preview"); p.textContent = "";
    const circle = fShape === "circle";
    const w = circle ? 2 * +$("fW").value : +$("fW").value, d = circle ? w : +$("fD").value;
    const ok = circle ? (w >= 10 && w <= 1000) : (w >= 10 && d >= 10 && w <= 1000 && d <= 1000);
    const pw = ok ? w : 100, pd = ok ? d : 100;
    const person = 45, gap = 30, m = 34;
    const vw = Math.max(pw + gap + person, 120) + m * 2, vh = Math.max(pd, 60) + m * 2;
    const scale = Math.max(vw / 4, vh / 3);
    const VW = scale * 4, VH = scale * 3;
    p.setAttribute("viewBox", `0 0 ${VW} ${VH}`);
    gridDefs(p, "pg");
    el("rect", { width: VW, height: VH, fill: "url(#pgM)" }, p);
    const ox = Math.round((VW - (pw + gap + person)) / 2 / 10) * 10, oy = Math.round((VH - pd) / 2 / 10) * 10;
    const fs = Math.max(9, VW / 34);
    if (!ok) {
      const t = el("text", { x: VW / 2, y: VH / 2, "text-anchor": "middle", "font-size": fs, fill: "var(--danger)" }, p);
      t.textContent = circle ? "半径は 5〜500cm で入力してください" : "サイズは 10〜1000cm で入力してください"; return;
    }
    const shape = { x: ox, y: oy, w: pw, d: pd, s: fShape, r: 0 };
    bodyEl(p, shape, { fill: fillOf(fColor), stroke: strokeOf(fColor), "stroke-width": Math.max(1, VW / 300) });
    // name sits in the middle of the shape (inside the triangle's centroid for a triangle)
    let lx = ox + pw / 2, ly = oy + pd / 2, aw = pw, ah = pd;
    if (circle) { aw = pw * .72; ah = pd * .6; }
    if (fShape === "tri") { const q = polyOf(shape); lx = (q[0][0] + q[1][0] + q[2][0]) / 3; ly = (q[0][1] + q[1][1] + q[2][1]) / 3; aw = Math.min(pw, pd) * .55; ah = Math.min(pw, pd) * .5; }
    const nm = el("text", { x: lx, y: ly + fs * .35, "text-anchor": "middle", "font-size": Math.min(fs * 1.1, aw / (($("fName").value.length || 1) * 1.1 + .5), ah / 1.8), fill: "var(--ink)", "font-weight": 500, "font-family": "var(--font-body)" }, p);
    nm.textContent = $("fName").value || "(名称未入力)";
    // dimension lines (a circle only needs its radius)
    const sw = Math.max(.8, VW / 400);
    el("line", { x1: ox, y1: oy - fs * .9, x2: ox + pw, y2: oy - fs * .9, stroke: "var(--muted)", "stroke-width": sw }, p);
    const tw = el("text", { x: ox + pw / 2, y: oy - fs * 1.3, "text-anchor": "middle", "font-size": fs * .9, class: "dim" }, p);
    tw.textContent = circle ? `直径 ${w}cm（半径 ${w / 2}cm）` : w + "cm";
    if (!circle) {
      el("line", { x1: ox - fs * .9, y1: oy, x2: ox - fs * .9, y2: oy + pd, stroke: "var(--muted)", "stroke-width": sw }, p);
      const td = el("text", { x: ox - fs * 1.3, y: oy + pd / 2, "text-anchor": "middle", "font-size": fs * .9, class: "dim", transform: `rotate(-90 ${ox - fs * 1.3} ${oy + pd / 2})` }, p); td.textContent = d + "cm";
    }
    // person for scale (top view: shoulders + head)
    const px = ox + pw + gap + person / 2, py = oy + pd / 2;
    el("ellipse", { cx: px, cy: py, rx: person / 2, ry: 12, fill: "none", stroke: "var(--muted)", "stroke-width": sw, "stroke-dasharray": "3 2" }, p);
    el("circle", { cx: px, cy: py, r: 9, fill: "none", stroke: "var(--muted)", "stroke-width": sw }, p);
  }

  // ---------- interaction ----------
  function toPlan(e) {
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }
  svg.addEventListener("pointerdown", e => {
    const p = toPlan(e);
    const g = e.target.closest(".item");
    if (!g) {
      marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, base: e.shiftKey ? new Set(sel) : new Set(), pid: e.pointerId, moved: false };
      if (!e.shiftKey) setSel([]);
      svg.setPointerCapture(e.pointerId); render(); return;
    }
    const it = byId(g.dataset.id);
    if (e.shiftKey) {
      const n = new Set(sel); if (n.has(it.id)) n.delete(it.id); else n.add(it.id);
      setSel(n); render(); return;
    }
    if (!sel.has(it.id)) setSel([it.id]);
    if (it.fixed) { setSel([it.id]); render(); return; }   // fixed furniture: select only, never drag
    drag = { px: p.x, py: p.y, ax: 0, ay: 0, moved: false, clicked: it.id, pid: e.pointerId };
    svg.setPointerCapture(e.pointerId); render();
  });
  svg.addEventListener("pointermove", e => {
    const p = toPlan(e);
    if (marquee && e.pointerId === marquee.pid) {
      marquee.x1 = p.x; marquee.y1 = p.y;
      if (!marquee.moved && Math.hypot(p.x - marquee.x0, p.y - marquee.y0) < 4) return;
      marquee.moved = true;
      const r = { x: Math.min(marquee.x0, p.x), y: Math.min(marquee.y0, p.y), w: Math.abs(p.x - marquee.x0), d: Math.abs(p.y - marquee.y0) };
      const ids = new Set(marquee.base);
      // Range selection picks up only movable furniture, so the group can be moved right away
      state.items.forEach(i => { if (!i.fixed && overlap(r, i)) ids.add(i.id); });
      setSel(ids); render(); return;
    }
    if (!drag || e.pointerId !== drag.pid) return;
    const members = movableSel(); if (!members.length) return;
    const res = moveGroup(members, p.x - drag.px - drag.ax, p.y - drag.py - drag.ay);
    drag.ax += res.ax; drag.ay += res.ay;
    if (res.ax || res.ay) drag.moved = true;
    if (res.blocker) flashBlocker(res.blocker);
    if (res.blocker || res.ax || res.ay) render();
  });
  const endPtr = e => {
    if (marquee && e.pointerId === marquee.pid) { marquee = null; render(); return; }
    if (drag && e.pointerId === drag.pid) {
      const d = drag; drag = null;
      if (!d.moved && sel.size > 1) setSel([d.clicked]);   // plain click inside a group narrows to that item
      save(); render();
    }
  };
  svg.addEventListener("pointerup", endPtr);
  svg.addEventListener("pointercancel", endPtr);

  // Rotate the selection 90° as one rigid group (dir: 1 = right/clockwise, -1 = left).
  // Keeps the group's center, falling back to its current top-left corner; fails if it would hit a wall or other furniture.
  function rotate(items, dir = 1) {
    if (items.every(i => i.s === "circle")) return;   // a circle looks the same turned either way
    const ex = new Set(items.map(i => i.id));
    const { minX, maxX, minY, maxY } = bounds(items);
    const W = maxX - minX, H = maxY - minY;   // after rotating, the group is H wide and W deep
    if (H > state.room.w || W > state.room.h) { toast("回転すると壁からはみ出すため、回転できません。"); return; }
    const cx = x => Math.max(0, Math.min(state.room.w - H, x)), cy = y => Math.max(0, Math.min(state.room.h - W, y));
    const place = (gx, gy) => items.map(it => ({
      it, w: it.d, d: it.w, s: it.s, u: it.u, r: ((it.r || 0) + dir + 4) % 4,
      x: dir > 0 ? gx + (maxY - it.y - it.d) : gx + (it.y - minY),
      y: dir > 0 ? gy + (it.x - minX) : gy + (maxX - it.x - it.w)
    }));
    const cand = [[cx(snap(minX + (W - H) / 2)), cy(snap(minY + (H - W) / 2))], [cx(minX), cy(minY)]];
    let blocker = null;
    for (const [gx, gy] of cand) {
      const np = place(gx, gy);
      const h = np.map(q => blockerFor(q, ex)).find(Boolean);
      if (!h) {
        np.forEach(q => Object.assign(q.it, { x: q.x, y: q.y, w: q.w, d: q.d, r: ((q.it.r || 0) + dir + 4) % 4 }));
        save(); render(); return;
      }
      if (!blocker && h.item) blocker = h.item;
    }
    if (blocker) { flashBlocker(blocker); toast(`回転すると「${blocker.name}」と重なるため、回転できません。`); }
    else toast("回転すると壁からはみ出すため、回転できません。");
    render();
  }
  // Duplicate the selection as one group, shifted by a single offset so the layout between the copies is preserved.
  // The offset is chosen to place as many copies as possible; among equals, the one closest to the original wins
  // (so a single item lands right beside its source). Copies that would collide with anything are skipped.
  function duplicate(items) {
    const { minX, maxX, minY, maxY } = bounds(items);
    let best = null;   // { dx, dy, fit: items that can be placed, dist, ang }
    // Among offsets at the same distance, prefer right, then down, then left, then up (clockwise from the right; y points down).
    const angleOf = (dx, dy) => (Math.atan2(dy, dx) + 2 * Math.PI) % (2 * Math.PI);
    for (let dy = -minY; dy <= state.room.h - maxY; dy += SNAP) {
      for (let dx = -minX; dx <= state.room.w - maxX; dx += SNAP) {
        if (!dx && !dy) continue;
        const dist = dx * dx + dy * dy;
        if (best && best.fit.length === items.length && dist > best.dist) continue;
        const fit = items.filter(it => !blockerFor({ x: it.x + dx, y: it.y + dy, w: it.w, d: it.d, s: it.s, r: it.r, u: it.u }, new Set()));
        if (!fit.length) continue;
        const ang = angleOf(dx, dy);
        if (!best || fit.length > best.fit.length || (fit.length === best.fit.length && (dist < best.dist || (dist === best.dist && ang < best.ang - EPS))))
          best = { dx, dy, fit, dist, ang };
      }
    }
    if (!best) { toast("空きスペースがないため、複製できません。"); return; }
    const copies = best.fit.map(it => ({ ...it, id: uid(), x: it.x + best.dx, y: it.y + best.dy }));
    state.items.push(...copies); state.added = true;
    setSel(copies.map(c => c.id));
    if (copies.length < items.length) toast(`干渉する家具は複製せず、${items.length}個中${copies.length}個を複製しました。`);
    save(); render();
  }
  function remove(items) {
    const ids = new Set(items.filter(i => !i.fixed).map(i => i.id));
    state.items = state.items.filter(i => !ids.has(i.id)); setSel([]); save(); render();
  }

  $("selbar").addEventListener("click", e => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    if (b.dataset.act === "del") remove(movableSel());
  });
  $("list").addEventListener("click", e => {
    const b = e.target.closest("button[data-id]"); if (!b) return; setSel([b.dataset.id]); render();
  });
  document.addEventListener("keydown", e => {
    if (e.target.closest("input") || document.querySelector("dialog[open]")) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") { e.preventDefault(); setSel(state.items.filter(i => !i.fixed).map(i => i.id)); render(); return; }
    if (e.key === "Escape") { setSel([]); render(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
      e.preventDefault();
      const items = movableSel();
      if (!items.length) { if (sel.size) toast("固定の家具はコピーできません。"); return; }
      clipboard = items.map(i => ({ ...i }));
      toast(`${items.length}個の家具をコピーしました。Ctrl+V で貼り付けできます。`);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
      e.preventDefault();
      if (clipboard.length) duplicate(clipboard);   // placed beside the copied pieces, same rules as the duplicate button
      return;
    }
    const items = movableSel(); if (!items.length) return;
    const step = e.shiftKey ? 50 : 10;
    const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (mv) { e.preventDefault(); const r = moveGroup(items, mv[0], mv[1]); if (r.blocker) flashBlocker(r.blocker); save(); render(); }
    else if (e.key === "r" || e.key === "R") rotate(items, e.shiftKey ? -1 : 1);
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(items); }
  });

  // ---------- add form ----------
  // Shape selector: the size inputs change with the shape (width x depth / radius / the two legs of a right triangle).
  function setShape(k) {
    const a = +$("fW").value, b = +$("fD").value;
    if (k === "circle" && fShape !== "circle") $("fW").value = Math.max(5, Math.round(Math.min(a, b) / 2));
    if (k !== "circle" && fShape === "circle") { $("fW").value = $("fD").value = a * 2; }
    fShape = k;
    $("shapeSeg").querySelectorAll("button").forEach(btn => btn.setAttribute("aria-pressed", btn.dataset.shape === k));
    $("fWLabel").textContent = k === "circle" ? "半径" : k === "tri" ? "辺A（横）" : "幅";
    $("fDLabel").textContent = k === "tri" ? "辺B（縦）" : "奥行";
    $("dims").classList.toggle("single", k === "circle");
    $("fX").hidden = $("fDWrap").hidden = k === "circle";
    $("shapeHint").hidden = k !== "tri";
    $("shapeHint").textContent = "直角をはさむ2辺の長さを入力します。向きは配置後の回転で変えられます。";
    renderPreview();
  }
  $("shapeSeg").addEventListener("click", e => { const b = e.target.closest("[data-shape]"); if (b) setShape(b.dataset.shape); });
  // Size entered in the form as { s, w, d } (bounding box); null + message when invalid.
  function formShape() {
    const a = +$("fW").value, b = +$("fD").value;
    if (fShape === "circle") {
      if (!(a >= 5 && a <= 500)) return { err: "半径は 5〜500cm で入力してください。" };
      const w = snap(2 * a); return { s: "circle", w, d: w };
    }
    const w = snap(a), d = snap(b);
    if (!(w >= 10 && d >= 10 && w <= 1000 && d <= 1000)) return { err: "幅と奥行は 10〜1000cm で入力してください。" };
    return { s: fShape, w, d };
  }

  const presets = $("presets");
  for (const [n, w, d, c, shape] of PRESETS) {
    const b = document.createElement("button"); b.type = "button"; b.className = "chip";
    b.textContent = n;
    b.title = shape === "circle" ? `半径 ${w / 2} cm` : `${w} × ${d} cm`;
    b.onclick = () => {
      setShape(shape || "rect");
      $("fName").value = n; $("fW").value = shape === "circle" ? w / 2 : w; $("fD").value = d; setColor(c);
      renderPreview();
    };
    presets.appendChild(b);
  }
  const sw = $("swatches");
  for (let c = 0; c < 6; c++) {
    const b = document.createElement("button"); b.type = "button"; b.className = "swatch";
    b.style.background = fillOf(c); b.style.boxShadow = `inset 0 0 0 1.5px ${strokeOf(c)}`;
    b.setAttribute("aria-label", "色 " + (c + 1)); b.onclick = () => { setColor(c); renderPreview(); };
    sw.appendChild(b);
  }
  function setColor(c) { fColor = c;[...sw.children].forEach((b, i) => b.setAttribute("aria-pressed", i === c)); }
  setColor(0);
  ["fName", "fW", "fD"].forEach(id => $(id).addEventListener("input", renderPreview));

  $("addForm").addEventListener("submit", e => {
    e.preventDefault();
    const name = $("fName").value.trim(), f = formShape();
    if (!name) return toast("名称を入力してください。");
    if (f.err) return toast(f.err);
    const { w, d } = f, k = f.s === "rect" ? undefined : f.s;
    if ((w > state.room.w || d > state.room.h) && (d > state.room.w || w > state.room.h)) return toast("部屋より大きいため配置できません。");
    const rug = $("fRug").checked || undefined;
    let s = findSpot(w, d, k, 0, rug), W = w, D = d, r = 0;
    if (!s && f.s !== "circle") { s = findSpot(d, w, k, 1, rug); W = d; D = w; r = 1; }   // otherwise try it turned 90°
    if (!s) return toast("空いているスペースがありません。家具を動かしてから追加してください。");
    const it = { id: uid(), name, w: W, d: D, x: s.x, y: s.y, c: fColor, r, ...(k ? { s: k } : {}), ...(rug ? { u: true } : {}) };
    state.items.push(it); state.added = true; setSel([it.id]); save(); render();
    toast(`「${name}」を追加しました。` + (r ? "（空きの都合で90°回転して配置）" : ""));
  });

  // ---------- room (fixed size) ----------
  $("roomsize").innerHTML = `<span>部屋</span><span class="num">${ROOM.w} × ${ROOM.h}</span><span>cm</span>`;

  // Two-step confirm inside the page (no confirm() dialogs in the viewer)
  function confirmButton(btn, label, action) {
    let armed = 0; const orig = btn.textContent;
    btn.addEventListener("click", () => {
      if (armed) { clearTimeout(armed); armed = 0; btn.textContent = orig; action(); return; }
      btn.textContent = label; armed = setTimeout(() => { armed = 0; btn.textContent = orig; }, 3000);
    });
  }
  // Keeps the link to the saved layout, so the cleared result can still be saved with "更新".
  confirmButton($("clearBtn"), "もう一度押すとテンプレートに戻す", () => { state.items = templateItems(); setSel([]); save(); render(); });

  // ---------- saved layouts (Supabase) ----------
  const fmtDate = s => new Date(s).toLocaleString("ja-JP", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const layoutData = () => ({ room: { ...ROOM }, items: state.items.map(({ id, name, x, y, w, d, c, r, s, u, fixed }) => ({ id, name, x, y, w, d, c, r: r || 0, ...(s ? { s } : {}), ...(u ? { u } : {}), ...(fixed ? { fixed } : {}) })) });
  const ownCount = row => itemsFrom(row.data && row.data.items).filter(i => !i.fixed).length;
  function replaceLayout(items, cloud, pendingName, dirty) {
    Object.assign(state, { items, cloud, pendingName, dirty, added: false });
    setSel([]); persist(); render();
  }
  // Asks for a second press before an action that would discard unsaved changes.
  function guardDirty(btn, action) {
    if (!state.dirty || btn.dataset.armed) { delete btn.dataset.armed; action(); return; }
    const orig = btn.textContent;
    btn.dataset.armed = "1"; btn.textContent = "未保存の変更は失われます。もう一度押して続行";
    setTimeout(() => { if (btn.isConnected && btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = orig; } }, 3000);
  }
  document.querySelectorAll("dialog [data-close]").forEach(b => b.addEventListener("click", () => b.closest("dialog").close()));

  // New save: name defaults to "レイアウト<通し番号>" (the server assigns the number when the default is left as is).
  const saveDlg = $("saveDlg");
  let defaultName = "";
  $("saveNewBtn").addEventListener("click", async () => {
    $("saveErr").textContent = "";
    $("saveSubmit").disabled = false;
    try { $("saveAuthor").value = localStorage.getItem(STORE + "-author") || ""; } catch (e) { }
    defaultName = "";
    $("saveName").value = state.pendingName ? state.pendingName + "のコピー" : "";
    $("saveName").placeholder = "空欄なら「レイアウト＋通し番号」";
    saveDlg.showModal();
    $("saveName").select();
    if (!state.pendingName) {
      try {
        defaultName = "レイアウト" + (await LayoutDB.nextNo());
        if (!$("saveName").value) { $("saveName").value = defaultName; $("saveName").select(); }
      } catch (e) { /* keep the placeholder; the server still numbers it */ }
    }
  });
  $("saveForm").addEventListener("submit", async e => {
    e.preventDefault();
    const typed = $("saveName").value.trim(), author = $("saveAuthor").value.trim();
    const name = typed === defaultName ? "" : typed;   // untouched default → let the server number it
    $("saveSubmit").disabled = true; $("saveErr").textContent = "";
    try {
      const row = await LayoutDB.create(name, author, layoutData());
      try { localStorage.setItem(STORE + "-author", author); } catch (e2) { }
      replaceLayout(state.items, cloudOf(row), null, false);
      saveDlg.close();
      toast(`「${row.name}」として保存しました。`);
    } catch (err) {
      $("saveErr").textContent = "保存できませんでした: " + err.message;
    } finally { $("saveSubmit").disabled = false; }
  });

  // Update: overwrite the saved layout being edited. If someone else saved it in the meantime, a second press overwrites.
  let forceUpdate = 0;
  $("updateBtn").addEventListener("click", async () => {
    const btn = $("updateBtn"); if (!state.cloud) return;
    const force = !!forceUpdate; clearTimeout(forceUpdate); forceUpdate = 0; btn.textContent = "更新";
    btn.disabled = true;
    try {
      const row = await LayoutDB.update(state.cloud.id, { data: layoutData() }, force ? null : state.cloud.updated_at);
      if (!row) {
        btn.textContent = "もう一度押すと上書き";
        forceUpdate = setTimeout(() => { forceUpdate = 0; btn.textContent = "更新"; }, 5000);
        toast("他の人が先にこのレイアウトを更新しています。もう一度押すと上書きします。");
      } else {
        state.cloud = cloudOf(row); state.dirty = false; state.added = false; persist();
        toast(`「${row.name}」を更新しました。`);
      }
    } catch (err) {
      toast("更新できませんでした: " + err.message);
    } finally { btn.disabled = false; renderCurrent(); }
  });

  // Menu: browse everyone's saved layouts, continue editing one, or copy it as a new layout.
  const menuDlg = $("menuDlg");
  let rows = [], viewId = null;
  $("menuBtn").addEventListener("click", () => { menuDlg.showModal(); loadList(); });
  $("reloadBtn").addEventListener("click", loadList);
  // Back to the template as a new unsaved layout. Asks first only if furniture was added since the last save.
  const confirmDlg = $("confirmDlg");
  function newLayout() {
    const go = () => { replaceLayout(templateItems(), null, null, false); menuDlg.close(); toast("新しいレイアウトを作成しました。"); };
    if (!state.added) return go();
    confirmDlg.returnValue = "";
    confirmDlg.onclose = () => { if (confirmDlg.returnValue === "ok") go(); };
    confirmDlg.showModal();
    $("confirmOk").focus();
  }
  $("newBtn").addEventListener("click", newLayout);
  $("newLayoutBtn").addEventListener("click", newLayout);
  async function loadList() {
    const ul = $("savedList");
    ul.innerHTML = '<li class="msg">読み込み中…</li>';
    try { rows = await LayoutDB.list(); }
    catch (err) { rows = []; ul.innerHTML = '<li class="msg err"></li>'; ul.firstChild.textContent = "読み込めませんでした: " + err.message; renderView(); return; }
    if (!rows.some(r => r.id === viewId)) viewId = (state.cloud && rows.some(r => r.id === state.cloud.id)) ? state.cloud.id : rows[0] && rows[0].id;
    renderSaved(); renderView();
  }
  function renderSaved() {
    const ul = $("savedList"); ul.textContent = "";
    if (!rows.length) { ul.innerHTML = '<li class="msg">まだ保存されたレイアウトはありません。「新規保存」で保存できます。</li>'; return; }
    for (const row of rows) {
      const li = document.createElement("li");
      const b = document.createElement("button"); b.type = "button"; b.dataset.id = row.id;
      if (row.id === viewId) b.setAttribute("aria-current", "true");
      const thumb = el("svg", { class: "thumb", "aria-hidden": "true" }, b);
      drawStatic(thumb, itemsFrom(row.data && row.data.items), false);
      const txt = document.createElement("span");
      const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = row.name;
      if (state.cloud && row.id === state.cloud.id) { const t = document.createElement("span"); t.className = "mine"; t.textContent = "編集中"; nm.appendChild(t); }
      const meta = document.createElement("span"); meta.className = "meta";
      meta.textContent = `${row.author || "作成者なし"} ・ ${fmtDate(row.updated_at)}`;
      txt.append(nm, meta); b.appendChild(txt); li.appendChild(b); ul.appendChild(li);
    }
  }
  $("savedList").addEventListener("click", e => {
    const b = e.target.closest("button[data-id]"); if (!b) return;
    viewId = b.dataset.id; renderSaved(); renderView();
    if (e.target.closest(".thumb")) openZoom(rows.find(r => r.id === viewId));
  });
  // Enlarged image of a saved layout, with a close button below it.
  const zoomDlg = $("zoomDlg");
  function openZoom(row) {
    if (!row) return;
    $("zoomTitle").textContent = row.name;
    drawStatic($("zoomSvg"), itemsFrom(row.data && row.data.items), true, "z");
    $("zoomSvg").setAttribute("aria-label", row.name + " の拡大表示");
    zoomDlg.showModal();
  }
  function renderView() {
    const v = $("menuView"); v.textContent = "";
    const row = rows.find(r => r.id === viewId);
    if (!row) { v.innerHTML = '<p class="empty">左の一覧からレイアウトを選ぶと、ここに表示されます。</p>'; return; }
    const big = el("svg", { class: "big", role: "img", "aria-label": row.name + " のプレビュー" }, v);
    drawStatic(big, itemsFrom(row.data && row.data.items), true);
    big.addEventListener("click", () => openZoom(row));
    el("title", {}, big).textContent = "クリックで拡大";
    const h = document.createElement("h3"); h.textContent = row.name;
    const meta = document.createElement("p"); meta.className = "meta";
    meta.textContent = `作成者: ${row.author || "なし"} ・ 家具 ${ownCount(row)}個\n作成 ${fmtDate(row.created_at)} ・ 更新 ${fmtDate(row.updated_at)}`;
    meta.style.whiteSpace = "pre-line";
    const acts = document.createElement("div"); acts.className = "acts";
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "btn primary"; edit.textContent = "続きから編集";
    const copy = document.createElement("button"); copy.type = "button"; copy.className = "btn"; copy.textContent = "コピーして編集";
    edit.onclick = () => guardDirty(edit, () => {
      replaceLayout(itemsFrom(row.data && row.data.items), cloudOf(row), null, false);
      menuDlg.close(); toast(`「${row.name}」を開きました。変更は「更新」で保存できます。`);
    });
    copy.onclick = () => guardDirty(copy, () => {
      replaceLayout(itemsFrom(row.data && row.data.items), null, row.name, true);
      menuDlg.close(); toast(`「${row.name}」をコピーしました。「新規保存」で別のレイアウトとして保存できます。`);
    });
    acts.append(edit, copy);
    v.append(h, meta, acts);
  }

  let toastT = 0;
  // A modal dialog sits in the top layer, so the toast is moved into it while one is open.
  function toast(msg) {
    const t = $("toast"); (document.querySelector("dialog[open]") || document.body).appendChild(t);
    t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2600);
  }

  render(); renderPreview();
})();
