// NorrisCAM — DXF → Toolpath → Step/Play reveal + USB .DAT (G-code)
//
// Fixes requested:
// 1) When user clicks Build Toolpath, code APPEARS immediately (no empty prompt).
// 2) Canvas view stays stable (no jumping/zooming away) during build + stepping.
// 3) Reveal behavior: initially show first chunk; stepping expands reveal as needed.
// 4) Highlight scrolls to TOP (smooth), line numbers shown, read-only, go-to-line works.

const $ = (id) => document.getElementById(id);
const canvas = $("c");
const ctx = canvas.getContext("2d");

// ---------- State ----------
let dxfParsed = null;

let previewSegs = [];   // model preview segments (cyan)
let playback = [];      // toolpath segments [{a,b,mode,ncLineIdx}]
let moves = [];
let ncLines = [];
let lastNC = "";

// Simulation state
let revealCount = 0;          // number of tool segments revealed
let currentLineIdx = -1;      // highlighted NC line index
let shownLineMax = -1;        // maximum NC line index currently visible
let playTimer = null;

// map: ncLineIdx -> last segment index with that ncLineIdx
let lineToLastSegIndex = new Map();

// view state (world->screen)
const view = { scale: 60, ox: 0, oy: 0, dragging: false, lx: 0, ly: 0 };
let viewTouched = false;

// View lock (prevents jumping after build)
let viewLocked = false;
let lockedView = { scale: view.scale, ox: view.ox, oy: view.oy };

// How many code lines to show immediately after Build
const INITIAL_CODE_LINES_AFTER_BUILD = 80;

// ---------- UI ----------
function setStatus(kind, title, detail){
  $("topStatus").textContent = title;
  $("stats").textContent = detail || "";
  const dot = $("statusDot");
  dot.classList.remove("good","warn","bad");
  if(kind==="good") dot.classList.add("good");
  else if(kind==="warn") dot.classList.add("warn");
  else if(kind==="bad") dot.classList.add("bad");
}

function readOpts(){
  const safeZ = Number($("safeZ").value || 0.5);
  const depth = Math.abs(Number($("cutZ").value || 0.0625));
  const stepDown = Math.max(0.001, Number($("stepDown").value || 0.0625));
  const outPrec = Math.max(0.0005, Number($("outPrec").value || 0.01));

  const rpm = Math.max(0, Math.floor(Number($("spindleRPM").value || 12000)));

  return {
    origin: $("origin").value,
    safeZ,
    totalDepth: -depth,
    stepDown,
    feedXY: Number($("feedXY").value || 30),
    feedZ: Number($("feedZ").value || 20),
    outPrec,
    snapGrid: Math.max(0.001, Number($("snapGrid").value || 0.02)),
    angleTolDeg: Math.max(1, Number($("angleTolDeg").value || 12)),
    chainTol: Math.max(0.0005, Number($("chainTol").value || 0.02)),
    toolComment: $("toolComment").value || "(T1 - 1/4 endmill, centerline, no comp)",
    spindleRPM: rpm
  };
}

function fmt(n, step){
  const q = Math.round(n/step)*step;
  let dec = 0;
  if(step < 1) dec = Math.max(0, Math.ceil(-Math.log10(step)));
  return q.toFixed(dec).replace(/\.?0+$/,"");
}

// ---------- Math / Geometry ----------
function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }
function samePt(a,b,t){ return Math.abs(a.x-b.x)<=t && Math.abs(a.y-b.y)<=t; }
function snapPoint(p,g){ return { x: Math.round(p.x/g)*g, y: Math.round(p.y/g)*g }; }
function angle(a,b){ return Math.atan2(b.y-a.y, b.x-a.x); }
function normAng(a){ while(a<-Math.PI) a+=2*Math.PI; while(a>Math.PI) a-=2*Math.PI; return a; }
function degToRad(d){ return d*Math.PI/180; }

function xyOf(pt){
  if(!pt) return null;
  if(Array.isArray(pt) && pt.length>=2) return { x:Number(pt[0]), y:Number(pt[1]) };
  if(typeof pt==="object"){
    if(isFinite(pt.x) && isFinite(pt.y)) return { x:Number(pt.x), y:Number(pt.y) };
    if(pt.point) return xyOf(pt.point);
  }
  return null;
}

