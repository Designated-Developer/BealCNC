// DXF → DAT (G20 inches) + simulation
// Key point: keep the UI + sim, but fix tolerance via Traced Art Mode.
//
// Modes:
// - Normal: endpoint chaining + arcs + polylines
// - Traced Art (±0.10"): snap-to-grid + direction-based chaining (lines) + aggressive collinear merge
//
// Output: one plunge per PATH (not per segment). CutZ forced negative.

const $ = (id) => document.getElementById(id);
const canvas = $("c");
const ctx = canvas.getContext("2d");

let dxfText = null;
let moves = [];
let playSegs = [];
let lastDAT = "";
let playing = false;

const view = { scale: 1, ox: 0, oy: 0, dragging: false, lastX: 0, lastY: 0 };

function readOpts() {
  const safeZ = Number($("safeZ").value);
  const cutZ = -Math.abs(Number($("cutZ").value || 0)); // FORCE negative
  return {
    centerXY: $("centerXY").checked,
    tracedMode: $("tracedMode").checked,
    hideRapids: $("hideRapids").checked,
    safeZ: safeZ,
    cutZ: cutZ,
    feedXY: Number($("feedXY").value),
    feedZ: Number($("feedZ").value),
    chainTol: Math.max(0, Number($("chainTol").value) || 0.003),
    outPrec: Number($("outPrec").value || 0.001),
    snapGrid: Math.max(0.001, Number($("snapGrid").value) || 0.02),
    angleTolDeg: Math.max(1, Number($("angleTolDeg").value) || 12),
    toolComment: $("toolComment").value || "(T1 - 1/4 endmill, centerline, no comp)"
  };
}

function setStatus(s) { $("status").textContent = `Status: ${s}`; }
function fmtWithStep(n, step) {
  // quantize to the selected output precision
  const q = Math.round(n / step) * step;
  let dec = 0;
  if (step >= 1) dec = 0;
  else dec = Math.max(0, Math.ceil(-Math.log10(step)));
  const s = q.toFixed(dec);
  return s.replace(/\.?0+$/, "");
}
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function degToRad(d) { return d * Math.PI / 180; }

// ---------- Geometry helpers ----------
function samePt(a, b, tol) {
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
}
function collinear(a, b, c, eps) {
  return Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) <= eps;
}
function angle(a, b) {
  return Math.atan2(b.y - a.y, b.x - a.x);
}
function snapPoint(p, grid) {
  return { x: Math.round(p.x / grid) * grid, y: Math.round(p.y / grid) * grid };
}

// ---------- DXF extraction ----------
/*
seg:
 line: {kind:'line', a:{x,y}, b:{x,y}}
 arc : {kind:'arc',  a:{x,y}, b:{x,y}, c:{x,y}, r, ccw, a1, a2}
*/
function extractSegments(dxf) {
  const out = [];
  for (const e of dxf.entities || []) {
    if (e.type === "LINE") {
      out.push({ kind:"line", a:{x:e.start.x, y:e.start.y}, b:{x:e.end.x, y:e.end.y} });
      continue;
    }
    if (e.type === "ARC") {
      const cx = e.center.x, cy = e.center.y, r = e.radius;
      const a1 = degToRad(e.startAngle);
      const a2 = degToRad(e.endAngle);
      const a = { x: cx + r * Math.cos(a1), y: cy + r * Math.sin(a1) };
      const b = { x: cx + r * Math.cos(a2), y: cy + r * Math.sin(a2) };
      out.push({ kind:"arc", a, b, c:{x:cx,y:cy}, r, ccw:true, a1, a2 });
      continue;
    }
    if (e.type === "CIRCLE") {
      const cx = e.center.x, cy = e.center.y, r = e.radius;
      const a = { x: cx + r, y: cy };
      const m = { x: cx - r, y: cy };
      out.push({ kind:"arc", a, b:m, c:{x:cx,y:cy}, r, ccw:true, a1:0, a2:Math.PI });
      out.push({ kind:"arc", a:m, b:a, c:{x:cx,y:cy}, r, ccw:true, a1:Math.PI, a2:Math.PI*2 });
      continue;
    }
    if (e.type === "LWPOLYLINE" || e.type === "POLYLINE") {
      const verts = (e.vertices || []).map(v => ({ x:v.x, y:v.y, bulge:v.bulge || 0 }));
      if (verts.length < 2) continue;

      for (let i=0;i<verts.length-1;i++){
        const p=verts[i], q=verts[i+1];
        if (Math.abs(p.bulge) > 1e-12) out.push(bulgeToArcSeg(p, q, p.bulge));
        else out.push({ kind:"line", a:{x:p.x,y:p.y}, b:{x:q.x,y:q.y} });
      }
      if (e.closed) {
        const p=verts[verts.length-1], q=verts[0];
        if (Math.abs(p.bulge) > 1e-12) out.push(bulgeToArcSeg(p, q, p.bulge));
        else out.push({ kind:"line", a:{x:p.x,y:p.y}, b:{x:q.x,y:q.y} });
      }
    }
  }
  return out;
}

