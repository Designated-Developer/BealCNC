// NorrisCAM — UPDATED
// - Display rotated 90° counter-clockwise (screen matches machine orientation)
// - HOME dot moved to top-right (screen) after rotation
// - Stock size + part size + fit check (live)
// - Scale → Target: scale to target width/height using current rotation
// Machine: General International i-Carver 40-915 XM1 CNC Router
// Travel: X = 15" (back↔front), Y = 20" (right↔left)
// Workflow: center of stock (WCS 0,0 at stock center)
// NC preview: reveal from line 1, pinned cursor @ 0.33, page never scrolls

const NC_PIN_FRACTION = 0.33;

// Machine footprint (inches)
const MACHINE_X_TRAVEL = 15;
const MACHINE_Y_TRAVEL = 20;
const MACHINE_CENTER_SHIFT = { x: MACHINE_X_TRAVEL / 2, y: MACHINE_Y_TRAVEL / 2 };

// Display rotation: 90° CCW
// World p(x,y) -> rotated q(x',y') = (-y, x)
function rotCCW90(p) { return { x: -p.y, y: p.x }; }
// Inverse: q -> p = (y', -x')
function rotCW90(p) { return { x: p.y, y: -p.x }; }

const $ = (id) => document.getElementById(id);

const canvas = $("c");
const ctx = canvas.getContext("2d");

// DXF + geometry state
let dxfParsed = null;
let baseGeomSegs = [];     // origin-shifted, UN-transformed segments
let geomSegs = [];         // transformed (rotate+scale) segments used for drawing/toolpath

let currentScale = 1.0;
let currentRotDeg = 0.0;

// Toolpath + NC state
let toolSegs = [];
let ncLines = [];
let ncText = "";

// Reveal state
let revealSegCount = 0;
let currentNCLine = -1;
let shownNCMax = -1;
let playTimer = null;

// View state (keep stable)
const view = { scale: 50, ox: 0, oy: 0 };
let viewLocked = false;
let lockedView = { scale: view.scale, ox: view.ox, oy: view.oy };
let userTouchedView = false;

// ---------------- Build Summary ----------------
function resetBuildSummary() {
  if (window.updateBuildSummary) {
    window.updateBuildSummary({
      segments: "—",
      passes: "—",
      cutDistIn: "—",
      estTimeMin: 0,
      boundsText: "—",
      tone: null
    });
  }
}

function updateBuildSummaryFromBuild(opts, toolSegments, over) {
  const depth = Math.abs(opts.depth);
  const step = Math.max(0.001, opts.stepDown);
  const passes = Math.max(1, Math.ceil(depth / step));

  let cutDist = 0;
  for (const s of toolSegments) {
    if (s.mode !== "CUT") continue;
    cutDist += Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
  }

  const feed = Math.max(1e-6, Number(opts.feedXY) || 1);
  const estMin = cutDist / feed;

  const boundsText =
    `X ${over.minX.toFixed(2)}→${over.maxX.toFixed(2)} • Y ${over.minY.toFixed(2)}→${over.maxY.toFixed(2)}`;

  const tone = over.isOver ? "warn" : "ok";

  if (window.updateBuildSummary) {
    window.updateBuildSummary({
      segments: String(toolSegments.length),
      passes: String(passes),
      cutDistIn: `${cutDist.toFixed(1)} in`,
      estTimeMin: estMin,
      boundsText,
      tone
    });
  }
}

// ---------------- UI ----------------
function setStatus(kind, title, detail) {
  const dot = $("statusDot");
  const t = $("topStatus");
  const s = $("stats");
  if (t) t.textContent = title || "";
  if (s) s.textContent = detail || "";
  if (dot) {
    dot.classList.remove("ok", "bad", "warn");
    dot.classList.add(kind || "warn");
  }
}

function enableAfterImport(enabled) {
  $("buildToolpath").disabled = !enabled;
  $("exportDat").disabled = true;
  $("stepBtn").disabled = true;
  $("backBtn").disabled = true;
  $("playBtn").disabled = true;
  $("pauseBtn").disabled = true;
}

function enableAfterBuild(enabled) {
  $("exportDat").disabled = !enabled;
  $("stepBtn").disabled = !enabled;
  $("backBtn").disabled = !enabled;
  $("playBtn").disabled = !enabled;
  $("pauseBtn").disabled = !enabled;
}

function readOpts() {
  const safeZ = Number($("safeZ").value || 0.5);
  const depth = Math.abs(Number($("cutZ").value || 0.0625));
  const stepDown = Math.max(0.001, Number($("stepDown").value || 0.0625));
  const feedXY = Number($("feedXY").value || 30);
  const feedZ = Number($("feedZ").value || 20);
  const outPrec = Math.max(0.0005, Number($("outPrec").value || 0.01));
  const snapGrid = Math.max(0.001, Number($("snapGrid").value || 0.02));
  const angleTolDeg = Math.max(1, Number($("angleTolDeg").value || 14));
  const chainTol = Math.max(0.0005, Number($("chainTol").value || 0.02));
  const origin = $("origin").value || "center";
  const toolComment = $("toolComment").value || "(T1 - 1/4 endmill, centerline, no comp)";
  const rpm = Math.max(0, Math.floor(Number($("spindleRPM").value || 12000)));
  return { safeZ, depth, stepDown, feedXY, feedZ, outPrec, snapGrid, angleTolDeg, chainTol, origin, toolComment, rpm };
}