function tessellateArc(center, r, a0, a1, outPrec){
  let start=a0, end=a1;
  if(end < start) end += 2*Math.PI;

  let dTheta = Math.PI/18;
  if(r > 1e-9){
    const x = Math.max(-1, Math.min(1, 1 - (outPrec/r)));
    const maxStep = 2*Math.acos(x);
    if(isFinite(maxStep) && maxStep>1e-6) dTheta = Math.min(maxStep, Math.PI/6);
  }

  const pts=[];
  pts.push({ x:center.x + r*Math.cos(start), y:center.y + r*Math.sin(start) });
  for(let t=start+dTheta; t<end; t+=dTheta){
    pts.push({ x:center.x + r*Math.cos(t), y:center.y + r*Math.sin(t) });
  }
  pts.push({ x:center.x + r*Math.cos(end), y:center.y + r*Math.sin(end) });
  return pts;
}

function ptsToSegs(pts){
  const segs=[];
  for(let i=0;i<pts.length-1;i++){
    segs.push({ kind:"line", a:pts[i], b:pts[i+1] });
  }
  return segs;
}

function extractSegments(dxf, outPrec){
  const out=[];
  const ents=dxf?.entities||[];

  for(const e of ents){
    if(e.type==="LINE"){
      const a=xyOf(e.start), b=xyOf(e.end);
      if(a&&b) out.push({ kind:"line", a,b });
      continue;
    }

    if(e.type==="LWPOLYLINE" || e.type==="POLYLINE"){
      const verts=(e.vertices||[]).map(xyOf).filter(Boolean);
      if(verts.length>=2){
        for(let i=0;i<verts.length-1;i++) out.push({ kind:"line", a:verts[i], b:verts[i+1] });
        if(e.closed) out.push({ kind:"line", a:verts[verts.length-1], b:verts[0] });
      }
      continue;
    }

    if(e.type==="SPLINE"){
      const ptsRaw=(e.fitPoints?.length ? e.fitPoints : e.controlPoints) || [];
      const pts=ptsRaw.map(xyOf).filter(Boolean);
      if(pts.length>=2) out.push(...ptsToSegs(pts));
      continue;
    }

    if(e.type==="ARC"){
      const c=xyOf(e.center);
      const r=Number(e.radius);
      if(c && isFinite(r) && r>0){
        let a0=Number(e.startAngle), a1=Number(e.endAngle);
        if(Math.abs(a0) > 2*Math.PI || Math.abs(a1) > 2*Math.PI){
          a0=degToRad(a0); a1=degToRad(a1);
        }
        const pts=tessellateArc(c,r,a0,a1,outPrec);
        out.push(...ptsToSegs(pts));
      }
      continue;
    }

    if(e.type==="CIRCLE"){
      const c=xyOf(e.center);
      const r=Number(e.radius);
      if(c && isFinite(r) && r>0){
        const pts=tessellateArc(c,r,0,2*Math.PI,outPrec);
        out.push(...ptsToSegs(pts));
      }
      continue;
    }
  }
  return out;
}

function boundsOfSegments(segs){
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const s of segs){
    minX=Math.min(minX,s.a.x,s.b.x);
    minY=Math.min(minY,s.a.y,s.b.y);
    maxX=Math.max(maxX,s.a.x,s.b.x);
    maxY=Math.max(maxY,s.a.y,s.b.y);
  }
  if(!isFinite(minX)) return { minX:0,minY:0,maxX:1,maxY:1 };
  return { minX,minY,maxX,maxY };
}

function applyOriginShift(segs, origin){
  const b=boundsOfSegments(segs);
  const cx=(b.minX+b.maxX)/2, cy=(b.minY+b.maxY)/2;
  let dx=0, dy=0;

  if(origin==="center"){ dx=-cx; dy=-cy; }
  else if(origin==="ul"){ dx=-b.minX; dy=-b.maxY; }
  else if(origin==="ur"){ dx=-b.maxX; dy=-b.maxY; }
  else if(origin==="ll"){ dx=-b.minX; dy=-b.minY; }
  else if(origin==="lr"){ dx=-b.maxX; dy=-b.minY; }

  return segs.map(s=>({ kind:"line", a:{x:s.a.x+dx,y:s.a.y+dy}, b:{x:s.b.x+dx,y:s.b.y+dy} }));
}

function collinear(a,b,c,eps){
  return Math.abs((b.x-a.x)*(c.y-a.y) - (b.y-a.y)*(c.x-a.x)) <= eps;
}

