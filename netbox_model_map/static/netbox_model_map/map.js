// Model map viewer: lays out each view with ELK (global ELK, from elk.bundled.js) and draws it as SVG.
// Data comes from the <script id="mm-data" type="application/json"> block the page renders.
(() => {
const D = JSON.parse(document.getElementById("mm-data").textContent), M = D.models;
const root = document.getElementById("mm");
const $ = id => document.getElementById("mm-" + id);
const NS = "http://www.w3.org/2000/svg";
const VIEWS = Object.fromEntries(D.views.map(v => [v.id, v]));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const domainOf = id => M[id].domain;
const colorOf = id => `var(--mm-d-${M[id].app})`;
const isSelf = (id, r) => r.targets.length === 1 && r.targets[0] === id;
const glyph = r => r.kind === "m2m" ? "∗" : r.kind === "gfk" ? "~" : r.req ? "●" : "○";
function targetText(id, r) {
  if (isSelf(id, r)) return M[id].label + " (self)";
  if (r.kind === "gfk") return !r.targets.length ? "any of several types"
    : r.targets.length > 3 ? `one of ${r.targets.length} types` : r.targets.map(t => M[t].label).join(" | ");
  return M[r.targets[0]].label + (r.kind === "m2m" ? " (many)" : r.kind === "o2o" ? " (1:1)" : "");
}
for (const m of Object.values(M)) m.inbound = [];
for (const [id, m] of Object.entries(M)) for (const r of m.rels) for (const t of r.targets) if (t !== id) M[t].inbound.push({ from: id, rel: r });
const membersOf = v => v === "overview" ? D.overview : Object.keys(M).filter(id => M[id].view === v);

/* ---------- controls ---------- */
$("badge").textContent = `NetBox ${D.netbox} · ` + Object.entries(D.plugins).map(([k, v]) => `${k} ${v}`).join(" · ") + ` · read ${D.generated}`;
const viewSelect = $("view");
const groups = [["", D.views.filter(v => v.id === "overview")], ["Custom objects", D.views.filter(v => v.custom)],
  ["Core NetBox", D.views.filter(v => v.id !== "overview" && !v.custom)]];
for (const [label, views] of groups) {
  if (!views.length) continue;
  const parent = label ? viewSelect.appendChild(Object.assign(document.createElement("optgroup"), { label })) : viewSelect;
  for (const v of views) parent.append(new Option(`${v.name} (${membersOf(v.id).length})`, v.id));
}
const byLabel = new Map();
for (const [id, m] of Object.entries(M)) {
  const key = `${m.label} · ${VIEWS[m.view].name}`;
  byLabel.set(key.toLowerCase(), id);
  $("models").append(new Option(key));
}

/* ---------- layout ---------- */
const css = getComputedStyle(root);
const SANS = css.getPropertyValue("--mm-sans").trim() || "system-ui, sans-serif";
const MONO = css.getPropertyValue("--mm-mono").trim() || "monospace";
const FONT = { title: `600 13px ${SANS}`, sub: `600 9.5px ${SANS}`, field: `400 11.5px ${MONO}`, target: `400 11px ${SANS}` };
const ctx = document.createElement("canvas").getContext("2d");
const tw = (s, f) => (ctx.font = FONT[f], ctx.measureText(s).width);
const subW = s => tw(s.toUpperCase(), "sub") + s.length * 0.6;
const ROW = 20, HEAD = 42;
const ELK_OPTS = { "elk.algorithm": "layered", "elk.direction": "RIGHT", "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF", "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.padding": "[top=28,left=28,bottom=28,right=28]" };
const elk = new ELK();
const cache = new Map();

function compactNode(id, nodeId, meta, ghost) {
  const w = Math.ceil(Math.max(tw(M[id].label, "title"), subW(domainOf(id))) + 28);
  meta.set(nodeId, { id, ghost, compact: true, w, h: 44 });
  return { id: nodeId, width: w, height: 44 };
}

function detailNode(id, meta) {
  const m = M[id], rows = [];
  let y = HEAD + 6;
  for (const k of m.keys) { rows.push({ key: k, y }); y += ROW; }
  if (m.keys.length && m.rels.length) y += 7;
  for (const r of m.rels) { rows.push({ r, y }); y += ROW; }
  const nested = m.rels.some(r => isSelf(id, r));
  let w = Math.max(tw(m.label, "title") + (nested ? 22 : 0), subW(domainOf(id))) + 28;
  for (const row of rows) w = Math.max(w, row.key ? tw(row.key, "field") + 40
    : 26 + tw(row.r.field, "field") + 18 + tw(targetText(id, row.r), "target") + 14);
  w = Math.ceil(Math.max(w, 170));
  meta.set(id, { id, rows, nested, w, h: y + 8, divider: m.keys.length && m.rels.length ? HEAD + 6 + m.keys.length * ROW + 3 : 0 });
  return { id, width: w, height: y + 8, layoutOptions: { "elk.portConstraints": "FIXED_POS" },
    ports: rows.filter(row => row.r && !isSelf(id, row.r)).map(row => ({ id: `${id}:${row.r.field}`, width: 1, height: 1, x: -1, y: row.y + ROW / 2 })) };
}

function buildGraph(v, st) {
  const ids = membersOf(v), inView = new Set(ids), nodes = new Map(), edges = new Map();
  const children = [], elkEdges = [];
  const skip = (id, t, r) => t === id || (!st.optional && !r.req) || (t === "Tenant" && !st.tenant && v !== "tenancy");
  if (v === "overview") {
    for (const id of ids) children.push(compactNode(id, id, nodes, false));
    const rank = r => r.req ? 0 : r.kind === "fk" || r.kind === "o2o" ? 1 : r.kind === "gfk" ? 2 : 3;
    const pairs = new Map();
    for (const id of ids) for (const r of M[id].rels) for (const t of r.targets) {
      if (!inView.has(t) || skip(id, t, r)) continue;
      const k = `${t}>${id}`, cur = pairs.get(k);
      if (!cur || rank(r) < rank(cur)) pairs.set(k, r);
    }
    let n = 0;
    for (const [k, r] of pairs) {
      const [from, to] = k.split(">"), eid = "e" + n++;
      elkEdges.push({ id: eid, sources: [from], targets: [to] });
      edges.set(eid, { r, from, to });
    }
  } else {
    const ghosts = new Set();
    for (const id of ids) children.push(detailNode(id, nodes));
    let n = 0;
    for (const id of ids) for (const r of M[id].rels) {
      const many = r.kind === "gfk" && r.targets.length > 4;
      for (const t of r.targets) {
        if (skip(id, t, r)) continue;
        let from = t;
        if (!inView.has(t)) { if (many) continue; from = "g:" + t; ghosts.add(t); }
        const eid = "e" + n++;
        elkEdges.push({ id: eid, sources: [from], targets: [`${id}:${r.field}`] });
        edges.set(eid, { r, from, to: id });
      }
    }
    for (const t of ghosts) children.push(compactNode(t, "g:" + t, nodes, true));
  }
  return { root: { id: "root", layoutOptions: { ...ELK_OPTS,
      "elk.layered.spacing.nodeNodeBetweenLayers": v === "overview" ? "60" : "72",
      "elk.spacing.nodeNode": v === "overview" ? "16" : "22", "elk.spacing.edgeNode": "14", "elk.spacing.edgeEdge": "8" },
    children, edges: elkEdges }, nodes, edges };
}

function layout(v, st) {
  const key = `${v}|${st.optional}|${st.tenant}`;
  if (!cache.has(key)) {
    const g = buildGraph(v, st);
    const p = elk.layout(g.root).then(out => ({ out, ...g }));
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return cache.get(key);
}

/* ---------- drawing ---------- */
function el(tag, attrs, text) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}
const vp = $("viewport"), svg = $("svg"), panel = $("panel");
let current = null;

function draw(res) {
  current = res;
  const edgeLayer = el("g"), nodeLayer = el("g");
  for (const e of res.out.edges || []) {
    const s = e.sections && e.sections[0], meta = res.edges.get(e.id);
    if (!s) continue;
    const pts = [s.startPoint, ...(s.bendPoints || []), s.endPoint];
    edgeLayer.append(el("path", { d: "M" + pts.map(p => `${p.x},${p.y}`).join(" L"), "marker-end": "url(#mm-arr)",
      class: "e " + (meta.r.req ? "req" : meta.r.kind === "gfk" ? "gfk" : "opt"), "data-from": meta.from, "data-to": meta.to }));
  }
  for (const n of res.out.children) {
    const nm = res.nodes.get(n.id), m = M[nm.id];
    const g = el("g", { class: "n" + (nm.ghost ? " ghost" : "") + (m.app === "custom" ? " custom" : ""),
      transform: `translate(${n.x},${n.y})`, "data-node": n.id, "data-id": nm.id, tabindex: 0, role: "button",
      "aria-label": `${m.label}, ${domainOf(nm.id)}${nm.ghost ? ", in another view" : ""}` });
    g.style.setProperty("--d", colorOf(nm.id));
    g.append(el("rect", { class: "body", width: nm.w, height: nm.h, rx: 6 }));
    if (!nm.compact) g.append(el("path", { class: "head", d: `M0.5,6.5 a6,6 0 0 1 6,-6 h${nm.w - 13} a6,6 0 0 1 6,6 v${HEAD - 7} h${-(nm.w - 1)} z` }));
    g.append(el("text", { class: "t", x: 12, y: 19 }, m.label));
    g.append(el("text", { class: "s", x: 12, y: 33 }, domainOf(nm.id).toUpperCase()));
    if (!nm.compact) {
      g.append(el("line", { class: "div", x1: 0, x2: nm.w, y1: HEAD, y2: HEAD }));
      if (nm.nested) g.append(el("text", { class: "nest", x: nm.w - 12, y: 19, "text-anchor": "end" }, "↻"));
      if (nm.divider) g.append(el("line", { class: "div", x1: 12, x2: nm.w - 12, y1: nm.divider, y2: nm.divider, "stroke-dasharray": "2 3" }));
      for (const row of nm.rows) {
        const y = row.y + 14;
        if (row.key) { g.append(el("text", { class: "k", x: 26, y }, row.key)); continue; }
        g.append(el("text", { class: "gl" + (row.r.req ? " req" : ""), x: 15, y, "text-anchor": "middle" }, glyph(row.r)));
        g.append(el("text", { class: "f", x: 26, y }, row.r.field));
        g.append(el("text", { class: "tg", x: nm.w - 12, y, "text-anchor": "end" }, targetText(nm.id, row.r)));
      }
    }
    nodeLayer.append(g);
  }
  vp.replaceChildren(edgeLayer, nodeLayer);
}

function highlight(nodeId) {
  svg.classList.toggle("has-sel", !!nodeId);
  const near = new Set();
  for (const p of vp.querySelectorAll(".e")) {
    const on = !!nodeId && (p.dataset.from === nodeId || p.dataset.to === nodeId);
    p.classList.toggle("hi", on);
    p.setAttribute("marker-end", on ? "url(#mm-arr-hi)" : "url(#mm-arr)");
    if (on) { near.add(p.dataset.from); near.add(p.dataset.to); p.parentNode.append(p); }
  }
  for (const g of vp.querySelectorAll(".n")) {
    g.classList.toggle("sel", g.dataset.node === nodeId);
    g.classList.toggle("near", near.has(g.dataset.node));
  }
}

/* ---------- pan & zoom ---------- */
const T = { x: 0, y: 0, k: 1 };
const apply = () => vp.setAttribute("transform", `translate(${T.x},${T.y}) scale(${T.k})`);
function zoomAt(px, py, f) {
  const k = Math.min(Math.max(T.k * f, 0.12), 3);
  T.x = px - (px - T.x) * (k / T.k); T.y = py - (py - T.y) * (k / T.k); T.k = k; apply();
}
const visibleWidth = () => !panel.hidden && svg.clientWidth > 760 ? svg.clientWidth - 360 : svg.clientWidth;
function fit() {
  if (!current) return;
  const W = visibleWidth(), H = svg.clientHeight, w = current.out.width || 1, h = current.out.height || 1;
  T.k = Math.min(Math.max(Math.min((W - 24) / w, (H - 64) / h, 1.1), 0.12), 3);
  T.x = (W - w * T.k) / 2; T.y = Math.max((H - 44 - h * T.k) / 2, 8); apply();
}
const pts = new Map();
let dragged = false, pinch = null;
svg.addEventListener("pointerdown", e => { pts.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY }); dragged = false; pinch = null; });
svg.addEventListener("pointermove", e => {
  const p = pts.get(e.pointerId);
  if (!p) return;
  if (pts.size === 1) {
    if (!dragged && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 4) { dragged = true; svg.setPointerCapture(e.pointerId); svg.classList.add("dragging"); }
    if (dragged) { T.x += e.clientX - p.x; T.y += e.clientY - p.y; apply(); }
  } else if (pts.size === 2) {
    dragged = true;
    const [a, b] = [...pts.values()], r = svg.getBoundingClientRect();
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch) zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, d / pinch);
    pinch = d;
  }
  p.x = e.clientX; p.y = e.clientY;
});
const release = e => { pts.delete(e.pointerId); pinch = null; svg.classList.remove("dragging"); };
svg.addEventListener("pointerup", release);
svg.addEventListener("pointercancel", release);
svg.addEventListener("wheel", e => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) { const r = svg.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01)); }
  else { T.x -= e.deltaX; T.y -= e.deltaY; apply(); }
}, { passive: false });
const zoomCenter = f => zoomAt(visibleWidth() / 2, svg.clientHeight / 2, f);
$("zin").onclick = () => zoomCenter(1.25);
$("zout").onclick = () => zoomCenter(0.8);
$("zfit").onclick = fit;

