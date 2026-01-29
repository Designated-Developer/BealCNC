// NorrisCAM — DXF preview + tolerant toolpath + USB-ready .NC (inches)
// New:
// - NC preview moved to right (rendered with highlightable lines)
// - Step button + hotkey "S" steps to next motion line (G0/G1 XY), syncing sim + highlight
// - Tool stays down across continuous chains; retract only for true rapids
// - No spindle codes

const $ = (id) => document.getElementById(id);
const canvas = $("c");
const ctx = canvas.getContext("2d");

let dxfParsed = null;
let previewSegs = [];
let playback = [];           // sim segments
let moves = [];              // move objects
let ncLines = [];            // array of NC lines
let motionLineIdxs = [];     // NC line indices that represent motion (G0 XY / G1 XY)
let motionCum = [];          // cumulative distances for each motion step for scrub positioning
let stepPtr = -1;            // current step index into motionLineIdxs
let lastNC = "";
let playing = false;

const view = { scale: 60, ox: 0, oy: 0, dragging: false, lx: 0, ly: 0 };

function setStatus(kind, title, detail){
  $("topStatus").textContent = title;
  $("stats").textContent = detail || "";
  const dot = $("statusDot");
  dot.classList.remove("good","warn","bad");
  if(kind === "good") dot.classList.add("good");
  else if(kind === "warn") dot.classList.add("warn");
  else if(kind === "bad") dot.classList.add("bad");
}

function readOpts(){
  const safeZ = Number($("safeZ").value || 0.5);
  const totalDepth = -Math.abs(Number($("cutZ").value || 0.0625));
  const stepDown = Math.max(0.001, Number($("stepDown").value || 0.0625));
  return {
    units: "inch",
    origin: $("origin").value,
    safeZ,
    totalDepth,
    stepDown,
    feedXY: Number($("feedXY").value || 30),
    feedZ: Number($("feedZ").value || 20),
    outPrec: Number($("outPrec").value || 0.01),
    snapGrid: Math.max(0.001, Number($("snapGrid").value || 0.02)),
    angleTolDeg: Math.max(1, Number($("angleTolDeg").value || 12)),
    chainTol: Math.max(0.0005, Number($("chainTol").value || 0.02)),
    toolComment: $("toolComment").value || "(T1 - 1/4 endmill, centerline, no comp)",
  };
}

function fmt(n, step){
  const q = Math.round(n / step) * step;
  let dec = 0;
  if(step < 1) dec = Math.max(0, Math.ceil(-Math.log10(step)));
  return q.toFixed(dec).replace(/\.?0+$/,"");
}
function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }
function degToRad(d){ return d*Math.PI/180; }
function angle(a,b){ return Math.atan2(b.y-a.y, b.x-a.x); }
function samePt(a,b,tol){
  return Math.abs(a.x-b.x)<=tol && Math.abs(a.y-b.y)<=tol;
}
function snapPoint(p, grid){
  return { x: Math.round(p.x/grid)*grid, y: Math.round(p.y/grid)*grid };
}
function collinear(a,b,c,eps){
  return Math.abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)) <= eps;
}

// ----- Point normalization -----
function xyOf(pt){
  if(!pt) return null;
  if(Array.isArray(pt) && pt.length >= 2 && isFinite(pt[0]) && isFinite(pt[1])){
    return {x:Number(pt[0]), y:Number(pt[1])};
  }
  if(typeof pt === "object"){
    if(isFinite(pt.x) && isFinite(pt.y)) return {x:Number(pt.x), y:Number(pt.y)};
    if(isFinite(pt[0]) && isFinite(pt[1])) return {x:Number(pt[0]), y:Number(pt[1])};
    if(pt.point){
      const p = xyOf(pt.point);
      if(p) return p;
    }
  }
  return null;
}