function mergeCollinear(chain, tol){
  const out=[];
  if(!chain.length) return out;

  const eps=Math.max(1e-12, tol*tol);
  let i=0;

  while(i<chain.length){
    let a=chain[i].a;
    let b=chain[i].b;

    if(!a||!b){ i++; continue; }
    if(samePt(a,b,tol)){ i++; continue; }

    let j=i+1;
    while(j<chain.length){
      const n=chain[j];
      if(!n?.a||!n?.b) break;
      if(!samePt(b,n.a,tol)) break;
      if(samePt(n.a,n.b,tol)){ j++; continue; }
      if(!collinear(a,b,n.b,eps)) break;
      b=n.b;
      j++;
    }

    out.push({ kind:"line", a, b });
    i=j;
  }
  return out;
}

function buildPathsFromLines(lines, snapGrid, angleTolDeg, outPrec){
  const minLen=Math.max(outPrec*0.8, snapGrid*0.5);
  const tol=snapGrid*0.55;
  const angTol=degToRad(angleTolDeg);

  const L = lines
    .map(s=>({ kind:"line", a:snapPoint(s.a,snapGrid), b:snapPoint(s.b,snapGrid) }))
    .filter(s=>dist(s.a,s.b) >= minLen);

  const key=(p)=>`${Math.round(p.x/snapGrid)},${Math.round(p.y/snapGrid)}`;
  const map=new Map();
  for(let i=0;i<L.length;i++){
    const k=key(L[i].a);
    if(!map.has(k)) map.set(k, []);
    map.get(k).push(i);
  }

  const used=new Array(L.length).fill(false);
  const paths=[];

  for(let i=0;i<L.length;i++){
    if(used[i]) continue;
    used[i]=true;

    const chain=[L[i]];
    let cur=L[i];

    while(true){
      const end=cur.b;
      const candidates=map.get(key(end)) || [];
      const d0=angle(cur.a,cur.b);

      let best=-1, bestScore=Infinity;

      for(const idx of candidates){
        if(used[idx]) continue;
        const s=L[idx];
        if(!samePt(end,s.a,tol)) continue;

        const d1=angle(s.a,s.b);
        const da=Math.abs(normAng(d1-d0));
        if(da <= angTol && da < bestScore){
          best=idx; bestScore=da;
        }
      }
      if(best===-1) break;

      used[best]=true;
      chain.push(L[best]);
      cur=L[best];
    }

    const merged=mergeCollinear(chain, snapGrid);
    if(merged.length) paths.push({ segments: merged });
  }

  return paths;
}

function orderPathsNearest(paths){
  const remaining=paths.filter(p=>p?.segments?.length).slice();
  if(remaining.length<=1) return remaining;

  const ordered=[];
  let cur=remaining.shift();
  ordered.push(cur);

  let curPt=cur.segments[cur.segments.length-1].b;

  while(remaining.length){
    let bestIdx=-1, bestD=Infinity, flip=false;

    for(let i=0;i<remaining.length;i++){
      const p=remaining[i];
      const a=p.segments[0].a;
      const b=p.segments[p.segments.length-1].b;

      const dA=dist(curPt,a);
      const dB=dist(curPt,b);

      if(dA<bestD){ bestD=dA; bestIdx=i; flip=false; }
      if(dB<bestD){ bestD=dB; bestIdx=i; flip=true; }
    }

    let next=remaining.splice(bestIdx,1)[0];
    if(flip){
      next={ segments: next.segments.slice().reverse().map(s=>({ kind:"line", a:s.b, b:s.a })) };
    }

    ordered.push(next);
    curPt=next.segments[next.segments.length-1].b;
  }

  return ordered;
}

function mergeContinuousPaths(paths, chainTol){
  if(paths.length<=1) return paths;
  const out=[];
  let cur=paths[0];

  for(let i=1;i<paths.length;i++){
    const nxt=paths[i];
    const curEnd=cur.segments[cur.segments.length-1].b;
    const nxtStart=nxt.segments[0].a;

    if(samePt(curEnd, nxtStart, chainTol)){
      cur={ segments: cur.segments.concat(nxt.segments) };
    } else {
      out.push(cur);
      cur=nxt;
    }
  }
  out.push(cur);
  return out;
}