function bulgeToArcSeg(p, q, bulge) {
  const x1=p.x,y1=p.y,x2=q.x,y2=q.y;
  const dx=x2-x1, dy=y2-y1;
  const chord=Math.hypot(dx,dy);
  if (chord < 1e-12) return { kind:"line", a:{x:x1,y:y1}, b:{x:x2,y:y2} };

  const theta = 4 * Math.atan(bulge);
  const ccw = theta > 0;
  const absTheta = Math.abs(theta);

  const r = chord / (2 * Math.sin(absTheta/2));
  const mx=(x1+x2)/2, my=(y1+y2)/2;
  const h = Math.sqrt(Math.max(0, r*r - (chord*chord)/4));

  const ux=dx/chord, uy=dy/chord;
  const nx=-uy, ny=ux;
  const sign = ccw ? 1 : -1;
  const cx = mx + sign*h*nx;
  const cy = my + sign*h*ny;

  const a1 = Math.atan2(y1-cy, x1-cx);
  const a2 = Math.atan2(y2-cy, x2-cx);

  return { kind:"arc", a:{x:x1,y:y1}, b:{x:x2,y:y2}, c:{x:cx,y:cy}, r, ccw, a1, a2 };
}

// ---------- Centering ----------
function boundsOfSegments(segs) {
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for (const s of segs) {
    minX=Math.min(minX,s.a.x,s.b.x);
    minY=Math.min(minY,s.a.y,s.b.y);
    maxX=Math.max(maxX,s.a.x,s.b.x);
    maxY=Math.max(maxY,s.a.y,s.b.y);
  }
  if (!isFinite(minX)) return {minX:0,minY:0,maxX:1,maxY:1};
  return {minX,minY,maxX,maxY};
}
function shiftSeg(s, dx, dy) {
  if (s.kind==="line") return { ...s, a:{x:s.a.x+dx,y:s.a.y+dy}, b:{x:s.b.x+dx,y:s.b.y+dy} };
  return { ...s, a:{x:s.a.x+dx,y:s.a.y+dy}, b:{x:s.b.x+dx,y:s.b.y+dy}, c:{x:s.c.x+dx,y:s.c.y+dy} };
}

// ---------- Segment cleanup ----------
function reverseSeg(s) {
  if (s.kind==="line") return { ...s, a:s.b, b:s.a };
  return { ...s, a:s.b, b:s.a, ccw:!s.ccw, a1:s.a2, a2:s.a1 };
}