/* ---------- state ---------- */
const state = { view: "overview", sel: null, optional: true, tenant: false };

function setHash() {
  try { history.replaceState(null, "", "#" + (state.sel || "view-" + state.view)); } catch {}
}

async function show(view, selId = null) {
  state.view = view;
  viewSelect.value = view;
  $("blurb").textContent = VIEWS[view].blurb;
  $("status").hidden = false;
  try {
    const res = await layout(view, state);
    if (state.view !== view) return;
    draw(res);
    $("status").hidden = true;
    select(selId, false);
    fit();
  } catch (err) {
    $("status").textContent = `The diagram could not be laid out: ${err.message}`;
  }
}

function nodeIdFor(id) {
  if (!current) return null;
  if (current.nodes.has(id)) return id;
  return current.nodes.has("g:" + id) ? "g:" + id : null;
}

function select(id, refit = true) {
  state.sel = id && M[id] ? id : null;
  const nid = state.sel ? nodeIdFor(state.sel) : null;
  highlight(nid);
  renderPanel();
  $("stage").classList.toggle("with-panel", !!state.sel);
  setHash();
  if (refit && nid) {
    const n = current.out.children.find(c => c.id === nid), W = visibleWidth(), H = svg.clientHeight;
    const cx = T.x + (n.x + n.width / 2) * T.k, cy = T.y + (n.y + n.height / 2) * T.k;
    if (cx < 0 || cx > W || cy < 0 || cy > H) { T.x += W / 2 - cx; T.y += H / 2 - cy; apply(); }
  }
}