// ---------------- Math helpers ----------------
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function samePt(a, b, tol) { return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol; }
function snapPoint(p, g) { return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g }; }

function fmt(n, step) {
  const q = Math.round(n / step) * step;
  let dec = 0;
  if (step < 1) dec = Math.max(0, Math.ceil(-Math.log10(step)));
  return q.toFixed(dec).replace(/\.?0+$/, "");
}

function bounds(segs) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of segs) {
    minX = Math.min(minX, s.a.x, s.b.x);
    minY = Math.min(minY, s.a.y, s.b.y);
    maxX = Math.max(maxX, s.a.x, s.b.x);
    maxY = Math.max(maxY, s.a.y, s.b.y);
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}

function applyOriginShift(segs, origin) {
  const b = bounds(segs);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;

  let dx = 0, dy = 0;
  if (origin === "center") { dx = -cx; dy = -cy; }
  else if (origin === "ll") { dx = -b.minX; dy = -b.minY; }
  else if (origin === "lr") { dx = -b.maxX; dy = -b.minY; }
  else if (origin === "ul") { dx = -b.minX; dy = -b.maxY; }
  else if (origin === "ur") { dx = -b.maxX; dy = -b.maxY; }

  return segs.map(s => ({
    a: { x: s.a.x + dx, y: s.a.y + dy },
    b: { x: s.b.x + dx, y: s.b.y + dy }
  }));
}

function degToRad(d) { return d * Math.PI / 180; }

function transformSegs(segs, scale, rotDeg) {
  const th = degToRad(rotDeg);
  const c = Math.cos(th), s = Math.sin(th);

  // Rotate about origin (0,0), then scale
  return segs.map(seg => {
    const ra = { x: (seg.a.x * c - seg.a.y * s), y: (seg.a.x * s + seg.a.y * c) };
    const rb = { x: (seg.b.x * c - seg.b.y * s), y: (seg.b.x * s + seg.b.y * c) };
    return {
      a: { x: ra.x * scale, y: ra.y * scale },
      b: { x: rb.x * scale, y: rb.y * scale }
    };
  });
}

// ---------------- DXF parsing ----------------
function xyOf(v) {
  if (!v) return null;
  if (typeof v.x === "number" && typeof v.y === "number") return { x: v.x, y: v.y };
  if (Array.isArray(v) && v.length >= 2) return { x: Number(v[0]), y: Number(v[1]) };
  if (v.point) return xyOf(v.point);
  return null;
}

function tessArc(center, r, a0, a1, outPrec) {
  let start = a0, end = a1;
  if (end < start) end += Math.PI * 2;

  let dTheta = Math.PI / 18;
  if (r > 1e-9) {
    const x = Math.max(-1, Math.min(1, 1 - (outPrec / r)));
    const maxStep = 2 * Math.acos(x);
    if (isFinite(maxStep) && maxStep > 1e-6) dTheta = Math.min(maxStep, Math.PI / 6);
  }

  const pts = [];
  pts.push({ x: center.x + r * Math.cos(start), y: center.y + r * Math.sin(start) });
  for (let t = start + dTheta; t < end; t += dTheta) {
    pts.push({ x: center.x + r * Math.cos(t), y: center.y + r * Math.sin(t) });
  }
  pts.push({ x: center.x + r * Math.cos(end), y: center.y + r * Math.sin(end) });

  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) segs.push({ a: pts[i], b: pts[i + 1] });
  return segs;
}

function extractSegments(dxf, outPrec) {
  const out = [];
  const ents = dxf?.entities || [];

  for (const e of ents) {
    if (e.type === "LINE") {
      const a = xyOf(e.start), b = xyOf(e.end);
      if (a && b) out.push({ a, b });
      continue;
    }

    if (e.type === "LWPOLYLINE" || e.type === "POLYLINE") {
      const verts = (e.vertices || []).map(xyOf).filter(Boolean);
      if (verts.length >= 2) {
        for (let i = 0; i < verts.length - 1; i++) out.push({ a: verts[i], b: verts[i + 1] });
        if (e.closed) out.push({ a: verts[verts.length - 1], b: verts[0] });
      }
      continue;
    }

    if (e.type === "ARC") {
      const c = xyOf(e.center);
      const r = Number(e.radius);
      if (c && isFinite(r) && r > 0) {
        let a0 = Number(e.startAngle), a1 = Number(e.endAngle);
        if (Math.abs(a0) > 2 * Math.PI || Math.abs(a1) > 2 * Math.PI) {
          a0 = a0 * Math.PI / 180;
          a1 = a1 * Math.PI / 180;
        }
        out.push(...tessArc(c, r, a0, a1, outPrec));
      }
      continue;
    }

    if (e.type === "CIRCLE") {
      const c = xyOf(e.center);
      const r = Number(e.radius);
      if (c && isFinite(r) && r > 0) out.push(...tessArc(c, r, 0, 2 * Math.PI, outPrec));
      continue;
    }

    if (e.type === "SPLINE") {
      const ptsRaw = (e.fitPoints?.length ? e.fitPoints : e.controlPoints) || [];
      const pts = ptsRaw.map(xyOf).filter(Boolean);
      if (pts.length >= 2) {
        for (let i = 0; i < pts.length - 1; i++) out.push({ a: pts[i], b: pts[i + 1] });
      }
      continue;
    }
  }

  return out;
}