function mergeCollinearAndDedupPath(pathSegs, tol) {
  if (pathSegs.length < 2) return pathSegs.slice();

  const eps = Math.max(1e-12, tol * tol);
  const out = [];
  let i = 0;

  while (i < pathSegs.length) {
    const s = pathSegs[i];

    if (s.kind !== "line") { out.push(s); i++; continue; }

    let a = s.a;
    let b = s.b;
    if (samePt(a, b, tol)) { i++; continue; }

    let j = i + 1;
    while (j < pathSegs.length) {
      const n = pathSegs[j];
      if (n.kind !== "line") break;
      if (!samePt(b, n.a, tol)) break;
      if (samePt(n.a, n.b, tol)) { j++; continue; }
      if (!collinear(a, b, n.b, eps)) break;
      b = n.b;
      j++;
    }

    out.push({ kind:"line", a, b });
    i = j;
  }

  return out;
}

// ---------- Chaining (Normal mode: endpoint-based) ----------
function keyPt(p, tol) {
  const qx = Math.round(p.x / tol);
  const qy = Math.round(p.y / tol);
  return `${qx},${qy}`;
}

function chainSegmentsIntoPaths(segs, tol) {
  const startMap=new Map();
  const endMap=new Map();
  for (let i=0;i<segs.length;i++){
    const s=segs[i];
    const ks=keyPt(s.a,tol);
    const ke=keyPt(s.b,tol);
    if(!startMap.has(ks)) startMap.set(ks,[]);
    if(!endMap.has(ke)) endMap.set(ke,[]);
    startMap.get(ks).push(i);
    endMap.get(ke).push(i);
  }

  const used=new Array(segs.length).fill(false);
  const paths=[];

  function findNext(pt) {
    const k=keyPt(pt,tol);

    const c1=startMap.get(k)||[];
    for (const idx of c1) {
      if (used[idx]) continue;
      if (dist(segs[idx].a, pt) <= tol) return { idx, seg: segs[idx] };
    }

    const c2=endMap.get(k)||[];
    for (const idx of c2) {
      if (used[idx]) continue;
      if (dist(segs[idx].b, pt) <= tol) return { idx, seg: reverseSeg(segs[idx]) };
    }

    return null;
  }

  for (let i=0;i<segs.length;i++){
    if (used[i]) continue;
    used[i]=true;
    const chain=[segs[i]];

    // forward
    let end=chain[chain.length-1].b;
    while(true){
      const nxt=findNext(end);
      if(!nxt) break;
      used[nxt.idx]=true;
      chain.push(nxt.seg);
      end=nxt.seg.b;
    }

    // backward
    let start=chain[0].a;
    while(true){
      const nxt=findNext(start);
      if(!nxt) break;
      used[nxt.idx]=true;
      chain.unshift(reverseSeg(nxt.seg));
      start=chain[0].a;
    }

    paths.push({ segments: chain });
  }

  return paths;
}

// ---------- Traced Mode chaining (direction-based for LINE soup) ----------
function rebuildTracedLinesIntoPaths(segs, snapGrid, angleTolDeg) {
  const lines = segs
    .filter(s => s.kind === "line")
    .map(s => ({ kind:"line", a: snapPoint(s.a, snapGrid), b: snapPoint(s.b, snapGrid) }))
    .filter(s => !(Math.abs(s.a.x-s.b.x) < 1e-12 && Math.abs(s.a.y-s.b.y) < 1e-12));

  // Build adjacency by snapped start point
  const map = new Map();
  const tol = snapGrid * 0.51;

  function k(p){ return `${Math.round(p.x/snapGrid)},${Math.round(p.y/snapGrid)}`; }
  for (let i=0;i<lines.length;i++){
    const ks = k(lines[i].a);
    if(!map.has(ks)) map.set(ks,[]);
    map.get(ks).push(i);
  }

  const used = new Array(lines.length).fill(false);
  const paths = [];
  const angTol = degToRad(angleTolDeg);

  for (let i=0;i<lines.length;i++){
    if (used[i]) continue;
    used[i] = true;

    const chain = [lines[i]];
    let cur = lines[i];

    while(true){
      const end = cur.b;
      const candidates = map.get(k(end)) || [];
      const d0 = angle(cur.a, cur.b);

      let best = -1;
      let bestScore = Infinity;

      for (const idx of candidates) {
        if (used[idx]) continue;
        const s = lines[idx];
        if (!samePt(end, s.a, tol)) continue;

        const d1 = angle(s.a, s.b);
        let da = Math.abs(d1 - d0);
        da = Math.min(da, Math.abs(da - Math.PI*2));

        if (da <= angTol && da < bestScore) {
          best = idx;
          bestScore = da;
        }
      }

      if (best === -1) break;
      used[best] = true;
      chain.push(lines[best]);
      cur = lines[best];
    }

    paths.push({ segments: mergeCollinearAndDedupPath(chain, snapGrid) });
  }

  return paths;
}