// ----- DXF extract: LINE + polyline + spline fallback to lines -----
function extractSegments(dxf){
  const out = [];
  const ents = dxf?.entities || [];

  for(const e of ents){
    if(e.type === "LINE"){
      const a=xyOf(e.start), b=xyOf(e.end);
      if(a && b) out.push({kind:"line", a, b});
      continue;
    }

    if(e.type === "LWPOLYLINE" || e.type === "POLYLINE"){
      const verts = (e.vertices || [])
        .map(v => xyOf(v))
        .filter(Boolean);

      if(verts.length < 2) continue;

      for(let i=0;i<verts.length-1;i++){
        out.push({kind:"line", a:verts[i], b:verts[i+1]});
      }
      if(e.closed){
        out.push({kind:"line", a:verts[verts.length-1], b:verts[0]});
      }
      continue;
    }

    if(e.type === "SPLINE"){
      const ptsRaw = (e.fitPoints && e.fitPoints.length ? e.fitPoints : e.controlPoints) || [];
      const pts = ptsRaw.map(xyOf).filter(Boolean);
      if(pts.length >= 2){
        for(let i=0;i<pts.length-1;i++){
          out.push({kind:"line", a:pts[i], b:pts[i+1]});
        }
      }
      continue;
    }
  }

  return out;
}

// ----- Origin shift -----
function boundsOfSegments(segs){
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const s of segs){
    minX=Math.min(minX,s.a.x,s.b.x);
    minY=Math.min(minY,s.a.y,s.b.y);
    maxX=Math.max(maxX,s.a.x,s.b.x);
    maxY=Math.max(maxY,s.a.y,s.b.y);
  }
  if(!isFinite(minX)) return {minX:0,minY:0,maxX:1,maxY:1};
  return {minX,minY,maxX,maxY};
}
function applyOriginShift(segs, origin){
  const b = boundsOfSegments(segs);
  const cx=(b.minX+b.maxX)/2, cy=(b.minY+b.maxY)/2;
  let dx=0, dy=0;

  if(origin==="center"){ dx = -cx; dy = -cy; }
  else if(origin==="ul"){ dx = -b.minX; dy = -b.maxY; }
  else if(origin==="ur"){ dx = -b.maxX; dy = -b.maxY; }
  else if(origin==="ll"){ dx = -b.minX; dy = -b.minY; }
  else if(origin==="lr"){ dx = -b.maxX; dy = -b.minY; }

  return segs.map(s => ({kind:"line", a:{x:s.a.x+dx,y:s.a.y+dy}, b:{x:s.b.x+dx,y:s.b.y+dy}}));
}

// ----- Simplify / chain -----
function mergeCollinear(pathSegs, tol){
  const out=[];
  if(!Array.isArray(pathSegs) || pathSegs.length===0) return out;

  const eps=Math.max(1e-12, tol*tol);
  let i=0;

  while(i<pathSegs.length){
    const s=pathSegs[i];
    if(!s?.a || !s?.b) { i++; continue; }
    let a=s.a, b=s.b;

    if(!isFinite(a.x)||!isFinite(a.y)||!isFinite(b.x)||!isFinite(b.y)){ i++; continue; }
    if(samePt(a,b,tol)){ i++; continue; }

    let j=i+1;
    while(j<pathSegs.length){
      const n=pathSegs[j];
      if(!n?.a || !n?.b) break;
      if(!samePt(b, n.a, tol)) break;
      if(samePt(n.a,n.b,tol)){ j++; continue; }
      if(!collinear(a,b,n.b,eps)) break;
      b=n.b; j++;
    }

    out.push({kind:"line", a, b});
    i=j;
  }
  return out;
}

