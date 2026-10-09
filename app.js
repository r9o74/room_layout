(() => {
  const SNAP = 5;          // cm
  const STORE = "lab-layout-tpl-v1";
  const NS = "http://www.w3.org/2000/svg";
  const ROOM = { w: 660, h: 480 };   // 部屋のサイズ (固定)
  const PRESETS = [
    ["机", 120, 60, 0], ["椅子", 50, 50, 4], ["本棚", 90, 30, 2], ["ロッカー", 90, 50, 4],
    ["実験台", 180, 75, 1], ["ミーティングテーブル", 180, 90, 2], ["ホワイトボード", 180, 20, 3],
    ["プリンタ", 60, 50, 4], ["冷蔵庫", 60, 65, 5], ["ソファ", 160, 80, 3]
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
  const initial = () => ({ room: { ...ROOM }, items: templateItems() });

  let state = load() || initial();
  let sel = new Set();
  let panel = null;        // "color" | "size" | null: which panel of the floating menu is open
  let marquee = null;
  let blockerId = null, blockerTimer = 0;
  let drag = null;
  let fColor = 0;

  const $ = id => document.getElementById(id);
  const svg = $("plan");

  // The template always comes from the code; only its colors are restored from storage.
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE));
      if (!s || !Array.isArray(s.items)) return null;
      const fixed = templateItems();
      for (const f of fixed) {
        const o = s.items.find(i => i.id === f.id);
        if (o && Number.isInteger(o.c) && o.c >= 0 && o.c < 6) f.c = o.c;
      }
      return { room: { ...ROOM }, items: [...fixed, ...s.items.filter(i => !i.fixed)] };
    } catch (e) {}
    return null;
  }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) {} }
  const uid = () => Math.random().toString(36).slice(2, 9);
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
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.d && b.y < a.y + a.d;
  function blockerFor(r, ex) {
    if (r.x < 0 || r.y < 0 || r.x + r.w > state.room.w || r.y + r.d > state.room.h) return { wall: true };
    const o = state.items.find(o => !ex.has(o.id) && overlap(r, o));
    return o ? { item: o } : null;
  }
  const hit = (item, x, y, w = item.w, d = item.d) => blockerFor({ x, y, w, d }, new Set([item.id]));
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
      for (const m of members) { const h = blockerFor({ x: m.x + dx, y: m.y + dy, w: m.w, d: m.d }, ex); if (h) return h; }
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
  function findSpot(w, d) {
    for (let y = 0; y + d <= state.room.h; y += 10)
      for (let x = 0; x + w <= state.room.w; x += 10)
        if (!hit({ id: null }, x, y, w, d)) return { x, y };
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
    const order = [...state.items].sort((a, b) => sel.has(a.id) - sel.has(b.id));
    for (const it of order) {
      const g = el("g", { class: "item" + (it.fixed ? " fixed" : "") + (sel.has(it.id) ? " sel" : "") + (it.id === blockerId ? " blocker" : "") + (drag && sel.has(it.id) ? " dragging" : ""), "data-id": it.id }, svg);
      el("rect", { class: "body", x: it.x, y: it.y, width: it.w, height: it.d, rx: 2, fill: fillOf(it.c), stroke: strokeOf(it.c) }, g);
      const fl = Math.min(it.w, it.d) * .5, r = it.r || 0, m = 4;
      const fm = [
        [it.x + it.w / 2 - fl / 2, it.y + it.d - m, it.x + it.w / 2 + fl / 2, it.y + it.d - m],
        [it.x + m, it.y + it.d / 2 - fl / 2, it.x + m, it.y + it.d / 2 + fl / 2],
        [it.x + it.w / 2 - fl / 2, it.y + m, it.x + it.w / 2 + fl / 2, it.y + m],
        [it.x + it.w - m, it.y + it.d / 2 - fl / 2, it.x + it.w - m, it.y + it.d / 2 + fl / 2]
      ][r % 4];
      el("line", { class: "front", x1: fm[0], y1: fm[1], x2: fm[2], y2: fm[3], stroke: strokeOf(it.c) }, g);
      const s = Math.min(16, Math.max(7, Math.min(it.w / (it.name.length * 1.1 + .5), it.d / 2.6)));
      const vertical = it.d > it.w * 1.6 && it.w < 60;
      const cx = it.x + it.w / 2, cy = it.y + it.d / 2;
      const t = el("text", { x: cx, y: cy - (it.d > s * 2.6 ? s * .25 : -s * .35), "font-size": s, "text-anchor": "middle", "font-weight": 500 }, g);
      t.textContent = it.name;
      if (vertical) { t.setAttribute("transform", `rotate(90 ${cx} ${cy})`); t.setAttribute("y", cy + s * .35); t.setAttribute("font-size", Math.min(16, Math.max(7, Math.min(it.d / (it.name.length * 1.1 + .5), it.w / 2.2)))); }
      if (it.d > s * 2.6 && !vertical) {
        const z = el("text", { x: cx, y: cy + s * 1.05, "font-size": s * .75, "text-anchor": "middle", class: "sz" }, g);
        z.textContent = `${it.w}×${it.d}`;
      }
    }
    el("rect", { x: 0, y: 0, width: W, height: H, class: "wall" }, svg);
    if (marquee && marquee.moved) el("rect", { class: "marquee", x: Math.min(marquee.x0, marquee.x1), y: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }, svg);
    renderSel(); renderList(); positionMenu();
  }

  // ---------- floating menu ----------
  const fmenu = $("fmenu"), fcolors = $("fmenuColors"), fsize = $("fmenuSize");
  for (let c = 0; c < 6; c++) {
    const b = document.createElement("button"); b.type = "button"; b.dataset.color = c; b.setAttribute("aria-label", "色 " + (c + 1));
    b.innerHTML = '<span class="cdot"></span>';
    const d = b.firstChild; d.style.background = fillOf(c); d.style.borderColor = strokeOf(c);
    fcolors.appendChild(b);
  }
  function positionMenu() {
    const items = selItems();
    if (!items.length || drag || marquee) { fmenu.hidden = true; return; }
    const one = items.length === 1, movable = movableSel().length > 0;
    if ((!one || !movable) && panel === "size") panel = null;
    fmenu.hidden = false;
    fmenu.querySelectorAll("[data-act]").forEach(b => {
      b.hidden = (b.hasAttribute("data-single") && !one) || (b.hasAttribute("data-movable") && !movable);
    });
    const dot = $("fmenuDot"); dot.style.background = fillOf(items[0].c); dot.style.borderColor = strokeOf(items[0].c);
    [...fcolors.children].forEach(b => (b.firstChild.dataset.on = items.every(i => i.c === +b.dataset.color)));
    fcolors.hidden = panel !== "color"; fsize.hidden = panel !== "size";
    fmenu.querySelector('[data-act="color"]').setAttribute("aria-expanded", panel === "color");
    fmenu.querySelector('[data-act="size"]').setAttribute("aria-expanded", panel === "size");
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
  function resize(it) {
    if (it.fixed) return;
    const w = snap(+$("sW").value), d = snap(+$("sD").value), err = $("sErr");
    if (!(w >= 10 && d >= 10 && w <= 1000 && d <= 1000)) { err.textContent = "幅と奥行は 10〜1000cm で入力してください。"; return; }
    if (w > state.room.w || d > state.room.h) { err.textContent = "部屋より大きいため変更できません。"; return; }
    const x = Math.min(it.x, state.room.w - w), y = Math.min(it.y, state.room.h - d);
    const h = hit(it, x, y, w, d);
    if (h && h.item) { flashBlocker(h.item); render(); err.textContent = `「${h.item.name}」と重なるため変更できません。`; return; }
    Object.assign(it, { x, y, w, d }); err.textContent = "";
    $("sW").value = w; $("sD").value = d; save(); render();
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
        else { panel = "size"; $("sW").value = one.w; $("sD").value = one.d; $("sErr").textContent = ""; }
        positionMenu(); if (panel === "size") { $("sW").focus(); $("sW").select(); }
        break;
      case "applySize": if (one) resize(one); break;
      case "rotL": if (movable.length) rotate(movable, -1); break;
      case "rotR": if (movable.length) rotate(movable, 1); break;
      case "dup": if (movable.length) duplicate(movable); break;
    }
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
    const w = +$("fW").value, d = +$("fD").value;
    const ok = w >= 10 && d >= 10 && w <= 1000 && d <= 1000;
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
      t.textContent = "サイズは 10〜1000cm で入力してください"; return;
    }
    el("rect", { x: ox, y: oy, width: pw, height: pd, rx: 2, fill: fillOf(fColor), stroke: strokeOf(fColor), "stroke-width": Math.max(1, VW / 300) }, p);
    const nm = el("text", { x: ox + pw / 2, y: oy + pd / 2 + fs * .35, "text-anchor": "middle", "font-size": Math.min(fs * 1.1, pw / (($("fName").value.length || 1) * 1.1 + .5), pd / 1.8), fill: "var(--ink)", "font-weight": 500, "font-family": "var(--font-body)" }, p);
    nm.textContent = $("fName").value || "(名称未入力)";
    // dimension lines
    const sw = Math.max(.8, VW / 400);
    el("line", { x1: ox, y1: oy - fs * .9, x2: ox + pw, y2: oy - fs * .9, stroke: "var(--muted)", "stroke-width": sw }, p);
    el("line", { x1: ox - fs * .9, y1: oy, x2: ox - fs * .9, y2: oy + pd, stroke: "var(--muted)", "stroke-width": sw }, p);
    const tw = el("text", { x: ox + pw / 2, y: oy - fs * 1.3, "text-anchor": "middle", "font-size": fs * .9, class: "dim" }, p); tw.textContent = w + "cm";
    const td = el("text", { x: ox - fs * 1.3, y: oy + pd / 2, "text-anchor": "middle", "font-size": fs * .9, class: "dim", transform: `rotate(-90 ${ox - fs * 1.3} ${oy + pd / 2})` }, p); td.textContent = d + "cm";
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
    const ex = new Set(items.map(i => i.id));
    const { minX, maxX, minY, maxY } = bounds(items);
    const W = maxX - minX, H = maxY - minY;   // after rotating, the group is H wide and W deep
    if (H > state.room.w || W > state.room.h) { toast("回転すると壁からはみ出すため、回転できません。"); return; }
    const cx = x => Math.max(0, Math.min(state.room.w - H, x)), cy = y => Math.max(0, Math.min(state.room.h - W, y));
    const place = (gx, gy) => items.map(it => ({
      it, w: it.d, d: it.w,
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
  function duplicate(items) {
    const copies = [];
    for (const it of items) {
      const s = findSpot(it.w, it.d);
      if (!s) break;
      const n = { ...it, id: uid(), ...s }; state.items.push(n); copies.push(n.id);
    }
    if (copies.length < items.length) toast(copies.length ? "空きスペースが足りず、一部だけ複製しました。" : "空きスペースがないため、複製できません。");
    if (copies.length) setSel(copies);
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
    if (e.target.closest("input")) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") { e.preventDefault(); setSel(state.items.filter(i => !i.fixed).map(i => i.id)); render(); return; }
    if (e.key === "Escape") { setSel([]); render(); return; }
    const items = movableSel(); if (!items.length) return;
    const step = e.shiftKey ? 50 : 10;
    const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (mv) { e.preventDefault(); const r = moveGroup(items, mv[0], mv[1]); if (r.blocker) flashBlocker(r.blocker); save(); render(); }
    else if (e.key === "r" || e.key === "R") rotate(items, e.shiftKey ? -1 : 1);
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(items); }
  });

  // ---------- add form ----------
  const presets = $("presets");
  for (const [n, w, d, c] of PRESETS) {
    const b = document.createElement("button"); b.type = "button"; b.className = "chip";
    b.textContent = n;
    b.title = `${w} × ${d} cm`;
    b.onclick = () => { $("fName").value = n; $("fW").value = w; $("fD").value = d; setColor(c); $("formErr").textContent = ""; renderPreview(); };
    presets.appendChild(b);
  }
  const sw = $("swatches");
  for (let c = 0; c < 6; c++) {
    const b = document.createElement("button"); b.type = "button"; b.className = "swatch";
    b.style.background = fillOf(c); b.style.boxShadow = `inset 0 0 0 1.5px ${strokeOf(c)}`;
    b.setAttribute("aria-label", "色 " + (c + 1)); b.onclick = () => { setColor(c); renderPreview(); };
    sw.appendChild(b);
  }
  function setColor(c) { fColor = c; [...sw.children].forEach((b, i) => b.setAttribute("aria-pressed", i === c)); }
  setColor(0);
  ["fName", "fW", "fD"].forEach(id => $(id).addEventListener("input", () => { $("formErr").textContent = ""; renderPreview(); }));

  $("addForm").addEventListener("submit", e => {
    e.preventDefault();
    const name = $("fName").value.trim(), w = snap(+$("fW").value), d = snap(+$("fD").value);
    const err = $("formErr");
    if (!name) return (err.textContent = "名称を入力してください。");
    if (!(w >= 10 && d >= 10 && w <= 1000 && d <= 1000)) return (err.textContent = "幅と奥行は 10〜1000cm で入力してください。");
    if ((w > state.room.w || d > state.room.h) && (d > state.room.w || w > state.room.h)) return (err.textContent = "部屋より大きいため配置できません。");
    let s = findSpot(w, d), W = w, D = d;
    if (!s) { s = findSpot(d, w); W = d; D = w; }
    if (!s) return (err.textContent = "空いているスペースがありません。家具を動かしてから追加してください。");
    const it = { id: uid(), name, w: W, d: D, x: s.x, y: s.y, c: fColor };
    state.items.push(it); setSel([it.id]); save(); render();
    toast(`「${name}」を追加しました。` + (W !== w ? "（空きの都合で90°回転して配置）" : ""));
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
  confirmButton($("clearBtn"), "もう一度押すとテンプレートに戻す", () => { state = initial(); setSel([]); save(); render(); });

  let toastT = 0;
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2600); }

  render(); renderPreview();
})();
