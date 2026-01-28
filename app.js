// DXF → toolpath primitives → 2D verify sim → export output.dat (G20 inches)
//
// Supports DXF entities:
//  - LINE
//  - ARC
//  - CIRCLE
//  - LWPOLYLINE / POLYLINE with bulge arcs
//
// Output assumptions (generic CNC):
//  - G20 inches
//  - G90 absolute positioning for X/Y
//  - G2/G3 with I/J incremental center offsets (relative to arc start)
//  - G17 XY plane, G94 feed/min
//
// Scope:
//  - centerline toolpath only (no cutter comp, no offsets)
//  - no stock removal simulation (toolpath verify only)

const $ = (id) => document.getElementById(id);

const canvas = $("c");
const ctx = canvas.getContext("2d");

let dxfText = null;
let primitives = [];   // drawing + output: {type:'rapidLine'|'cutLine'|'cutArc'|'plunge'|'retract', ...}
let totalLen = 0;
let playing = false;
let lastDAT = "";

const state = {
  view: { scale: 1, ox: 0, oy: 0 },
  bounds: null, // {minX,maxX,minY,maxY}
};

function fmt(n) {
  const s = Number(n).toFixed(4);
  return s.replace(/\.?0+$/, "");
}

function clampAngle0_2pi(a) {
  let x = a % (Math.PI * 2);
  if (x < 0) x += Math.PI * 2;
  return x;
}

function angleInSweep(a, start, end, ccw) {
  // All angles in [0,2pi)
  a = clampAngle0_2pi(a);
  start = clampAngle0_2pi(start);
  end = clampAngle0_2pi(end);

  if (ccw) {
    if (start <= end) return a >= start && a <= end;
    return a >= start || a <= end;
  } else {
    // CW sweep from start down to end
    if (end <= start) return a <= start && a >= end;
    return a <= start || a >= end;
  }
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}
window.addEventListener("resize", resizeCanvas);

$("file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  dxfText = await file.text();
  setStatus(`Loaded DXF: ${file.name}`);
});

$("build").addEventListener("click", () => {
  if (!dxfText) return alert("Choose a DXF first.");

  const opts = readOpts();

  let dxf;
  try {
    const parser = new window.DxfParser();
    dxf = parser.parseSync(dxfText);
  } catch (err) {
    console.error(err);
    return alert("DXF parse failed. Try exporting as R12 / ASCII DXF.");
  }

  // Extract geometry primitives (lines + arcs) from DXF
  let geo = extractGeometry(dxf);
  if (!geo.length) return alert("No supported geometry found in DXF.");

  // Optional centering at (0,0)
  if (opts.centerXY) {
    const b = boundsOfGeometry(geo);
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    geo = geo.map(g => shiftGeometry(g, -cx, -cy));
  }

  // Build toolpath primitives (naive: each entity is cut as its own move)
  primitives = buildToolpathPrimitives(geo, opts);

  // Bounds for view (include arcs properly)
  state.bounds = boundsOfGeometry(geo);
  fitToView(state.bounds);

  // Build DAT output
  lastDAT = buildDAT(primitives, opts);

  // UI enable
  $("download").disabled = false;
  $("play").disabled = false;
  $("pause").disabled = false;
  $("scrub").disabled = false;
  $("scrub").value = "0";
  playing = false;

  $("stats").textContent = `Primitives: ${primitives.length} | Length: ${fmt(totalLen)}`;
  setStatus("Built toolpath + sim ready.");
  draw();
});

$("download").addEventListener("click", () => {
  if (!lastDAT) return;
  downloadText(lastDAT, "output.dat");
});

$("play").addEventListener("click", () => { playing = true; });
$("pause").addEventListener("click", () => { playing = false; });

$("scrub").addEventListener("input", () => {
  playing = false;
  draw();
});

function readOpts() {
  return {
    // Hard requirement: inches + generic CNC
    units: "G20",
    safeZ: Number($("safeZ").value),
    cutZ: Number($("cutZ").value),
    feedXY: Number($("feedXY").value),
    feedZ: Number($("feedZ").value),
    toolComment: $("toolComment").value || "(T1 - 1/4 endmill, centerline, no comp)",
    centerXY: $("centerXY").checked
  };
}