// ---------------- View / canvas ----------------
function lockView() {
  lockedView = { scale: view.scale, ox: view.ox, oy: view.oy };
  viewLocked = true;
}
function applyLockedView() {
  if (!viewLocked) return;
  view.scale = lockedView.scale;
  view.ox = lockedView.ox;
  view.oy = lockedView.oy;
}

function resizeCanvasNoJump() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(r.width * dpr));
  canvas.height = Math.max(1, Math.floor(r.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  applyLockedView();
  draw();
}
window.addEventListener("resize", resizeCanvasNoJump);

function fitViewOnce(segs) {
  const r = canvas.getBoundingClientRect();
  const w = r.width, h = r.height;

  // Fit based on rotated-for-display segments (so view fits what you actually see)
  const rotSegs = segs.map(s => ({ a: rotCCW90(s.a), b: rotCCW90(s.b) }));
  const b = bounds(rotSegs);

  const bw = (b.maxX - b.minX) || 1;
  const bh = (b.maxY - b.minY) || 1;
  const pad = 36;

  view.scale = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;

  view.ox = w / 2 - cx * view.scale;
  view.oy = h / 2 + cy * view.scale;

  lockView();
}

// World -> Screen with display rotation applied
function w2s(p) {
  const pr = rotCCW90(p);
  return { x: pr.x * view.scale + view.ox, y: -pr.y * view.scale + view.oy };
}

// Screen -> World (inverse) with display rotation applied
function s2w(mx, my) {
  const q = { x: (mx - view.ox) / view.scale, y: -(my - view.oy) / view.scale };
  return rotCW90(q);
}

// Pan/zoom
let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener("mousedown", (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
window.addEventListener("mouseup", () => dragging = false);
window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  userTouchedView = true;
  viewLocked = false;
  view.ox += (e.clientX - lastX);
  view.oy += (e.clientY - lastY);
  lastX = e.clientX;
  lastY = e.clientY;
  draw();
});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  userTouchedView = true;
  viewLocked = false;

  const r = canvas.getBoundingClientRect();
  const mx = e.clientX - r.left;
  const my = e.clientY - r.top;

  const before = s2w(mx, my);
  const zoom = Math.exp(-e.deltaY * 0.001);
  view.scale *= zoom;
  const after = s2w(mx, my);

  // Keep point under cursor fixed
  // (same technique, but using our rotated s2w)
  const dBefore = rotCCW90(before);
  const dAfter  = rotCCW90(after);
  view.ox += (dBefore.x - dAfter.x) * view.scale;
  view.oy -= (dBefore.y - dAfter.y) * view.scale;

  draw();
}, { passive: false });

// ---------------- Live Part/Stock sizing + fit ----------------
function readStock() {
  const sw = Math.max(0, Number($("stockW")?.value || 0));
  const sh = Math.max(0, Number($("stockH")?.value || 0));
  return { sw, sh };
}

function setFitPill(partW, partH, sw, sh) {
  const pill = $("fitPill");
  const partTxt = $("partSizeTxt");
  const fitTxt = $("fitTxt");
  if (!pill || !partTxt || !fitTxt) return;

  if (!(partW > 0 && partH > 0)) {
    partTxt.textContent = "—";
    fitTxt.textContent = "—";
    pill.classList.remove("ok","warn","bad");
    return;
  }

  partTxt.textContent = `${partW.toFixed(2)}"×${partH.toFixed(2)}"`;

  if (!(sw > 0 && sh > 0)) {
    fitTxt.textContent = "set stock";
    pill.classList.remove("ok","warn","bad");
    pill.classList.add("warn");
    return;
  }

  const fits = (partW <= sw + 1e-9) && (partH <= sh + 1e-9);
  const marginW = sw - partW;
  const marginH = sh - partH;

  if (fits) {
    fitTxt.textContent = `FITS (+${marginW.toFixed(2)}", +${marginH.toFixed(2)}")`;
    pill.classList.remove("warn","bad");
    pill.classList.add("ok");
  } else {
    const overW = Math.max(0, -marginW);
    const overH = Math.max(0, -marginH);
    fitTxt.textContent = `TOO BIG (+${overW.toFixed(2)}", +${overH.toFixed(2)}")`;
    pill.classList.remove("ok","warn");
    pill.classList.add("bad");
  }
}