// ---------- Moves + NC ----------
function buildMoves(paths, opts){
  const moves=[];
  const safeZ=opts.safeZ;
  const depth=Math.abs(opts.totalDepth);
  const step=opts.stepDown;
  const passes=Math.max(1, Math.ceil(depth/step));

  const passZ=[];
  for(let i=1;i<=passes;i++) passZ.push(-Math.min(depth, i*step));

  let curXY={x:0,y:0};
  let curZ=safeZ;

  const retract=()=>{ if(curZ!==safeZ){ moves.push({type:"retract", z:safeZ}); curZ=safeZ; } };
  const rapidXY=(x,y)=>{ moves.push({type:"rapidXY", x,y}); curXY={x,y}; };
  const plunge=(z)=>{ moves.push({type:"plunge", z, f:opts.feedZ}); curZ=z; };
  const feedXY=()=> moves.push({type:"feedXY", f:opts.feedXY});
  const cutTo=(x,y)=>{ moves.push({type:"cutLine", x,y}); curXY={x,y}; };

  retract();

  for(const z of passZ){
    retract();
    for(const p of paths){
      if(!p?.segments?.length) continue;
      const start=p.segments[0].a;

      if(!samePt(curXY, start, opts.chainTol)){
        retract();
        rapidXY(start.x, start.y);
        plunge(z);
        feedXY();
      } else {
        if(curZ!==z) plunge(z);
        feedXY();
      }

      for(const s of p.segments){
        cutTo(s.b.x, s.b.y);
      }
    }
    retract();
  }

  return moves;
}

function buildNC(moves, opts){
  const P=opts.outPrec;
  const lines=[];
  const moveToLine=new Map();

  const push=(line, moveIdx=null)=>{
    const idx=lines.length;
    lines.push(line);
    if(moveIdx!==null) moveToLine.set(moveIdx, idx);
  };

  const outXY=(x,y)=>`X${fmt(x,P)} Y${fmt(y,P)}`;
  const outZ=(z)=>`Z${fmt(z,P)}`;

  push("%");
  push("(NorrisCAM - USB DAT G-code)");
  push(opts.toolComment);
  push("G90 (absolute)");
  push("G94 (feed/min)");
  push("G17 (XY plane)");
  push("G20 (inches)");
  push("G40 (cancel cutter comp)");
  push("G49 (cancel tool length offset)");
  push("G54 (work offset)");
  push(`M3 S${Math.floor(opts.spindleRPM)} (spindle on)`);
  push(`G0 ${outZ(opts.safeZ)}`);

  let lastF=null;
  let atZ=opts.safeZ;
  let atXY={x:null,y:null};

  for(let i=0;i<moves.length;i++){
    const m=moves[i];

    if(m.type==="retract"){
      if(atZ!==m.z){ push(`G0 ${outZ(m.z)}`, i); atZ=m.z; }
      continue;
    }

    if(m.type==="rapidXY"){
      if(atXY.x!==m.x || atXY.y!==m.y){
        push(`G0 ${outXY(m.x,m.y)}`, i);
        atXY={x:m.x,y:m.y};
      }
      continue;
    }

    if(m.type==="plunge"){
      if(lastF!==m.f){
        push(`G1 ${outZ(m.z)} F${fmt(m.f,0.1)}`, i);
        lastF=m.f;
      } else {
        push(`G1 ${outZ(m.z)}`, i);
      }
      atZ=m.z;
      continue;
    }

    if(m.type==="feedXY"){
      if(lastF!==m.f){
        push(`F${fmt(m.f,0.1)}`, i);
        lastF=m.f;
      }
      continue;
    }

    if(m.type==="cutLine"){
      push(`G1 ${outXY(m.x,m.y)}`, i);
      atXY={x:m.x,y:m.y};
      continue;
    }
  }

  push(`G0 ${outZ(opts.safeZ)}`);
  push("M5 (spindle stop)");
  push("M30 (end)");
  push("%");

  return { ncText: lines.join("\n"), lines, moveToLine };
}

function buildPlayback(moves, moveToLine){
  const segs=[];
  let cur={x:0,y:0};
  let curZ=null;

  for(let i=0;i<moves.length;i++){
    const m=moves[i];

    if(m.type==="plunge") curZ=m.z;

    if(m.type==="rapidXY"){
      const a={...cur}, b={x:m.x,y:m.y};
      segs.push({ a,b, mode:"RAPID", ncLineIdx: moveToLine.get(i), z:curZ });
      cur=b;
      continue;
    }

    if(m.type==="cutLine"){
      const a={...cur}, b={x:m.x,y:m.y};
      segs.push({ a,b, mode:"CUT", ncLineIdx: moveToLine.get(i), z:curZ });
      cur=b;
      continue;
    }
  }

  lineToLastSegIndex = new Map();
  for(let si=0; si<segs.length; si++){
    const ln = segs[si].ncLineIdx;
    if(typeof ln === "number") lineToLastSegIndex.set(ln, si);
  }

  return segs;
}