function goTo(id) {
  if (current && current.nodes.has(id)) select(id);
  else show(M[id].view, id);
}

svg.addEventListener("click", e => {
  if (dragged) return;
  const g = e.target.closest(".n");
  if (!g) return select(null);
  g.classList.contains("ghost") ? show(M[g.dataset.id].view, g.dataset.id) : select(g.dataset.id);
});
root.addEventListener("keydown", e => {
  const g = e.target.closest && e.target.closest(".n");
  if (g && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); g.dispatchEvent(new MouseEvent("click", { bubbles: true })); return; }
  if (e.target.matches("input, select")) return;
  if (e.key === "Escape") select(null);
  else if (e.key === "+" || e.key === "=") zoomCenter(1.25);
  else if (e.key === "-") zoomCenter(0.8);
  else if (e.key === "0") fit();
});
viewSelect.addEventListener("change", () => show(viewSelect.value));
$("optional").addEventListener("change", e => { state.optional = e.target.checked; show(state.view, state.sel); });
$("tenant").addEventListener("change", e => { state.tenant = e.target.checked; show(state.view, state.sel); });
$("search").addEventListener("change", e => {
  const q = e.target.value.trim().toLowerCase();
  const id = byLabel.get(q) || Object.keys(M).find(k => M[k].label.toLowerCase() === q);
  if (id) { goTo(id); e.target.value = ""; e.target.blur(); }
});
window.addEventListener("resize", () => current && fit());
window.addEventListener("hashchange", () => fromHash());