function updatePartAndFitReadout() {
  if (!geomSegs.length) {
    setFitPill(0, 0, 0, 0);
    return;
  }
  const b = bounds(geomSegs);
  const partW = (b.maxX - b.minX) || 0;
  const partH = (b.maxY - b.minY) || 0;
  const { sw, sh } = readStock();
  setFitPill(partW, partH, sw, sh);
}

// ---------------- Machine overlay ----------------
function drawMachineOverlay() {
  if (!$("showFootprint").checked) return;

  // Center-zero workflow => bounds in part coords:
  const minX = -MACHINE_X_TRAVEL / 2;
  const maxX = +MACHINE_X_TRAVEL / 2;
  const minY = -MACHINE_Y_TRAVEL / 2;
  const maxY = +MACHINE_Y_TRAVEL / 2;

  const p1 = w2s({ x: minX, y: minY });
  const p2 = w2s({ x: maxX, y: minY });
  const p3 = w2s({ x: maxX, y: maxY });
  const p4 = w2s({ x: minX, y: maxY });

  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 7]);

  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.lineTo(p3.x, p3.y);
  ctx.lineTo(p4.x, p4.y);
  ctx.closePath();
  ctx.stroke();

  ctx.setLineDash([]);

  // ✅ HOME: user-marked top-right (screen)
  // With display rotated 90° CCW, the world corner (maxX, minY) becomes top-right on screen.
  const homeWorld = { x: maxX, y: minY };
  const home = w2s(homeWorld);

  ctx.fillStyle = "rgba(255,255,255,0.90)";
  ctx.beginPath();
  ctx.arc(home.x, home.y, 5, 0, Math.PI * 2);
  ctx.fill();

  ctx.font = "800 12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillStyle = "rgba(255,255,255,0.70)";
  ctx.fillText("HOME", home.x - 46, home.y - 10);

  ctx.restore();
}