// ---------- NC render (Reveal + line numbers + smooth scroll-to-top) ----------
function escapeHtml(s){
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function pad4(n){ return String(n).padStart(4,"0"); }

/**
 * Render code from line 0 .. shownLineMax
 * Highlight currentLineIdx if >=0
 * Auto-scroll highlighted row to top (smooth)
 */
function renderNC(){
  const box=$("ncBox");

  if(!ncLines.length){
    box.innerHTML = `<div class="row"><div class="ln">----</div><div class="code">DAT will appear here after Build…</div></div>`;
    $("ncLineHud").textContent="Line: —";
    return;
  }

  if(shownLineMax < 0){
    // IMPORTANT: After build we will set shownLineMax so code appears immediately.
    box.innerHTML = `<div class="row"><div class="ln">----</div><div class="code">Building…</div></div>`;
    $("ncLineHud").textContent="Line: —";
    return;
  }

  const maxLine = Math.min(shownLineMax, ncLines.length-1);
  const html=[];

  for(let i=0;i<=maxLine;i++){
    const isHi = (i===currentLineIdx);
    html.push(
      `<div class="row ${isHi ? "hi" : ""}" data-ln="${i}">
         <div class="ln">${pad4(i+1)}</div>
         <div class="code">${escapeHtml(ncLines[i])}</div>
       </div>`
    );
  }

  box.innerHTML = html.join("");
  $("ncLineHud").textContent = (currentLineIdx>=0) ? `Line: ${currentLineIdx+1}` : `Line: —`;

  if(currentLineIdx>=0){
    const el = box.querySelector(`[data-ln="${currentLineIdx}"]`);
    if(el){
      const targetTop = el.offsetTop;
      box.scrollTo({ top: Math.max(0, targetTop - 2), behavior: "smooth" });
    }
  }
}

// ---------- View lock helpers ----------
function lockView(){
  lockedView = { scale: view.scale, ox: view.ox, oy: view.oy };
  viewLocked = true;
}
function applyLockedView(){
  if(!viewLocked) return;
  view.scale = lockedView.scale;
  view.ox = lockedView.ox;
  view.oy = lockedView.oy;
}

// ---------- View + Draw ----------
function worldToScreen(p){ return { x: p.x*view.scale + view.ox, y: -p.y*view.scale + view.oy }; }
function screenToWorld(x,y){ return { x:(x-view.ox)/view.scale, y:-(y-view.oy)/view.scale }; }

function clear(){
  const r=canvas.getBoundingClientRect();
  ctx.clearRect(0,0,r.width,r.height);
}

function drawGrid(){
  const r=canvas.getBoundingClientRect();
  const w=r.width, h=r.height;

  ctx.save();
  ctx.strokeStyle="rgba(255,255,255,0.05)";
  ctx.lineWidth=1;
  const step=50;

  for(let x=0;x<=w;x+=step){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
  for(let y=0;y<=h;y+=step){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }

  const o=worldToScreen({x:0,y:0});
  ctx.strokeStyle="rgba(255,255,255,0.18)";
  ctx.beginPath(); ctx.moveTo(o.x-12,o.y); ctx.lineTo(o.x+12,o.y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(o.x,o.y-12); ctx.lineTo(o.x,o.y+12); ctx.stroke();
  ctx.restore();
}

function drawPreviewGeometry(){
  if(!previewSegs.length) return;
  ctx.save();
  ctx.strokeStyle="rgba(125,211,252,0.95)";
  ctx.lineWidth=2;
  for(const s of previewSegs){
    const a=worldToScreen(s.a), b=worldToScreen(s.b);
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
  }
  ctx.restore();
}

function drawRevealedToolpath(){
  if(!playback.length) return;
  const n=Math.min(revealCount, playback.length);

  // rapids (faint dashed)
  ctx.save();
  ctx.strokeStyle="rgba(122,167,255,0.35)";
  ctx.lineWidth=2;
  ctx.setLineDash([6,6]);
  for(let i=0;i<n;i++){
    const s=playback[i];
    if(s.mode!=="RAPID") continue;
    const a=worldToScreen(s.a), b=worldToScreen(s.b);
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
  }
  ctx.restore();

  // cuts (red)
  ctx.save();
  ctx.strokeStyle="rgba(255,122,122,0.95)";
  ctx.lineWidth=2;
  ctx.setLineDash([]);
  for(let i=0;i<n;i++){
    const s=playback[i];
    if(s.mode!=="CUT") continue;
    const a=worldToScreen(s.a), b=worldToScreen(s.b);
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
  }
  ctx.restore();
}

function drawToolDot(){
  if(!playback.length) return;
  const n=Math.min(revealCount, playback.length);
  if(n<=0){
    $("hudMode").textContent="Mode: Preview";
    $("hudPos").textContent="XY: —";
    return;
  }
  const last=playback[n-1];
  const p=last.b;
  const sp=worldToScreen(p);

  ctx.save();
  ctx.fillStyle = (last.mode==="CUT") ? "rgba(255,122,122,0.95)" : "rgba(122,167,255,0.85)";
  ctx.beginPath(); ctx.arc(sp.x, sp.y, 6, 0, Math.PI*2); ctx.fill();
  ctx.restore();

  $("hudMode").textContent = playTimer ? "Mode: Play" : "Mode: Step";
  $("hudPos").textContent = `XY: ${p.x.toFixed(3)} ${p.y.toFixed(3)} in`;
}

function draw(){
  clear();
  drawGrid();
  drawPreviewGeometry();
  drawRevealedToolpath();
  drawToolDot();
}

// Manual fit only
function fitViewToSegments(segs){
  if(!segs.length) return;
  const b=boundsOfSegments(segs);
  const r=canvas.getBoundingClientRect();
  const w=r.width, h=r.height;
  const pad=30;
  const bw=(b.maxX-b.minX)||1;
  const bh=(b.maxY-b.minY)||1;

  view.scale = Math.min((w-pad*2)/bw, (h-pad*2)/bh);
  const cx=(b.minX+b.maxX)/2;
  const cy=(b.minY+b.maxY)/2;

  view.ox = w/2 - cx*view.scale;
  view.oy = h/2 + cy*view.scale;

  lockView(); // lock the fitted view so build can't move it
}

// Resize: keep canvas crisp but DO NOT change view mapping (prevents jumping)
function resizeCanvasNoViewShift(){
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(r.width*dpr));
  canvas.height = Math.max(1, Math.floor(r.height*dpr));
  ctx.setTransform(dpr,0,0,dpr,0,0);

  // Keep locked view exactly (stability)
  applyLockedView();
  draw();
}

window.addEventListener("resize", resizeCanvasNoViewShift);

// ---------- Pan/Zoom ----------
canvas.addEventListener("mousedown",(e)=>{
  view.dragging=true;
  view.lx=e.clientX; view.ly=e.clientY;
});
window.addEventListener("mouseup",()=>{ view.dragging=false; });
window.addEventListener("mousemove",(e)=>{
  if(!view.dragging) return;
  viewTouched=true;
  viewLocked=false; // user takes control
  view.ox += (e.clientX-view.lx);
  view.oy += (e.clientY-view.ly);
  view.lx=e.clientX; view.ly=e.clientY;
  draw();
});
canvas.addEventListener("wheel",(e)=>{
  e.preventDefault();
  viewTouched=true;
  viewLocked=false; // user takes control

  const r=canvas.getBoundingClientRect();
  const mx=e.clientX-r.left;
  const my=e.clientY-r.top;

  const before=screenToWorld(mx,my);
  const zoom=Math.exp(-e.deltaY*0.001);
  view.scale *= zoom;
  const after=screenToWorld(mx,my);

  view.ox += (before.x-after.x)*view.scale;
  view.oy -= (before.y-after.y)*view.scale;
  draw();
},{passive:false});

// ---------- Tabs ----------
function setTab(which){
  const isMain = which==="main";
  $("tabMain").classList.toggle("active", isMain);
  $("tabOptions").classList.toggle("active", !isMain);
  $("paneMain").classList.toggle("active", isMain);
  $("paneOptions").classList.toggle("active", !isMain);
}
$("tabMain").addEventListener("click",()=>setTab("main"));
$("tabOptions").addEventListener("click",()=>setTab("options"));

// ---------- Step/Back + Play/Pause ----------
function setPlaying(on){
  if(on){
    if(playTimer) return;
    playTimer = setInterval(()=>{
      if(!playback.length) return;
      if(revealCount >= playback.length){
        setPlaying(false);
        return;
      }
      step(+1);
    }, 120);
  } else {
    if(playTimer) clearInterval(playTimer);
    playTimer=null;
  }
  draw();
}

function syncCurrentLineFromReveal(){
  if(revealCount<=0){
    currentLineIdx = -1;
    // don’t hide code that’s already shown — keep shownLineMax as-is
    renderNC();
    return;
  }
  const seg = playback[Math.min(revealCount-1, playback.length-1)];
  const ln = seg?.ncLineIdx;
  currentLineIdx = (typeof ln==="number") ? ln : -1;

  // Reveal expands as stepping progresses
  if(currentLineIdx >= 0) shownLineMax = Math.max(shownLineMax, currentLineIdx);

  renderNC();
}

function step(dir){
  if(!playback.length) return;

  if(dir>0) revealCount=Math.min(playback.length, revealCount+1);
  else revealCount=Math.max(0, revealCount-1);

  syncCurrentLineFromReveal();
  draw();
}

$("step").addEventListener("click",()=>step(+1));
$("back").addEventListener("click",()=>step(-1));
$("play").addEventListener("click",()=>setPlaying(true));
$("pause").addEventListener("click",()=>setPlaying(false));

window.addEventListener("keydown",(e)=>{
  const tag = document.activeElement?.tagName?.toLowerCase();
  if(tag==="input" || tag==="select" || tag==="textarea") return;

  if((e.key==="s"||e.key==="S") && !$("step").disabled){
    e.preventDefault();
    step(+1);
  }
  if((e.key==="b"||e.key==="B") && !$("back").disabled){
    e.preventDefault();
    step(-1);
  }
  if(e.code==="Space" && !$("play").disabled){
    e.preventDefault();
    setPlaying(!playTimer);
  }
});

// ---------- Go To Line ----------
function gotoLine(n){
  if(!ncLines.length) return;
  const idx = Math.max(0, Math.min(ncLines.length-1, n-1));

  // reveal at least up to that line
  shownLineMax = Math.max(shownLineMax, idx);

  // Find segment position closest at/before that line
  let segIndex = null;

  if(lineToLastSegIndex.has(idx)){
    segIndex = lineToLastSegIndex.get(idx);
  } else {
    for(let i=idx; i>=0; i--){
      if(lineToLastSegIndex.has(i)){
        segIndex = lineToLastSegIndex.get(i);
        break;
      }
    }
  }

  if(segIndex === null){
    // no move lines yet — just highlight requested line
    currentLineIdx = idx;
    renderNC();
    draw();
    return;
  }

  revealCount = Math.min(playback.length, segIndex + 1);
  syncCurrentLineFromReveal();
  draw();
}

$("gotoBtn").addEventListener("click", ()=>{
  const n = Number($("gotoLine").value || 1);
  gotoLine(n);
});
$("gotoLine").addEventListener("keydown",(e)=>{
  if(e.key==="Enter"){
    e.preventDefault();
    $("gotoBtn").click();
  }
});

// ---------- Buttons ----------
$("fit").addEventListener("click",()=>{
  if(previewSegs.length) fitViewToSegments(previewSegs);
  draw();
});

$("resetSim").addEventListener("click",()=>{
  setPlaying(false);
  revealCount=0;
  currentLineIdx=-1;
  // keep code shown; just reset tool preview
  renderNC();
  draw();
});

$("download").addEventListener("click",()=>{
  if(!lastNC) return;

  let name = prompt("File name for USB export:", "output.dat");
  if(name===null) return;
  name = name.trim();
  if(!name) name = "output.dat";
  if(!name.toLowerCase().endsWith(".dat")) name += ".dat";

  const blob = new Blob([lastNC], {type:"text/plain"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download=name;
  a.click();
  URL.revokeObjectURL(a.href);

  setStatus("good","Exported",`Saved ${name}`);
});

$("scrub").disabled = true;

// ---------- Import DXF ----------
$("file").addEventListener("change", async (e)=>{
  const f=e.target.files?.[0];
  if(!f) return;

  setPlaying(false);
  setStatus("warn","Loading…",f.name);

  try{
    const text=await f.text();
    const parser=new window.DxfParser();
    dxfParsed=parser.parseSync(text);
  }catch(err){
    console.error(err);
    setStatus("bad","DXF parse failed","Try exporting as R12 / ASCII DXF.");
    alert("DXF parse failed. Try exporting as R12 / ASCII DXF.");
    return;
  }

  const opts=readOpts();
  let segs=extractSegments(dxfParsed, opts.outPrec);

  if(!segs.length){
    setStatus("bad","No usable geometry","Need LINE/POLYLINE/SPLINE/ARC/CIRCLE.");
    alert("No usable geometry found.\nTry exporting as R12 / ASCII DXF.");
    return;
  }

  segs=applyOriginShift(segs, opts.origin);
  previewSegs=segs.map(s=>({a:s.a,b:s.b}));

  // clear previous build
  playback=[]; moves=[]; ncLines=[]; lastNC="";
  revealCount=0; currentLineIdx=-1; shownLineMax=-1;
  lineToLastSegIndex = new Map();

  $("buildToolpath").disabled=false;
  $("download").disabled=true;
  $("fit").disabled=false;
  $("resetSim").disabled=true;
  $("step").disabled=true;
  $("back").disabled=true;
  $("play").disabled=true;
  $("pause").disabled=true;

  renderNC();

  if(!viewTouched){
    fitViewToSegments(previewSegs); // also locks view
  } else {
    // user already positioned it — lock current view so build doesn't change it
    lockView();
  }

  resizeCanvasNoViewShift();

  setStatus("good","Loaded","Geometry ready. Click Build.");
  draw();
});

// ---------- Build Toolpath ----------
$("buildToolpath").addEventListener("click", ()=>{
  if(!dxfParsed){ alert("Import a DXF first."); return; }

  try{
    setPlaying(false);
    setStatus("warn","Building…","Chaining + tool-down paths + DAT");

    // IMPORTANT: force view to remain stable across build
    if(!viewLocked) lockView();

    const opts=readOpts();
    let segs=extractSegments(dxfParsed, opts.outPrec);
    segs=applyOriginShift(segs, opts.origin);

    const lines=segs.filter(s=>s.kind==="line");
    let paths=buildPathsFromLines(lines, opts.snapGrid, opts.angleTolDeg, opts.outPrec);
    paths=orderPathsNearest(paths);
    paths=mergeContinuousPaths(paths, opts.chainTol);

    if(!paths.length){
      setStatus("bad","Build produced 0 paths","Try Options: Snap 0.01, Angle 20, Prec 0.005");
      alert("No paths created.\nTry:\n- Snap Grid 0.01\n- Output Prec 0.005\n- Angle Tol 20");
      return;
    }

    moves=buildMoves(paths, opts);
    const { ncText, lines:ncArr, moveToLine } = buildNC(moves, opts);

    lastNC=ncText;
    ncLines=ncArr;
    playback=buildPlayback(moves, moveToLine);

    // reset sim
    revealCount=0;
    currentLineIdx=-1;

    // ✅ KEY FIX: show code immediately after build
    shownLineMax = Math.min(ncLines.length-1, INITIAL_CODE_LINES_AFTER_BUILD-1);
    renderNC();

    // enable controls
    $("download").disabled=false;
    $("resetSim").disabled=false;
    $("step").disabled=false;
    $("back").disabled=false;
    $("play").disabled=false;
    $("pause").disabled=false;

    $("gotoLine").max = String(ncLines.length);
    $("gotoLine").value = "1";

    // ✅ KEY FIX: do not let canvas jump due to layout changes
    resizeCanvasNoViewShift();
    applyLockedView();

    setStatus("good","Built",`Paths: ${paths.length} | Moves: ${playback.length} | Press S or Play.`);
    draw();
  }catch(err){
    console.error(err);
    setStatus("bad","Build failed", err?.message || String(err));
    alert(`Build failed:\n${err?.message || String(err)}`);
  }
});

// ---------- Origin change: update preview only ----------
$("origin").addEventListener("change", ()=>{
  if(!dxfParsed) return;

  setPlaying(false);

  const opts=readOpts();
  let segs=extractSegments(dxfParsed, opts.outPrec);
  if(!segs.length) return;

  segs=applyOriginShift(segs, opts.origin);
  previewSegs=segs.map(s=>({a:s.a,b:s.b}));

  // must rebuild toolpath
  playback=[]; moves=[]; ncLines=[]; lastNC="";
  revealCount=0; currentLineIdx=-1; shownLineMax=-1;
  lineToLastSegIndex = new Map();

  $("download").disabled=true;
  $("resetSim").disabled=true;
  $("step").disabled=true;
  $("back").disabled=true;
  $("play").disabled=true;
  $("pause").disabled=true;

  renderNC();

  // keep view stable
  if(!viewLocked) lockView();
  resizeCanvasNoViewShift();

  setStatus("warn","Origin changed","Preview updated — rebuild toolpath.");
  draw();
});

// ---------- Init ----------
function init(){
  const r=canvas.getBoundingClientRect();
  view.ox=r.width/2;
  view.oy=r.height/2;
  lockView();

  renderNC();
  setStatus("warn","Idle","Import a DXF to begin.");
  resizeCanvasNoViewShift();
}
init();