// ---------- Build moves (ONE plunge per path) ----------
function buildMoves(paths, opts) {
  const m = [];
  // start at safeZ once
  m.push({type:"retract", z:opts.safeZ});

  let cur = {x:0, y:0};

  for (const p of paths) {
    if (!p.segments || p.segments.length === 0) continue;

    const start = p.segments[0].a;

    // rapid to start if needed
    if (dist(cur, start) > 1e-12) m.push({type:"rapidXY", x:start.x, y:start.y});
    cur = {x:start.x, y:start.y};

    // plunge once
    m.push({type:"plunge", z:opts.cutZ, f:opts.feedZ});
    m.push({type:"feedXY", f:opts.feedXY});

    for (const s of p.segments) {
      if (s.kind === "line") {
        m.push({type:"cutLine", x:s.b.x, y:s.b.y});
        cur = {x:s.b.x, y:s.b.y};
      } else {
        // arcs only in normal mode (traced mode outputs lines)
        const i = s.c.x - s.a.x;
        const j = s.c.y - s.a.y;
        m.push({type:"cutArc", x:s.b.x, y:s.b.y, i, j, ccw:s.ccw});
        cur = {x:s.b.x, y:s.b.y};
      }
    }

    // retract once
    m.push({type:"retract", z:opts.safeZ});
  }

  return m;
}

// ---------- DAT output ----------
function buildDAT(moves, opts) {
  const g = [];
  const P = opts.outPrec;

  g.push("%");
  g.push("(Generated by DXF→DAT Toolpath)");
  g.push(opts.toolComment);
  g.push("G90 (absolute)");
  g.push("G94 (feed/min)");
  g.push("G17 (XY plane)");
  g.push("G20 (inches)");

  let lastF = null;
  let atZ = null;
  let atXY = {x:null, y:null};

  function outZ(z) {
    const s = fmtWithStep(z, P);
    return `Z${s}`;
  }
  function outXY(x,y) {
    return `X${fmtWithStep(x,P)} Y${fmtWithStep(y,P)}`;
  }
  function outIJ(i,j) {
    return `I${fmtWithStep(i,P)} J${fmtWithStep(j,P)}`;
  }

  for (const m of moves) {
    if (m.type === "retract") {
      if (atZ !== m.z) {
        g.push(`G0 ${outZ(m.z)}`);
        atZ = m.z;
      }
      continue;
    }

    if (m.type === "rapidXY") {
      if (atXY.x !== m.x || atXY.y !== m.y) {
        g.push(`G0 ${outXY(m.x,m.y)}`);
        atXY = {x:m.x, y:m.y};
      }
      continue;
    }

    if (m.type === "plunge") {
      if (lastF !== m.f) {
        g.push(`G1 ${outZ(m.z)} F${fmtWithStep(m.f, 0.1)}`);
        lastF = m.f;
      } else {
        g.push(`G1 ${outZ(m.z)}`);
      }
      atZ = m.z;
      continue;
    }

    if (m.type === "feedXY") {
      if (lastF !== m.f) {
        g.push(`F${fmtWithStep(m.f, 0.1)}`);
        lastF = m.f;
      }
      continue;
    }

    if (m.type === "cutLine") {
      g.push(`G1 ${outXY(m.x,m.y)}`);
      atXY = {x:m.x, y:m.y};
      continue;
    }

    if (m.type === "cutArc") {
      const code = m.ccw ? "G3" : "G2";
      g.push(`${code} ${outXY(m.x,m.y)} ${outIJ(m.i,m.j)}`);
      atXY = {x:m.x, y:m.y};
      continue;
    }
  }

  g.push("M30");
  g.push("%");
  return g.join("\n");
}