// ---------------- Drawing ----------------
function drawGrid() {
  const r = canvas.getBoundingClientRect();
  const w = r.width, h = r.height;
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;

  const step = 50;
  for (let x = 0; x <= w; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y <= h; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

  ctx.restore();
}

function drawGeom() {
  if (!geomSegs.length) return;
  ctx.save();
  ctx.strokeStyle = "rgba(125,211,252,0.95)";
  ctx.lineWidth = 2;
  for (const s of geomSegs) {
    const a = w2s(s.a), b = w2s(s.b);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.restore();
}

function drawToolReveal() {
  if (!toolSegs.length) return;
  const n = Math.min(revealSegCount, toolSegs.length);

  // dashed rapids
  ctx.save();
  ctx.strokeStyle = "rgba(122,167,255,0.35)";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 6]);
  for (let i = 0; i < n; i++) {
    const s = toolSegs[i];
    if (s.mode !== "RAPID") continue;
    const a = w2s(s.a), b = w2s(s.b);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.restore();

  // cuts + out-of-bounds
  ctx.save();
  ctx.lineWidth = 2;
  for (let i = 0; i < n; i++) {
    const s = toolSegs[i];
    if (s.mode !== "CUT") continue;
    ctx.strokeStyle = s.outOfBounds ? "rgba(251,191,36,0.95)" : "rgba(255,120,120,0.95)";
    const a = w2s(s.a), b = w2s(s.b);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.restore();
}

function draw() {
  const r = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  drawGrid();
  drawMachineOverlay();
  drawGeom();
  drawToolReveal();
}

// ---------------- Toolpath planning ----------------
function angle(a, b) { return Math.atan2(b.y - a.y, b.x - a.x); }
function normAng(x) { while (x < -Math.PI) x += 2 * Math.PI; while (x > Math.PI) x -= 2 * Math.PI; return x; }

function mergeCollinear(chain, tol) {
  const out = [];
  const eps = Math.max(1e-12, tol * tol);
  function collinear(a, b, c) {
    return Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) <= eps;
  }
  let i = 0;
  while (i < chain.length) {
    let a = chain[i].a, b = chain[i].b;
    let j = i + 1;
    while (j < chain.length) {
      const n = chain[j];
      if (!samePt(b, n.a, tol)) break;
      if (!collinear(a, b, n.b)) break;
      b = n.b;
      j++;
    }
    out.push({ a, b });
    i = j;
  }
  return out;
}

function buildPaths(lines, opts) {
  const g = opts.snapGrid;
  const tol = g * 0.55;
  const angTol = degToRad(opts.angleTolDeg);
  const minLen = Math.max(opts.outPrec * 0.8, g * 0.5);

  const L = lines
    .map(s => ({ a: snapPoint(s.a, g), b: snapPoint(s.b, g) }))
    .filter(s => dist(s.a, s.b) >= minLen);

  const key = (p) => `${Math.round(p.x / g)},${Math.round(p.y / g)}`;
  const map = new Map();
  for (let i = 0; i < L.length; i++) {
    const k = key(L[i].a);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(i);
  }

  const used = new Array(L.length).fill(false);
  const paths = [];

  for (let i = 0; i < L.length; i++) {
    if (used[i]) continue;
    used[i] = true;

    const chain = [L[i]];
    let cur = L[i];

    while (true) {
      const end = cur.b;
      const cand = map.get(key(end)) || [];
      const d0 = angle(cur.a, cur.b);

      let best = -1, bestScore = Infinity;
      for (const idx of cand) {
        if (used[idx]) continue;
        const s = L[idx];
        if (!samePt(end, s.a, tol)) continue;
        const d1 = angle(s.a, s.b);
        const da = Math.abs(normAng(d1 - d0));
        if (da <= angTol && da < bestScore) {
          best = idx; bestScore = da;
        }
      }
      if (best === -1) break;
      used[best] = true;
      chain.push(L[best]);
      cur = L[best];
    }

    const merged = mergeCollinear(chain, g);
    if (merged.length) paths.push({ segs: merged });
  }

  return paths;
}

function orderNearest(paths) {
  const rem = paths.slice();
  if (rem.length <= 1) return rem;
  const out = [rem.shift()];
  let curPt = out[0].segs[out[0].segs.length - 1].b;

  while (rem.length) {
    let bestI = -1, bestD = Infinity, flip = false;
    for (let i = 0; i < rem.length; i++) {
      const p = rem[i];
      const a = p.segs[0].a;
      const b = p.segs[p.segs.length - 1].b;
      const dA = dist(curPt, a);
      const dB = dist(curPt, b);
      if (dA < bestD) { bestD = dA; bestI = i; flip = false; }
      if (dB < bestD) { bestD = dB; bestI = i; flip = true; }
    }
    let next = rem.splice(bestI, 1)[0];
    if (flip) next = { segs: next.segs.slice().reverse().map(s => ({ a: s.b, b: s.a })) };
    out.push(next);
    curPt = next.segs[next.segs.length - 1].b;
  }
  return out;
}

function mergeContinuous(paths, chainTol) {
  if (paths.length <= 1) return paths;
  const out = [];
  let cur = paths[0];
  for (let i = 1; i < paths.length; i++) {
    const nxt = paths[i];
    const ce = cur.segs[cur.segs.length - 1].b;
    const ns = nxt.segs[0].a;
    if (samePt(ce, ns, chainTol)) cur = { segs: cur.segs.concat(nxt.segs) };
    else { out.push(cur); cur = nxt; }
  }
  out.push(cur);
  return out;
}

// ---------------- Machine bounds check ----------------
function toMachineCoords(p) {
  // Center-zero -> machine coords: [0..travel]
  return { x: p.x + MACHINE_CENTER_SHIFT.x, y: p.y + MACHINE_CENTER_SHIFT.y };
}
function insideMachine(pm) {
  return (pm.x >= 0 && pm.x <= MACHINE_X_TRAVEL && pm.y >= 0 && pm.y <= MACHINE_Y_TRAVEL);
}
function checkOvertravelAndMark(toolSegments) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

  for (const s of toolSegments) {
    const am = toMachineCoords(s.a);
    const bm = toMachineCoords(s.b);

    minX = Math.min(minX, am.x, bm.x);
    maxX = Math.max(maxX, am.x, bm.x);
    minY = Math.min(minY, am.y, bm.y);
    maxY = Math.max(maxY, am.y, bm.y);

    s.outOfBounds = !(insideMachine(am) && insideMachine(bm));
  }

  return {
    minX, maxX, minY, maxY,
    isOver: (minX < 0) || (maxX > MACHINE_X_TRAVEL) || (minY < 0) || (maxY > MACHINE_Y_TRAVEL)
  };
}