function buildPathsFromLines(lines, snapGrid, angleTolDeg, outPrec){
  const minLen = Math.max(outPrec*0.9, snapGrid*0.5);
  const tol = snapGrid * 0.55;
  const angTol = degToRad(angleTolDeg);

  const L = lines
    .map(s=>({kind:"line", a:snapPoint(s.a,snapGrid), b:snapPoint(s.b,snapGrid)}))
    .filter(s =>
      isFinite(s.a.x)&&isFinite(s.a.y)&&isFinite(s.b.x)&&isFinite(s.b.y) &&
      dist(s.a,s.b) >= minLen
    );

  const map=new Map();
  const k=(p)=>`${Math.round(p.x/snapGrid)},${Math.round(p.y/snapGrid)}`;
  for(let i=0;i<L.length;i++){
    const ks=k(L[i].a);
    if(!map.has(ks)) map.set(ks,[]);
    map.get(ks).push(i);
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
      const cand=map.get(k(end))||[];
      const d0=angle(cur.a,cur.b);

      let best=-1, bestScore=Infinity;
      for(const idx of cand){
        if(used[idx]) continue;
        const s=L[idx];
        if(!samePt(end, s.a, tol)) continue;

        const d1=angle(s.a,s.b);
        let da=Math.abs(d1-d0);
        da=Math.min(da, Math.abs(da-2*Math.PI));
        if(da<=angTol && da<bestScore){ best=idx; bestScore=da; }
      }
      if(best===-1) break;
      used[best]=true;
      chain.push(L[best]);
      cur=L[best];
    }

    const merged = mergeCollinear(chain, snapGrid);
    if(merged.length) paths.push({segments: merged});
  }

  return paths.filter(p => p?.segments?.length);
}

function orderPathsNearest(paths){
  const clean = (paths||[]).filter(p => p?.segments?.length);
  if(clean.length<=1) return clean;

  const remaining = clean.slice();
  const ordered = [];
  let cur = remaining.shift();
  ordered.push(cur);
  let curPt = cur.segments[cur.segments.length-1].b;

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

    const next = remaining.splice(bestIdx,1)[0];
    if(flip){
      next.segments = next.segments.slice().reverse().map(s => ({kind:"line", a:s.b, b:s.a}));
    }
    ordered.push(next);
    curPt = next.segments[next.segments.length-1].b;
  }
  return ordered;
}

// Merge paths where end ~ next start => tool stays down
function mergeContinuousPaths(paths, chainTol){
  if(paths.length <= 1) return paths;
  const out=[];
  let cur = paths[0];

  for(let i=1;i<paths.length;i++){
    const next = paths[i];
    const curEnd = cur.segments[cur.segments.length-1].b;
    const nextStart = next.segments[0].a;

    if(samePt(curEnd, nextStart, chainTol)){
      cur = { segments: cur.segments.concat(next.segments) };
    } else {
      out.push(cur);
      cur = next;
    }
  }
  out.push(cur);
  return out;
}

// ----- Moves / NC (retract only when needed) -----
function buildMoves(paths, opts){
  const m=[];
  const depth = Math.abs(opts.totalDepth);
  const step = opts.stepDown;
  const passCount = Math.max(1, Math.ceil(depth / step));
  const depths = [];
  for(let i=1;i<=passCount;i++) depths.push(-Math.min(depth, i*step));

  let curXY = {x:0,y:0};
  let curZ = opts.safeZ;

  const retract = () => {
    if(curZ !== opts.safeZ){
      m.push({type:"retract", z:opts.safeZ});
      curZ = opts.safeZ;
    }
  };
  const rapidXY = (x,y) => { m.push({type:"rapidXY", x, y}); curXY={x,y}; };
  const plunge = (z) => { m.push({type:"plunge", z, f:opts.feedZ}); curZ=z; };
  const setFeedXY = () => m.push({type:"feedXY", f:opts.feedXY});
  const cutTo = (x,y) => { m.push({type:"cutLine", x, y}); curXY={x,y}; };

  retract();

  for(const passZ of depths){
    retract();
    for(const p of paths){
      if(!p?.segments?.length) continue;
      const start = p.segments[0].a;

      // reposition only if needed
      if(!samePt(curXY, start, opts.chainTol) || curZ !== passZ){
        retract();
        if(!samePt(curXY, start, opts.chainTol)){
          rapidXY(start.x, start.y);
        }
        plunge(passZ);
        setFeedXY();
      } else {
        setFeedXY();
      }

      for(const s of p.segments){
        cutTo(s.b.x, s.b.y);
      }
      // do NOT retract here
    }
    retract();
  }

  return m;
}