function setStatus(s) { $("status").textContent = `Status: ${s}`; }

function downloadText(text, filename) {
  const blob = new Blob([text], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------- DXF → Geometry ----------------

/**
 * Geometry primitive formats:
 *  - { kind:'line', x1,y1,x2,y2 }
 *  - { kind:'arc', cx,cy,r, a1,a2, ccw } where a1,a2 in radians
 */
function extractGeometry(dxf) {
  const out = [];
  for (const e of dxf.entities || []) {
    if (e.type === "LINE") {
      out.push({ kind: "line", x1: e.start.x, y1: e.start.y, x2: e.end.x, y2: e.end.y });
      continue;
    }

    if (e.type === "ARC") {
      // dxf-parser ARC: center, radius, startAngle, endAngle (degrees)
      const cx = e.center.x, cy = e.center.y, r = e.radius;
      const a1 = degToRad(e.startAngle);
      const a2 = degToRad(e.endAngle);
      // In DXF, arcs are CCW from startAngle to endAngle
      out.push({ kind: "arc", cx, cy, r, a1, a2, ccw: true });
      continue;
    }

    if (e.type === "CIRCLE") {
      const cx = e.center.x, cy = e.center.y, r = e.radius;
      // Represent full circle as two CCW half arcs
      out.push({ kind: "arc", cx, cy, r, a1: 0, a2: Math.PI, ccw: true });
      out.push({ kind: "arc", cx, cy, r, a1: Math.PI, a2: Math.PI * 2, ccw: true });
      continue;
    }

    if (e.type === "LWPOLYLINE" || e.type === "POLYLINE") {
      const verts = (e.vertices || []).map(v => ({ x: v.x, y: v.y, bulge: v.bulge || 0 }));
      if (verts.length < 2) continue;

      for (let i = 0; i < verts.length - 1; i++) {
        const a = verts[i], b = verts[i + 1];
        if (Math.abs(a.bulge) > 1e-12) {
          out.push(...bulgeToArcPrims(a.x, a.y, b.x, b.y, a.bulge));
        } else {
          out.push({ kind: "line", x1: a.x, y1: a.y, x2: b.x, y2: b.y });
        }
      }

      if (e.closed) {
        const a = verts[verts.length - 1], b = verts[0];
        if (Math.abs(a.bulge) > 1e-12) {
          out.push(...bulgeToArcPrims(a.x, a.y, b.x, b.y, a.bulge));
        } else {
          out.push({ kind: "line", x1: a.x, y1: a.y, x2: b.x, y2: b.y });
        }
      }
    }
  }
  return out;
}

function degToRad(d) { return (d * Math.PI) / 180; }

function shiftGeometry(g, dx, dy) {
  if (g.kind === "line") {
    return { ...g, x1: g.x1 + dx, y1: g.y1 + dy, x2: g.x2 + dx, y2: g.y2 + dy };
  }
  if (g.kind === "arc") {
    return { ...g, cx: g.cx + dx, cy: g.cy + dy };
  }
  return g;
}

// Convert polyline "bulge" segment to arc primitive(s)
// Bulge = tan(includedAngle/4), sign indicates direction (positive = CCW)
function bulgeToArcPrims(x1, y1, x2, y2, bulge) {
  // Reference: standard DXF bulge geometry
  const dx = x2 - x1, dy = y2 - y1;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12) return [];

  const theta = 4 * Math.atan(bulge);         // included angle (signed)
  const ccw = theta > 0;
  const absTheta = Math.abs(theta);

  // Radius
  const r = chord / (2 * Math.sin(absTheta / 2));

  // Midpoint of chord
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;

  // Distance from midpoint to center along normal
  const h = Math.sqrt(Math.max(0, r * r - (chord * chord) / 4));

  // Unit normal to chord (left normal)
  const ux = dx / chord;
  const uy = dy / chord;
  const nx = -uy;
  const ny = ux;

  // Choose center side based on sign of bulge (CCW uses left side)
  const sign = ccw ? 1 : -1;
  const cx = mx + sign * h * nx;
  const cy = my + sign * h * ny;

  // Start/end angles
  const a1 = Math.atan2(y1 - cy, x1 - cx);
  const a2 = Math.atan2(y2 - cy, x2 - cx);

  return [{ kind: "arc", cx, cy, r, a1, a2, ccw }];
}

// ---------------- Bounds (so we don't "miss" arc extents) ----------------

function boundsOfGeometry(geo) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const g of geo) {
    if (g.kind === "line") {
      minX = Math.min(minX, g.x1, g.x2);
      minY = Math.min(minY, g.y1, g.y2);
      maxX = Math.max(maxX, g.x1, g.x2);
      maxY = Math.max(maxY, g.y1, g.y2);
    } else if (g.kind === "arc") {
      // Include endpoints
      const p1 = { x: g.cx + g.r * Math.cos(g.a1), y: g.cy + g.r * Math.sin(g.a1) };
      const p2 = { x: g.cx + g.r * Math.cos(g.a2), y: g.cy + g.r * Math.sin(g.a2) };
      minX = Math.min(minX, p1.x, p2.x);
      minY = Math.min(minY, p1.y, p2.y);
      maxX = Math.max(maxX, p1.x, p2.x);
      maxY = Math.max(maxY, p1.y, p2.y);

      // Include quadrant extrema if within sweep
      const quad = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
      for (const a of quad) {
        if (angleInSweep(a, g.a1, g.a2, g.ccw)) {
          const ex = g.cx + g.r * Math.cos(a);
          const ey = g.cy + g.r * Math.sin(a);
          minX = Math.min(minX, ex);
          minY = Math.min(minY, ey);
          maxX = Math.max(maxX, ex);
          maxY = Math.max(maxY, ey);
        }
      }
    }
  }

  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}