// ---------------- NC generation ----------------
function buildProgram(paths, opts) {
  const P = opts.outPrec;
  const safeZ = opts.safeZ;
  const depth = opts.depth;
  const step = opts.stepDown;
  const passes = Math.max(1, Math.ceil(depth / step));
  const zPass = [];
  for (let i = 1; i <= passes; i++) zPass.push(-Math.min(depth, i * step));

  const lines = [];
  const segs = [];

  const push = (line) => { lines.push(line); return lines.length - 1; };
  const outXY = (x, y) => `X${fmt(x, P)} Y${fmt(y, P)}`;
  const outZ = (z) => `Z${fmt(z, P)}`;

  push("%");
  push("(NorrisCAM - USB G-code)");
  push(opts.toolComment);
  push("G90 (absolute)");
  push("G94 (feed/min)");
  push("G17 (XY plane)");
  push("G20 (inches)");
  push("G40 (cancel cutter comp)");
  push("G49 (cancel tool length offset)");
  push("G54 (work offset)");
  push(`M3 S${opts.rpm} (spindle on)`);
  push(`G0 ${outZ(safeZ)}`);

  let curXY = { x: 0, y: 0 };
  let curZ = safeZ;
  let lastF = null;

  function retract() {
    if (curZ !== safeZ) {
      push(`G0 ${outZ(safeZ)}`);
      curZ = safeZ;
    }
  }
  function rapidTo(x, y) {
    const a = { ...curXY }, b = { x, y };
    const ln = push(`G0 ${outXY(x, y)}`);
    segs.push({ a, b, mode: "RAPID", ncLineIdx: ln });
    curXY = b;
  }
  function plunge(z) {
    const ln = push(lastF === opts.feedZ ? `G1 ${outZ(z)}` : `G1 ${outZ(z)} F${fmt(opts.feedZ, 0.1)}`);
    lastF = opts.feedZ;
    curZ = z;
    return ln;
  }
  function setFeedXY() {
    if (lastF !== opts.feedXY) {
      push(`F${fmt(opts.feedXY, 0.1)}`);
      lastF = opts.feedXY;
    }
  }
  function cutTo(x, y) {
    const a = { ...curXY }, b = { x, y };
    const ln = push(`G1 ${outXY(x, y)}`);
    segs.push({ a, b, mode: "CUT", ncLineIdx: ln });
    curXY = b;
  }

  for (const z of zPass) {
    retract();

    for (const p of paths) {
      if (!p.segs.length) continue;
      const start = p.segs[0].a;

      // tool-down chaining: if already at start, stay down
      if (!samePt(curXY, start, opts.chainTol)) {
        retract();
        rapidTo(start.x, start.y);
        plunge(z);
        setFeedXY();
      } else {
        if (curZ !== z) plunge(z);
        setFeedXY();
      }

      for (const s of p.segs) cutTo(s.b.x, s.b.y);
    }

    retract();
  }

  push(`G0 ${outZ(safeZ)}`);
  push("M5 (spindle stop)");
  push("M30 (end)");
  push("%");

  return { ncLines: lines, ncText: lines.join("\n"), toolSegs: segs };
}

// ---------------- NC reveal rendering ----------------
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pad4(n) { return String(n).padStart(4, "0"); }

function renderNC() {
  const box = $("ncBox");
  if (!box) return;

  if (!ncLines.length) {
    box.innerHTML = `<div class="ncLine"><div class="ln">----</div><div class="code">DAT will appear here after Build…</div></div>`;
    return;
  }

  const maxLine = Math.min(shownNCMax, ncLines.length - 1);
  const html = [];
  for (let i = 0; i <= maxLine; i++) {
    const hi = (i === currentNCLine) ? "hi" : "";
    html.push(
      `<div class="ncLine ${hi}" data-ln="${i}">
        <div class="ln">${pad4(i + 1)}</div>
        <div class="code">${escapeHtml(ncLines[i])}</div>
      </div>`
    );
  }
  box.innerHTML = html.join("");

  if (currentNCLine >= 0) {
    const el = box.querySelector(`[data-ln="${currentNCLine}"]`);
    if (el) {
      const pinY = box.clientHeight * NC_PIN_FRACTION;
      const elCenterY = el.offsetTop + el.offsetHeight * 0.5;
      let desired = elCenterY - pinY;
      const maxScroll = Math.max(0, box.scrollHeight - box.clientHeight);
      desired = Math.max(0, Math.min(maxScroll, desired));
      box.scrollTo({ top: desired, behavior: playTimer ? "smooth" : "auto" });
    }
  }
}

// ---------------- Step/Play ----------------
function setPlaying(on) {
  if (on) {
    if (playTimer) return;
    playTimer = setInterval(() => {
      if (revealSegCount >= toolSegs.length) { setPlaying(false); return; }
      step(+1);
    }, 120);
  } else {
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
  }
}

function syncFromReveal() {
  if (revealSegCount <= 0) {
    currentNCLine = -1;
    renderNC();
    return;
  }
  const seg = toolSegs[Math.min(revealSegCount - 1, toolSegs.length - 1)];
  currentNCLine = seg?.ncLineIdx ?? -1;
  if (currentNCLine >= 0) shownNCMax = Math.max(shownNCMax, currentNCLine);
  renderNC();
}

function step(dir) {
  if (!toolSegs.length) return;
  if (dir > 0) revealSegCount = Math.min(toolSegs.length, revealSegCount + 1);
  else revealSegCount = Math.max(0, revealSegCount - 1);
  syncFromReveal();
  draw();
}

// ---------------- Tabs ----------------
function setTab(which) {
  $("tabMain").classList.toggle("active", which === "main");
  $("tabOptions").classList.toggle("active", which === "options");
  $("paneMain").classList.toggle("active", which === "main");
  $("paneOptions").classList.toggle("active", which === "options");
}