// ---------- Playback segments for sim ----------
function buildPlayback(moves) {
  const segs = [];
  let cur = {x:0,y:0};
  let cum = 0;

  for (const m of moves) {
    if (m.type === "rapidXY") {
      const a={...cur}, b={x:m.x,y:m.y};
      const len=Math.hypot(b.x-a.x,b.y-a.y);
      cum += len;
      segs.push({kind:"line", mode:"RAPID", a, b, len, cum});
      cur = b;
    } else if (m.type === "cutLine") {
      const a={...cur}, b={x:m.x,y:m.y};
      const len=Math.hypot(b.x-a.x,b.y-a.y);
      cum += len;
      segs.push({kind:"line", mode:"CUT", a, b, len, cum});
      cur = b;
    } else if (m.type === "cutArc") {
      const a={...cur};
      const c={x:a.x+m.i, y:a.y+m.j};
      const b={x:m.x,y:m.y};
      const r=Math.hypot(a.x-c.x,a.y-c.y);
      const a1=Math.atan2(a.y-c.y,a.x-c.x);
      const a2=Math.atan2(b.y-c.y,b.x-c.x);

      // approximate length by chord for sim pacing (good enough)
      const chord = Math.hypot(b.x-a.x,b.y-a.y);
      const len = Math.max(1e-9, chord);
      cum += len;
      segs.push({kind:"arc", mode:"CUT", a, b, c, r, a1, a2, ccw:m.ccw, len, cum});
      cur = b;
    }
  }
  return segs;
}

function pointAtT(t01) {
  if (!playSegs.length) return null;
  const total = playSegs[playSegs.length-1].cum || 1;
  const target = t01 * total;

  let lo=0, hi=playSegs.length-1;
  while(lo<hi){
    const mid=(lo+hi)>>1;
    if (playSegs[mid].cum < target) lo=mid+1;
    else hi=mid;
  }

  const s = playSegs[lo];
  const prev = lo===0 ? 0 : playSegs[lo-1].cum;
  const u = s.len===0 ? 0 : (target - prev) / s.len;

  if (s.kind === "line") {
    return {
      x: s.a.x + (s.b.x - s.a.x)*u,
      y: s.a.y + (s.b.y - s.a.y)*u,
      mode: s.mode
    };
  } else {
    // simple angle lerp for display only
    const angA = Math.atan2(s.a.y - s.c.y, s.a.x - s.c.x);
    const angB = Math.atan2(s.b.y - s.c.y, s.b.x - s.c.x);
    const ang = angA + (angB - angA) * u;
    return { x: s.c.x + s.r*Math.cos(ang), y: s.c.y + s.r*Math.sin(ang), mode: s.mode };
  }
}

// ---------- Drawing / view ----------
function resizeCanvas() {
  const dpr=window.devicePixelRatio||1;
  const rect=canvas.getBoundingClientRect();
  canvas.width=Math.max(1,Math.floor(rect.width*dpr));
  canvas.height=Math.max(1,Math.floor(rect.height*dpr));
  ctx.setTransform(dpr,0,0,dpr,0,0);
  draw();
}
window.addEventListener("resize", resizeCanvas);

function worldToScreen(x,y){ return { x: x*view.scale + view.ox, y: -y*view.scale + view.oy }; }
function screenToWorld(x,y){ return { x: (x-view.ox)/view.scale, y: -(y-view.oy)/view.scale }; }