// ---------------- Toolpath build ----------------

/**
 * Toolpath primitives:
 *  - { type:'rapidLine', x1,y1, x2,y2 }
 *  - { type:'cutLine', x1,y1, x2,y2 }
 *  - { type:'cutArc', sx,sy, ex,ey, cx,cy, r, ccw } (XY plane)
 *  - { type:'plunge', z, feed }
 *  - { type:'retract', z }
 */
function buildToolpathPrimitives(geo, opts) {
  const out = [];
  totalLen = 0;

  let curX = 0, curY = 0, curZ = opts.safeZ;

  // Start with retract to safe
  out.push({ type: "retract", z: opts.safeZ });
  curZ = opts.safeZ;

  for (const g of geo) {
    if (g.kind === "line") {
      const sx = g.x1, sy = g.y1, ex = g.x2, ey = g.y2;

      // Rapid to start at safeZ
      out.push({ type: "rapidLine", x1: curX, y1: curY, x2: sx, y2: sy });
      curX = sx; curY = sy;

      // Plunge
      out.push({ type: "plunge", z: opts.cutZ, feed: opts.feedZ });
      curZ = opts.cutZ;

      // Cut
      out.push({ type: "cutLine", x1: sx, y1: sy, x2: ex, y2: ey });
      totalLen += Math.hypot(ex - sx, ey - sy);
      curX = ex; curY = ey;

      // Retract
      out.push({ type: "retract", z: opts.safeZ });
      curZ = opts.safeZ;

    } else if (g.kind === "arc") {
      const sx = g.cx + g.r * Math.cos(g.a1);
      const sy = g.cy + g.r * Math.sin(g.a1);
      const ex = g.cx + g.r * Math.cos(g.a2);
      const ey = g.cy + g.r * Math.sin(g.a2);

      // Rapid to start
      out.push({ type: "rapidLine", x1: curX, y1: curY, x2: sx, y2: sy });
      curX = sx; curY = sy;

      // Plunge
      out.push({ type: "plunge", z: opts.cutZ, feed: opts.feedZ });
      curZ = opts.cutZ;

      // Cut arc
      out.push({ type: "cutArc", sx, sy, ex, ey, cx: g.cx, cy: g.cy, r: g.r, ccw: g.ccw });

      // Arc length
      const sweep = arcSweepRad(g.a1, g.a2, g.ccw);
      totalLen += Math.abs(sweep) * g.r;

      curX = ex; curY = ey;

      // Retract
      out.push({ type: "retract", z: opts.safeZ });
      curZ = opts.safeZ;
    }
  }

  return out;
}