/* ---------- panel ---------- */
const link = id => `<button type="button" class="mm-link" data-go="${esc(id)}">${esc(M[id].label)}</button>`;
function relItem(id, r) {
  const targets = isSelf(id, r) ? `<span class="mm-muted">${esc(M[id].label)} (self)</span>`
    : r.targets.length ? r.targets.map(link).join("") : `<span class="mm-muted">any of several types</span>`;
  const note = r.kind === "m2m" ? ' <span class="mm-muted">many</span>' : r.kind === "o2o" ? ' <span class="mm-muted">1:1</span>' : "";
  return `<li class="mm-rel"><span class="gl${r.req ? " req" : ""}">${glyph(r)}</span><code>${esc(r.field)}</code><span class="mm-links">${targets}${note}</span></li>`;
}
function section(title, items, empty) {
  return `<section><h3>${title}</h3>${items.length ? `<ul>${items.join("")}</ul>` : `<p class="mm-empty">${empty}</p>`}</section>`;
}
function renderPanel() {
  const id = state.sel;
  panel.hidden = !id;
  if (!id) return;
  const m = M[id], req = m.rels.filter(r => r.req), opt = m.rels.filter(r => !r.req);
  const inbound = m.inbound.slice().sort((a, b) => M[a.from].label.localeCompare(M[b.from].label));
  const viewName = VIEWS[m.view].name;
  const chip = viewName.startsWith(domainOf(id)) ? viewName : `${domainOf(id)} · ${viewName}`;
  const href = m.url ? D.netbox_url + m.url : null;
  const rules = [...m.notes.map(r => `<li class="note">${esc(r)}</li>`), ...m.rules.map(r => `<li>${esc(r)}</li>`)];
  panel.style.setProperty("--d", colorOf(id));
  panel.innerHTML = `
    <div class="mm-ptop"><span class="mm-chip">${esc(chip)}</span>
      <button type="button" class="mm-close" id="mm-close" aria-label="Close details">×</button></div>
    <h2>${esc(m.label)}</h2>
    <p class="mm-meta"><code>${esc(id)}</code>${href ? `<a href="${esc(href)}"${D.netbox_url ? ' target="_blank" rel="noopener"' : ""}>Open in NetBox${D.netbox_url ? " ↗" : ""}</a>` : ""}</p>
    ${m.desc ? `<p class="mm-desc">${esc(m.desc)}</p>` : ""}
    ${section("Needs first", req.map(r => relItem(id, r)), "Nothing: this model can be created on its own.")}
    ${section("Can link to", opt.map(r => relItem(id, r)), "No optional links.")}
    ${section("Referenced by", inbound.map(x => `<li class="mm-rel"><span class="gl${x.rel.req ? " req" : ""}">${glyph(x.rel)}</span><span class="mm-links">${link(x.from)}</span><code class="mm-muted">.${esc(x.rel.field)}</code></li>`), "No other model points here.")}
    ${rules.length ? `<section><h3>Rules</h3><ul class="mm-rules">${rules.join("")}</ul></section>` : ""}
    ${m.keys.length ? `<section><h3>Key fields</h3><p class="mm-keys">${m.keys.map(k => `<code>${esc(k)}</code>`).join("")}</p></section>` : ""}`;
  panel.scrollTop = 0;
  $("close").onclick = () => select(null);
  for (const b of panel.querySelectorAll("[data-go]")) b.onclick = () => goTo(b.dataset.go);
}

/* ---------- start ---------- */
function fromHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith("view-") && VIEWS[h.slice(5)]) return show(h.slice(5));
  if (M[h]) return state.view === M[h].view && current ? select(h) : show(M[h].view, h);
  show(state.view, state.sel);
}
Promise.all(Object.values(FONT).map(f => document.fonts.load(f).catch(() => null)))
  .then(() => document.fonts.ready).finally(fromHash);
})();