function buildNCWithMap(moves, opts){
  const P = opts.outPrec;
  const g=[];
  const moveToNcLine = new Map(); // map move index -> NC line index

  const push = (line, moveIdx=null) => {
    const idx = g.length;
    g.push(line);
    if(moveIdx !== null) moveToNcLine.set(moveIdx, idx);
  };

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

  let lastF=null;
  let atZ=null;
  let atXY={x:null,y:null};

  const outXY=(x,y)=>`X${fmt(x,P)} Y${fmt(y,P)}`;
  const outZ=(z)=>`Z${fmt(z,P)}`;

  for(let i=0;i<moves.length;i++){
    const m = moves[i];

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
      if(lastF!==m.f){ push(`F${fmt(m.f,0.1)}`, i); lastF=m.f; }
      continue;
    }
    if(m.type==="cutLine"){
      push(`G1 ${outXY(m.x,m.y)}`, i);
      atXY={x:m.x,y:m.y};
      continue;
    }
  }

  push("M30 (end)");
  push("%");

  return {
    ncText: g.join("\n"),
    lines: g,
    moveToNcLine
  };
}

// ----- Simulation: include mapping to move indices -----
function buildPlayback(moves){
  const segs=[];
  let cur={x:0,y:0};
  let cum=0;

  for(let i=0;i<moves.length;i++){
    const m=moves[i];
    if(m.type==="rapidXY" || m.type==="cutLine"){
      const mode = (m.type==="cutLine") ? "CUT" : "RAPID";
      const a={...cur}, b={x:m.x,y:m.y};
      const len=Math.hypot(b.x-a.x,b.y-a.y);
      cum+=len;
      segs.push({kind:"line",mode,a,b,len,cum, moveIdx:i});
      cur=b;
    }
  }
  return segs;
}

function pointAtT(t){
  if(!playback.length) return null;
  const total=playback[playback.length-1].cum || 1;
  const target=t*total;

  let lo=0,hi=playback.length-1;
  while(lo<hi){
    const mid=(lo+hi)>>1;
    if(playback[mid].cum < target) lo=mid+1;
    else hi=mid;
  }
  const s=playback[lo];
  const prev=lo===0 ? 0 : playback[lo-1].cum;
  const u = s.len===0 ? 0 : (target - prev)/s.len;

  return { x: s.a.x + (s.b.x-s.a.x)*u, y: s.a.y + (s.b.y-s.a.y)*u, mode: s.mode };
}