// ---------------- Transform actions ----------------
function readTransformFromUI() {
  const pct = Math.max(1, Number($("scalePct").value || 100));
  const rot = Number($("rotDeg").value || 0);
  currentScale = pct / 100;
  currentRotDeg = rot;
}

function applyTransform(keepViewStable = true) {
  if (!baseGeomSegs.length) return;

  readTransformFromUI();
  geomSegs = transformSegs(baseGeomSegs, currentScale, currentRotDeg);

  // Keep view stable
  if (keepViewStable) {
    if (!viewLocked) lockView();
  } else if (!userTouchedView) {
    fitViewOnce(geomSegs);
  }

  // Clear toolpath because geometry changed
  toolSegs = [];
  ncLines = [];
  ncText = "";
  revealSegCount = 0;
  currentNCLine = -1;
  shownNCMax = -1;
  enableAfterBuild(false);

  resetBuildSummary();

  renderNC();
  draw();

  updatePartAndFitReadout();

  setStatus("ok", "Transform applied", `Scale=${Math.round(currentScale * 100)}% • Rotate=${Math.round(currentRotDeg)}° • Build toolpath again.`);
}

function computeFitScaleForRotation(baseSegs, rotDeg) {
  const rotated = transformSegs(baseSegs, 1.0, rotDeg);
  const b = bounds(rotated);
  const w = (b.maxX - b.minX) || 1;
  const h = (b.maxY - b.minY) || 1;

  const maxW = MACHINE_X_TRAVEL;
  const maxH = MACHINE_Y_TRAVEL;

  const factor = Math.min(maxW / w, maxH / h) * 0.98;
  return Math.max(0.001, factor);
}

function fitToMachine() {
  if (!baseGeomSegs.length) return;

  const rot = Number($("rotDeg").value || 0);
  const fitScale = computeFitScaleForRotation(baseGeomSegs, rot);
  const pct = Math.max(1, Math.round(fitScale * 100));

  $("scalePct").value = String(pct);
  applyTransform(true);
}

function resetTransform() {
  $("scalePct").value = "100";
  $("rotDeg").value = "0";
  applyTransform(true);
}

// ---------------- Scale → Target (NEW) ----------------
function scaleToTarget() {
  if (!baseGeomSegs.length) return;

  // Use current rotation from UI (so scale is computed for what you’ll actually cut)
  const rot = Number($("rotDeg").value || 0);
  const targetW = Math.max(0, Number($("targetW")?.value || 0));
  const targetH = Math.max(0, Number($("targetH")?.value || 0));

  const rotated = transformSegs(baseGeomSegs, 1.0, rot);
  const b = bounds(rotated);
  const w = (b.maxX - b.minX) || 1;
  const h = (b.maxY - b.minY) || 1;

  let s = 1.0;

  const hasW = targetW > 0;
  const hasH = targetH > 0;

  if (hasW && hasH) s = Math.min(targetW / w, targetH / h);
  else if (hasW) s = targetW / w;
  else if (hasH) s = targetH / h;
  else {
    setStatus("warn", "Set Target W/H", "Enter Target W and/or Target H (inches).");
    return;
  }

  s = Math.max(0.001, s);

  const pct = Math.max(1, Math.round(s * 100));
  $("scalePct").value = String(pct);

  applyTransform(true);

  setStatus("ok", "Scaled to target", `Target W=${hasW ? targetW : "—"} • Target H=${hasH ? targetH : "—"} • Scale=${pct}%`);
}

// ---------------- Events ----------------
$("tabMain").addEventListener("click", () => setTab("main"));
$("tabOptions").addEventListener("click", () => setTab("options"));

$("showFootprint").addEventListener("change", () => draw());

$("applyTransform").addEventListener("click", () => applyTransform(true));
$("fitToMachine").addEventListener("click", () => fitToMachine());
$("resetTransform").addEventListener("click", () => resetTransform());

$("scaleToTarget").addEventListener("click", () => scaleToTarget());

$("stockW").addEventListener("input", () => updatePartAndFitReadout());
$("stockH").addEventListener("input", () => updatePartAndFitReadout());

$("stepBtn").addEventListener("click", () => step(+1));
$("backBtn").addEventListener("click", () => step(-1));
$("playBtn").addEventListener("click", () => setPlaying(true));
$("pauseBtn").addEventListener("click", () => setPlaying(false));

window.addEventListener("keydown", (e) => {
  if (e.code === "Space") e.preventDefault();

  const tag = document.activeElement?.tagName?.toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") return;

  if ((e.key === "s" || e.key === "S") && !$("stepBtn").disabled) { e.preventDefault(); step(+1); }
  if ((e.key === "b" || e.key === "B") && !$("backBtn").disabled) { e.preventDefault(); step(-1); }
  if (e.code === "Space" && !$("playBtn").disabled) {
    e.preventDefault();
    setPlaying(!playTimer);
  }
});