function arcSweepRad(a1, a2, ccw) {
  a1 = clampAngle0_2pi(a1);
  a2 = clampAngle0_2pi(a2);
  if (ccw) {
    let d = a2 - a1;
    if (d < 0) d += Math.PI * 2;
    return d;
  } else {
    let d = a1 - a2;
    if (d < 0) d += Math.PI * 2;
    return d;
  }
}

// ---------------- DAT (G-code) output ----------------

function buildDAT(prims, opts) {
  const g = [];
  g.push("%");
  g.push("(Generated by DXF→DAT Toolpath V1)");
  g.push(opts.toolComment);
  g.push("G90 (absolute)");
  g.push("G94 (feed/min)");
  g.push("G17 (XY plane)");
  g.push("G20 (inches)");
  g.push(`G0 Z${fmt(opts.safeZ)}`);

  let curX = 0, curY = 0;
  let curZ = opts.safeZ;

  for (const p of prims) {
    if (p.type === "rapidLine") {
      // Only output endpoint (typical)
      g.push(`G0 X${fmt(p.x2)} Y${fmt(p.y2)}`);
      curX = p.x2; curY = p.y2;
    } else if (p.type === "plunge") {
      g.push(`G1 Z${fmt(p.z)} F${fmt(p.feed ?? opts.feedZ)}`);
      curZ = p.z;
    } else if (p.type === "cutLine") {
      g.push(`G1 X${fmt(p.x2)} Y${fmt(p.y2)} F${fmt(opts.feedXY)}`);
      curX = p.x2; curY = p.y2;
    } else if (p.type === "cutArc") {
      // I/J incremental from arc start (curX/curY should be at start here)
      const i = p.cx - p.sx;
      const j = p.cy - p.sy;
      const code = p.ccw ? "G3" : "G2";
      g.push(`${code} X${fmt(p.ex)} Y${fmt(p.ey)} I${fmt(i)} J${fmt(j)} F${fmt(opts.feedXY)}`);
      curX = p.ex; curY = p.ey;
    } else if (p.type === "retract") {
      g.push(`G0 Z${fmt(p.z)}`);
      curZ = p.z;
    }
  }

  g.push("M30");
  g.push("%");
  return g.join("\n");
}

// ---------------- Simulation drawing ----------------

function fitToView(bounds) {
  const pad = 24; // px
  const rect = canvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;

  const bw = (bounds.maxX - bounds.minX) || 1;
  const bh = (bounds.maxY - bounds.minY) || 1;

  const sx = (w - pad * 2) / bw;
  const sy = (h - pad * 2) / bh;
  const scale = Math.min(sx, sy);

  state.view.scale = scale;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;

  state.view.ox = w / 2 - cx * scale;
  state.view.oy = h / 2 + cy * scale; // note: screen Y points down; we flip in worldToScreen
}

function worldToScreen(x, y) {
  const s = state.view.scale;
  const ox = state.view.ox;
  const oy = state.view.oy;
  return { x: x * s + ox, y: -y * s + oy };
}

function clear() {
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
}