// ----- Render NC with highlight -----
function escapeHtml(s){
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function renderNC(highlightLineIndex = -1){
  const box = $("ncBox");
  if(!ncLines.length){
    box.innerHTML = `<div class="line dim">NC will appear here after Build…</div>`;
    $("ncLineHud").textContent = "Line: —";
    return;
  }

  const parts = [];
  for(let i=0;i<ncLines.length;i++){
    const cls = (i===highlightLineIndex) ? "line hi" : "line dim";
    parts.push(`<div class="${cls}" data-ln="${i}">${escapeHtml(ncLines[i])}</div>`);
  }
  box.innerHTML = parts.join("");

  if(highlightLineIndex >= 0){
    $("ncLineHud").textContent = `Line: ${highlightLineIndex + 1}`;
    const el = box.querySelector(`[data-ln="${highlightLineIndex}"]`);
    if(el) el.scrollIntoView({block:"center"});
  } else {
    $("ncLineHud").textContent = "Line: —";
  }
}

function setStepToPlaybackIndex(playIdx){
  // convert playback index -> scrub fraction
  if(!playback.length) return;
  const total = playback[playback.length-1].cum || 1;
  const targetCum = playback[playIdx].cum;
  const t = Math.min(1, Math.max(0, targetCum / total));
  $("scrub").value = String(t);
  draw();
}

// Build motion stepping arrays:
// motion steps = playback segments (each corresponds to a motion move) + their NC line
function rebuildMotionSteps(moveToNcLine){
  motionLineIdxs = [];
  motionCum = [];

  for(const seg of playback){
    const ln = moveToNcLine.get(seg.moveIdx);
    if(typeof ln === "number"){
      motionLineIdxs.push(ln);
      motionCum.push(seg.cum);
    }
  }
  stepPtr = -1;
  renderNC(-1);
}

// Step forward to next motion
function stepOnce(){
  if(!playback.length || !motionLineIdxs.length) return;

  stepPtr = Math.min(motionLineIdxs.length - 1, stepPtr + 1);

  // find playback index for this stepPtr (1:1)
  const playIdx = stepPtr; // because arrays built from playback in order
  setStepToPlaybackIndex(playIdx);

  const ln = motionLineIdxs[stepPtr];
  renderNC(ln);
}

// ----- Drawing -----
function resize(){
  const dpr=window.devicePixelRatio||1;
  const r=canvas.getBoundingClientRect();
  canvas.width=Math.max(1,Math.floor(r.width*dpr));
  canvas.height=Math.max(1,Math.floor(r.height*dpr));
  ctx.setTransform(dpr,0,0,dpr,0,0);
  draw();
}
window.addEventListener("resize", resize);

function worldToScreen(p){ return { x: p.x*view.scale + view.ox, y: -p.y*view.scale + view.oy }; }
function screenToWorld(x,y){ return { x:(x-view.ox)/view.scale, y:-(y-view.oy)/view.scale }; }

function fitViewToSegments(segs){
  if(!segs.length) return;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const s of segs){
    minX=Math.min(minX,s.a.x,s.b.x);
    minY=Math.min(minY,s.a.y,s.b.y);
    maxX=Math.max(maxX,s.a.x,s.b.x);
    maxY=Math.max(maxY,s.a.y,s.b.y);
  }
  const r=canvas.getBoundingClientRect();
  const w=r.width,h=r.height;
  const pad=30;
  const bw=(maxX-minX)||1;
  const bh=(maxY-minY)||1;
  view.scale = Math.min((w-pad*2)/bw,(h-pad*2)/bh);
  const cx=(minX+maxX)/2;
  const cy=(minY+maxY)/2;
  view.ox = w/2 - cx*view.scale;
  view.oy = h/2 + cy*view.scale;
}