// Import DXF
$("file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  setPlaying(false);
  resetBuildSummary();
  setStatus("warn", "Loading…", file.name);

  try {
    const text = await file.text();
    const parser = new window.DxfParser();
    dxfParsed = parser.parseSync(text);
  } catch (err) {
    console.error(err);
    setStatus("bad", "DXF parse failed", "Try R12/ASCII DXF export.");
    alert("DXF parse failed. Try exporting R12/ASCII DXF.");
    return;
  }

  const opts = readOpts();
  let segs = extractSegments(dxfParsed, opts.outPrec);
  if (!segs.length) {
    setStatus("bad", "No supported geometry", "Need LINE/POLYLINE/ARC/CIRCLE/SPLINE.");
    alert("No supported geometry found.\nNeeds LINE/LWPOLYLINE/POLYLINE/ARC/CIRCLE/SPLINE.\nTry exporting as R12/ASCII DXF.");
    return;
  }

  // Apply origin shift to BASE geometry
  baseGeomSegs = applyOriginShift(segs, opts.origin);

  // Apply current transform
  applyTransform(true);

  enableAfterImport(true);

  // Fit view ONCE on first import if user hasn't touched view
  if (!userTouchedView) fitViewOnce(geomSegs);
  else lockView();

  renderNC();
  draw();
  updatePartAndFitReadout();
  setStatus("ok", "Loaded", `Geometry ready. Scale=${Math.round(currentScale * 100)}% • Rotate=${Math.round(currentRotDeg)}°`);
});

// Build toolpath
$("buildToolpath").addEventListener("click", () => {
  if (!dxfParsed || !baseGeomSegs.length) { alert("Import a DXF first."); return; }

  try {
    setPlaying(false);
    setStatus("warn", "Building…", "Chaining + tool-down + DAT");
    if (!viewLocked) lockView(); // freeze the view so build never jumps

    const opts = readOpts();

    // Re-extract using current trace precision, then re-apply origin, then re-apply transform
    let segs = extractSegments(dxfParsed, opts.outPrec);
    baseGeomSegs = applyOriginShift(segs, opts.origin);

    readTransformFromUI();
    geomSegs = transformSegs(baseGeomSegs, currentScale, currentRotDeg);

    let paths = buildPaths(geomSegs, opts);
    paths = orderNearest(paths);
    paths = mergeContinuous(paths, opts.chainTol);

    if (!paths.length) {
      setStatus("bad", "Build produced 0 paths", "Try increasing tolerances in Options.");
      alert("Build produced 0 paths.\nTry Options:\n- Trace precision 0.02\n- Snap grid 0.02–0.05\n- Chain tol 0.03");
      resetBuildSummary();
      return;
    }

    const prog = buildProgram(paths, opts);
    ncLines = prog.ncLines;
    ncText = prog.ncText;
    toolSegs = prog.toolSegs;

    // Overtravel marking + warning
    const over = checkOvertravelAndMark(toolSegs);

    // Update build summary pills
    updateBuildSummaryFromBuild(opts, toolSegs, over);

    // reveal behavior
    revealSegCount = 0;
    currentNCLine = -1;
    shownNCMax = Math.min(ncLines.length - 1, 60);

    enableAfterBuild(true);

    renderNC();
    draw();
    updatePartAndFitReadout();

    if (over.isOver) {
      const msg =
        `⚠ Overtravel detected (machine ${MACHINE_X_TRAVEL}" X, ${MACHINE_Y_TRAVEL}" Y)\n` +
        `X: ${over.minX.toFixed(2)} → ${over.maxX.toFixed(2)} (limit 0–${MACHINE_X_TRAVEL})\n` +
        `Y: ${over.minY.toFixed(2)} → ${over.maxY.toFixed(2)} (limit 0–${MACHINE_Y_TRAVEL})`;

      setStatus("warn", "Built (Overtravel)", msg.replace(/\n/g, " • "));
      console.warn(msg);
    } else {
      setStatus("ok", "Built", `Segments: ${toolSegs.length} • Step with S`);
    }
  } catch (err) {
    console.error(err);
    setStatus("bad", "Build failed", err?.message || String(err));
    alert("Build failed.\nOpen console (F12) for details.");
    resetBuildSummary();
  }
});

// Export .dat
$("exportDat").addEventListener("click", () => {
  if (!ncText) return;

  let name = prompt("Save USB file as:", "output.dat");
  if (name === null) return;
  name = name.trim();
  if (!name) name = "output.dat";
  if (!name.toLowerCase().endsWith(".dat")) name += ".dat";

  const blob = new Blob([ncText], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);

  setStatus("ok", "Exported", name);
});

// ---------------- Init ----------------
function init() {
  setStatus("warn", "Idle", "Import a DXF to begin.");
  const r = canvas.getBoundingClientRect();
  view.ox = r.width / 2;
  view.oy = r.height / 2;
  lockView();
  resizeCanvasNoJump();
  renderNC();
  draw();
  resetBuildSummary();
  updatePartAndFitReadout();
}
init();