function fitToView(bounds){
  const rect=canvas.getBoundingClientRect();
  const w=rect.width,h=rect.height;
  const pad=30;
  const bw=(bounds.maxX-bounds.minX)||1;
  const bh=(bounds.maxY-bounds.minY)||1;
  const sx=(w-pad*2)/bw;
  const sy=(h-pad*2)/bh;
  view.scale=Math.min(sx,sy);
  const cx=(bounds.minX+bounds.maxX)/2;
  const cy=(bounds.minY+bounds.maxY)/2;
  view.ox=w/2 - cx*view.scale;
  view.oy=h/2 + cy*view.scale;
}

function clear(){
  const rect=canvas.getBoundingClientRect();
  ctx.clearRect(0,0,rect.width,rect.height);
}
function drawGrid(){
  const rect=canvas.getBoundingClientRect();
  const w=rect.width,h=rect.height;
  ctx.save();
  ctx.strokeStyle="rgba(255,255,255,0.05)";
  ctx.lineWidth=1;
  const step=50;
  for(let x=0;x<=w;x+=step){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
  for(let y=0;y<=h;y+=step){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
  const o=worldToScreen(0,0);
  ctx.strokeStyle="rgba(255,255,255,0.18)";
  ctx.beginPath(); ctx.moveTo(o.x-12,o.y); ctx.lineTo(o.x+12,o.y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(o.x,o.y-12); ctx.lineTo(o.x,o.y+12); ctx.stroke();
  ctx.restore();
}

function drawToolpath(opts){
  if (!opts.hideRapids) {
    ctx.save();
    ctx.strokeStyle="rgba(120,170,255,0.65)";
    ctx.lineWidth=2;
    ctx.setLineDash([6,6]);
    for (const s of playSegs) {
      if (s.mode!=="RAPID") continue;
      const a=worldToScreen(s.a.x,s.a.y), b=worldToScreen(s.b.x,s.b.y);
      ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
    }
    ctx.restore();
  }

  ctx.save();
  ctx.strokeStyle="rgba(255,120,120,0.85)";
  ctx.lineWidth=2;
  ctx.setLineDash([]);
  for (const s of playSegs) {
    if (s.mode!=="CUT") continue;
    if (s.kind==="line") {
      const a=worldToScreen(s.a.x,s.a.y), b=worldToScreen(s.b.x,s.b.y);
      ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
    } else {
      const c=worldToScreen(s.c.x,s.c.y);
      const r=s.r*view.scale;
      const a1=Math.atan2(-(s.a.y-s.c.y),(s.a.x-s.c.x));
      const a2=Math.atan2(-(s.b.y-s.c.y),(s.b.x-s.c.x));
      const screenACW = !s.ccw;
      ctx.beginPath();
      ctx.arc(c.x,c.y,Math.abs(r),a1,a2,screenACW);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawTool(){
  const t=Number($("scrub").value);
  const p=pointAtT(t);
  if(!p) return;
  const sp=worldToScreen(p.x,p.y);

  ctx.save();
  ctx.fillStyle = p.mode==="CUT" ? "rgba(255,120,120,0.95)" : "rgba(120,170,255,0.95)";
  ctx.beginPath(); ctx.arc(sp.x,sp.y,6,0,Math.PI*2); ctx.fill();
  ctx.restore();

  $("hudPos").textContent = `XY: ${p.x.toFixed(3)} ${p.y.toFixed(3)} (in)`;
  $("hudMode").textContent = `Mode: ${p.mode}`;
}

function draw(){
  const opts=readOpts();
  clear();
  drawGrid();
  drawToolpath(opts);
  drawTool();
}

// ---------- Pan/Zoom ----------
canvas.addEventListener("mousedown",(e)=>{ view.dragging=true; view.lastX=e.clientX; view.lastY=e.clientY; });
window.addEventListener("mouseup",()=>{ view.dragging=false; });
window.addEventListener("mousemove",(e)=>{
  if(!view.dragging) return;
  view.ox += (e.clientX - view.lastX);
  view.oy += (e.clientY - view.lastY);
  view.lastX = e.clientX; view.lastY = e.clientY;
  draw();
});
canvas.addEventListener("wheel",(e)=>{
  e.preventDefault();
  const rect=canvas.getBoundingClientRect();
  const mx=e.clientX-rect.left, my=e.clientY-rect.top;

  const before=screenToWorld(mx,my);
  const zoom=Math.exp(-e.deltaY*0.001);
  view.scale*=zoom;
  const after=screenToWorld(mx,my);

  view.ox += (before.x - after.x)*view.scale;
  view.oy -= (before.y - after.y)*view.scale;
  draw();
},{passive:false});

// ---------- UI ----------
$("file").addEventListener("change", async (e)=>{
  const f=e.target.files?.[0];
  if(!f) return;
  dxfText=await f.text();
  setStatus(`Loaded DXF: ${f.name}`);
});

$("build").addEventListener("click", ()=>{
  if(!dxfText) return alert("Choose a DXF first.");

  const opts=readOpts();

  let dxf;
  try {
    const parser=new window.DxfParser();
    dxf=parser.parseSync(dxfText);
  } catch(err) {
    console.error(err);
    alert("DXF parse failed. Try exporting as R12 / ASCII DXF.");
    return;
  }

  let segs = extractSegments(dxf);
  if(!segs.length) return alert("No supported geometry found.");

  // center
  if (opts.centerXY) {
    const b=boundsOfSegments(segs);
    const cx=(b.minX+b.maxX)/2;
    const cy=(b.minY+b.maxY)/2;
    segs = segs.map(s=>shiftSeg(s,-cx,-cy));
  }

  // Build paths
  let paths = [];
  if (opts.tracedMode) {
    // traced mode: rebuild continuous paths from LINE soup
    paths = rebuildTracedLinesIntoPaths(segs, opts.snapGrid, opts.angleTolDeg);
    // traced mode outputs line-only paths by design
  } else {
    // normal mode: endpoint chaining and then cleanup (safe)
    paths = chainSegmentsIntoPaths(segs, opts.chainTol);
    for (const p of paths) p.segments = mergeCollinearAndDedupPath(p.segments, opts.chainTol);
  }

  // moves + output
  moves = buildMoves(paths, opts);
  lastDAT = buildDAT(moves, opts);
  playSegs = buildPlayback(moves);

  // fit view based on playback endpoints
  if (playSegs.length) {
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for (const s of playSegs) {
      minX=Math.min(minX,s.a.x,s.b.x);
      minY=Math.min(minY,s.a.y,s.b.y);
      maxX=Math.max(maxX,s.a.x,s.b.x);
      maxY=Math.max(maxY,s.a.y,s.b.y);
    }
    fitToView({minX,minY,maxX,maxY});
  }

  $("download").disabled=false;
  $("fit").disabled=false;
  $("play").disabled=false;
  $("pause").disabled=false;
  $("scrub").disabled=false;
  $("scrub").value="0";
  playing=false;

  const datLines = lastDAT.split("\n").length;
  const segCount = segs.length;
  $("stats").textContent = `Paths: ${paths.length} | Segments: ${segCount} | DAT lines: ${datLines}`;
  setStatus(opts.tracedMode ? "Built (Traced Art Mode)" : "Built (Normal Mode)");
  draw();
});

$("download").addEventListener("click", ()=>{
  if(!lastDAT) return;
  const blob = new Blob([lastDAT], { type:"text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "output.dat";
  a.click();
  URL.revokeObjectURL(a.href);
});

$("fit").addEventListener("click", ()=>{ draw(); });

$("hideRapids").addEventListener("change", ()=>draw());
$("tracedMode").addEventListener("change", ()=>draw());

$("play").addEventListener("click", ()=>{ playing=true; });
$("pause").addEventListener("click", ()=>{ playing=false; });
$("scrub").addEventListener("input", ()=>{ playing=false; draw(); });

function tick(){
  if(playing){
    const scrub=$("scrub");
    let v=Number(scrub.value);
    v += 0.003;
    if(v>=1){ v=1; playing=false; }
    scrub.value=String(v);
    draw();
  }
  requestAnimationFrame(tick);
}

// boot
resizeCanvas();
tick();