function clear(){
  const r=canvas.getBoundingClientRect();
  ctx.clearRect(0,0,r.width,r.height);
}
function drawGrid(){
  const r=canvas.getBoundingClientRect();
  const w=r.width,h=r.height;
  ctx.save();
  ctx.strokeStyle="rgba(255,255,255,0.05)";
  ctx.lineWidth=1;
  const step=50;
  for(let x=0;x<=w;x+=step){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
  for(let y=0;y<=h;y+=step){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
  const o=worldToScreen({x:0,y:0});
  ctx.strokeStyle="rgba(255,255,255,0.2)";
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
function drawToolpath(){
  if(!playback.length) return;

  ctx.save();
  ctx.strokeStyle="rgba(122,167,255,0.65)";
  ctx.lineWidth=2;
  ctx.setLineDash([6,6]);
  for(const s of playback){
    if(s.mode!=="RAPID") continue;
    const a=worldToScreen(s.a), b=worldToScreen(s.b);
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.strokeStyle="rgba(255,122,122,0.92)";
  ctx.lineWidth=2;
  ctx.setLineDash([]);
  for(const s of playback){
    if(s.mode!=="CUT") continue;
    const a=worldToScreen(s.a), b=worldToScreen(s.b);
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
  }
  ctx.restore();
}
function drawToolDot(){
  const t=Number($("scrub").value);
  const p=pointAtT(t);
  if(!p) return;
  const sp=worldToScreen({x:p.x,y:p.y});
  ctx.save();
  ctx.fillStyle = p.mode==="CUT" ? "rgba(255,122,122,0.95)" : "rgba(122,167,255,0.95)";
  ctx.beginPath(); ctx.arc(sp.x,sp.y,6,0,Math.PI*2); ctx.fill();
  ctx.restore();
  $("hudPos").textContent=`XY: ${p.x.toFixed(3)} ${p.y.toFixed(3)} in`;
  $("hudMode").textContent=`Mode: ${p.mode}`;
}
function draw(){
  clear();
  drawGrid();

  if(playback.length){
    drawToolpath();
    drawToolDot();
  } else {
    drawPreviewGeometry();
    $("hudPos").textContent="XY: —";
    $("hudMode").textContent="Mode: Preview";
  }
}

// ----- Pan/Zoom -----
canvas.addEventListener("mousedown",(e)=>{ view.dragging=true; view.lx=e.clientX; view.ly=e.clientY; });
window.addEventListener("mouseup",()=>{ view.dragging=false; });
window.addEventListener("mousemove",(e)=>{
  if(!view.dragging) return;
  view.ox += (e.clientX - view.lx);
  view.oy += (e.clientY - view.ly);
  view.lx=e.clientX; view.ly=e.clientY;
  draw();
});
canvas.addEventListener("wheel",(e)=>{
  e.preventDefault();
  const r=canvas.getBoundingClientRect();
  const mx=e.clientX-r.left, my=e.clientY-r.top;
  const before=screenToWorld(mx,my);
  const zoom=Math.exp(-e.deltaY*0.001);
  view.scale*=zoom;
  const after=screenToWorld(mx,my);
  view.ox += (before.x-after.x)*view.scale;
  view.oy -= (before.y-after.y)*view.scale;
  draw();
},{passive:false});

// ----- UI wiring -----
$("file").addEventListener("change", async (e)=>{
  const f=e.target.files?.[0];
  if(!f) return;

  setStatus("warn","Loading…", f.name);

  try{
    const text = await f.text();
    const parser=new window.DxfParser();
    dxfParsed = parser.parseSync(text);
  }catch(err){
    console.error(err);
    setStatus("bad","DXF parse failed","Try exporting as R12 / ASCII DXF.");
    alert("DXF parse failed. Try exporting as R12 / ASCII DXF.");
    return;
  }

  const opts=readOpts();
  let segs = extractSegments(dxfParsed);

  if(!segs.length){
    setStatus("bad","No supported geometry","Need LINE / POLYLINE / SPLINE points.");
    alert("No usable geometry extracted. Re-export DXF as R12/ASCII or explode polylines.");
    return;
  }

  segs = applyOriginShift(segs, opts.origin);
  previewSegs = segs.map(s=>({a:s.a,b:s.b}));

  playback = [];
  moves = [];
  lastNC = "";
  ncLines = [];
  motionLineIdxs = [];
  motionCum = [];
  stepPtr = -1;

  $("buildToolpath").disabled = false;
  $("download").disabled = true;
  $("copyNC").disabled = true;
  $("fit").disabled = false;
  $("step").disabled = true;
  $("play").disabled = true;
  $("pause").disabled = true;
  $("scrub").disabled = true;
  $("scrub").value = "0";

  renderNC(-1);
  fitViewToSegments(previewSegs);
  setStatus("good","Loaded", `Segments extracted: ${segs.length}. Click Build.`);
  draw();
});

$("buildToolpath").addEventListener("click", ()=>{
  if(!dxfParsed){
    alert("Import a DXF first.");
    return;
  }

  try{
    setStatus("warn","Building…","Chaining + NC + step map");
    const opts=readOpts();

    let segs = extractSegments(dxfParsed);
    segs = applyOriginShift(segs, opts.origin);
    const lines = segs.filter(s=>s.kind==="line");

    let paths = buildPathsFromLines(lines, opts.snapGrid, opts.angleTolDeg, opts.outPrec);
    paths = orderPathsNearest(paths);
    paths = mergeContinuousPaths(paths, opts.chainTol);

    if(!paths.length){
      setStatus("bad","Build produced 0 paths","Try Snap Grid 0.01, Angle Tol 20, Output Prec 0.005");
      alert("No paths created. Try:\n- Snap Grid 0.01\n- Output Prec 0.005\n- Angle Tol 20");
      return;
    }

    moves = buildMoves(paths, opts);

    const { ncText, lines: linesArr, moveToNcLine } = buildNCWithMap(moves, opts);
    lastNC = ncText;
    ncLines = linesArr;

    playback = buildPlayback(moves);
    rebuildMotionSteps(moveToNcLine);

    $("download").disabled = false;
    $("copyNC").disabled = false;
    $("step").disabled = false;
    $("play").disabled = false;
    $("pause").disabled = false;
    $("scrub").disabled = false;
    $("scrub").value = "0";
    playing = false;

    renderNC(-1);

    const ncCount = ncLines.length;
    setStatus("good","Built", `Paths: ${paths.length} | NC lines: ${ncCount} | Step: ${motionLineIdxs.length} moves`);
    draw();
  }catch(err){
    console.error(err);
    setStatus("bad","Build failed", err?.message || String(err));
    alert(`Build failed:\n${err?.message || String(err)}`);
  }
});

$("download").addEventListener("click", ()=>{
  if(!lastNC) return;
  const blob=new Blob([lastNC],{type:"text/plain"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download="output.nc";
  a.click();
  URL.revokeObjectURL(a.href);
});

$("copyNC").addEventListener("click", async ()=>{
  if(!lastNC) return;
  try{
    await navigator.clipboard.writeText(lastNC);
    setStatus("good","Copied","NC copied to clipboard");
  }catch{
    alert("Copy failed. You can still select/copy from the NC panel.");
  }
});

$("fit").addEventListener("click", ()=>{
  if(playback.length){
    const segs = playback.map(s=>({a:s.a,b:s.b}));
    fitViewToSegments(segs);
  } else {
    fitViewToSegments(previewSegs);
  }
  draw();
});

$("origin").addEventListener("change", ()=>{
  if(!dxfParsed) return;
  const opts=readOpts();
  let segs = extractSegments(dxfParsed);
  if(!segs.length) return;
  segs = applyOriginShift(segs, opts.origin);
  previewSegs = segs.map(s=>({a:s.a,b:s.b}));

  playback=[]; moves=[]; lastNC="";
  ncLines=[]; motionLineIdxs=[]; motionCum=[]; stepPtr=-1;

  $("download").disabled=true;
  $("copyNC").disabled=true;
  $("step").disabled=true;
  $("play").disabled=true;
  $("pause").disabled=true;
  $("scrub").disabled=true;
  $("scrub").value="0";

  renderNC(-1);

  fitViewToSegments(previewSegs);
  setStatus("warn","Origin changed","Preview updated — rebuild toolpath for NC");
  draw();
});

// Step button + hotkey S
$("step").addEventListener("click", ()=>{
  playing = false;
  stepOnce();
});
window.addEventListener("keydown", (e)=>{
  if(e.key === "s" || e.key === "S"){
    if($("step").disabled) return;
    // don’t trigger while typing in inputs
    const t = document.activeElement?.tagName?.toLowerCase();
    if(t === "input" || t === "select" || t === "textarea") return;
    e.preventDefault();
    playing = false;
    stepOnce();
  }
});

$("play").addEventListener("click", ()=>{ if(playback.length) playing=true; });
$("pause").addEventListener("click", ()=>{ playing=false; });
$("scrub").addEventListener("input", ()=>{
  playing=false;
  draw();
  // when scrubbing manually, turn off highlight (keeps it simple)
  renderNC(-1);
  $("ncLineHud").textContent = "Line: —";
});

function tick(){
  if(playing && playback.length){
    let v=Number($("scrub").value);
    v += 0.003;
    if(v>=1){ v=1; playing=false; }
    $("scrub").value = String(v);
    draw();
  }
  requestAnimationFrame(tick);
}

function init(){
  const r=canvas.getBoundingClientRect();
  view.ox = r.width/2;
  view.oy = r.height/2;
  renderNC(-1);
  setStatus("warn","Idle","Import a DXF to begin.");
  resize();
  tick();
}
init();