function drawGrid() {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;

  const step = 50;
  for (let x = 0; x <= w; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = 0; y <= h; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  // Crosshair at (0,0)
  const o = worldToScreen(0, 0);
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.beginPath(); ctx.moveTo(o.x - 12, o.y); ctx.lineTo(o.x + 12, o.y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(o.x, o.y - 12); ctx.lineTo(o.x, o.y + 12); ctx.stroke();

  ctx.restore();
}

function drawPrimitives() {
  ctx.save();
  ctx.lineWidth = 2;

  // Rap
  ctx.strokeStyle = "rgba(120,170,255,0.65)";
  ctx.setLineDash([6, 6]);
  for (const p of primitives) {
    if (p.type !== "rapidLine") continue;
    const a = worldToScreen(p.x1, p.y1);
    const b = worldToScreen(p.x2, p.y2);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // Cut lines
  ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(255,120,120,0.85)";
  for (const p of primitives) {
    if (p.type !== "cutLine") continue;
    const a = worldToScreen(p.x1, p.y1);
    const b = worldToScreen(p.x2, p.y2);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // Cut arcs
  for (const p of primitives) {
    if (p.type !== "cutArc") continue;

    // Convert world arc to screen arc.
    // Screen Y is flipped, so the sweep direction flips too.
    const c = worldToScreen(p.cx, p.cy);
    const s = state.view.scale;
    const r = p.r * s;

    const a1 = Math.atan2((-(p.sy - p.cy)), (p.sx - p.cx)); // careful with flip
    const a2 = Math.atan2((-(p.ey - p.cy)), (p.ex - p.cx));

    // When Y is flipped, CCW becomes CW in screen space.
    const anticlockwise = p.ccw ? true : false;
    // But because we flipped Y, we invert anticlockwise flag:
    const screenACW = !anticlockwise;

    ctx.beginPath();
    ctx.arc(c.x, c.y, Math.abs(r), a1, a2, screenACW);
    ctx.stroke();
  }

  ctx.restore();
}

// Playback: compute a point along the path by distance (rapids + cuts) including arcs
function buildPlaybackSegments() {
  const segs = [];
  for (const p of primitives) {
    if (p.type === "rapidLine") {
      const len = Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
      segs.push({ kind: "line", mode: "RAPID", x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, len });
    } else if (p.type === "cutLine") {
      const len = Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
      segs.push({ kind: "line", mode: "CUT", x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, len });
    } else if (p.type === "cutArc") {
      // Arc sweep from start->end about center
      const a1 = Math.atan2(p.sy - p.cy, p.sx - p.cx);
      const a2 = Math.atan2(p.ey - p.cy, p.ex - p.cx);
      const sweep = arcSweepRad(a1, a2, p.ccw);
      const len = Math.abs(sweep) * p.r;
      segs.push({ kind: "arc", mode: "CUT", cx: p.cx, cy: p.cy, r: p.r, a1, a2, ccw: p.ccw, len });
    }
  }
  return segs;
}

function pointAtT(t01) {
  const segs = buildPlaybackSegments();
  if (!segs.length) return null;

  const sum = segs.reduce((acc, s) => acc + s.len, 0) || 1;
  const target = t01 * sum;

  let acc = 0;
  for (const s of segs) {
    if (acc + s.len >= target) {
      const u = s.len === 0 ? 0 : (target - acc) / s.len;

      if (s.kind === "line") {
        const x = s.x1 + (s.x2 - s.x1) * u;
        const y = s.y1 + (s.y2 - s.y1) * u;
        return { x, y, mode: s.mode };
      } else {
        // Arc interpolation by angle
        const sweep = arcSweepRad(s.a1, s.a2, s.ccw);
        const ang = s.ccw ? (s.a1 + sweep * u) : (s.a1 - sweep * u);
        const x = s.cx + s.r * Math.cos(ang);
        const y = s.cy + s.r * Math.sin(ang);
        return { x, y, mode: s.mode };
      }
    }
    acc += s.len;
  }

  const last = segs[segs.length - 1];
  if (last.kind === "line") return { x: last.x2, y: last.y2, mode: last.mode };
  return { x: last.cx + last.r * Math.cos(last.a2), y: last.cy + last.r * Math.sin(last.a2), mode: last.mode };
}

function drawTool(t01) {
  const p = pointAtT(t01);
  if (!p) return;

  const sp = worldToScreen(p.x, p.y);
  ctx.save();
  ctx.fillStyle = p.mode === "CUT" ? "rgba(255,120,120,0.95)" : "rgba(120,170,255,0.95)";
  ctx.beginPath();
  ctx.arc(sp.x, sp.y, 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(sp.x, sp.y, 14, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  $("hudPos").textContent = `XY: ${fmt(p.x)} ${fmt(p.y)}  (in)`;
  $("hudMode").textContent = `Mode: ${p.mode}`;
}

function draw() {
  clear();
  drawGrid();
  drawPrimitives();
  const t = Number($("scrub").value);
  drawTool(t);
}

function tick() {
  if (playing) {
    const scrub = $("scrub");
    let v = Number(scrub.value);
    v += 0.003; // UI speed (not feed-accurate)
    if (v >= 1) { v = 1; playing = false; }
    scrub.value = String(v);
    draw();
  }
  requestAnimationFrame(tick);
}

// Boot
resizeCanvas();
tick();
