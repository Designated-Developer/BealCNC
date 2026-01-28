// NorrisCAM — DXF preview + simplified toolpath + USB-ready .NC output
// Goals:
// - DXF shows immediately on import
// - Build Toolpath never silently fails (errors shown in UI + alert)
// - Tolerant "traced art" toolpath (snap + simplify) for ±0.10" work
// - Generic router G-code header/footer (G20/G90 + optional M3 S + M5/M30)

const $ = (id) => document.getElementById(id);
const canvas = $("c");
const ctx = canvas.getContext("2d");

let dxfText = null;
let dxfParsed = null;

let previewSegs = [];   // {a,b}
let playback = [];      // sim segments
let moves = [];
let lastNC = "";

let playing = false;

const view = { scale: 60, ox: 0, oy: 0, dragging: false, lx: 0, ly: 0 };

function setTopStatus(s){ $("topStatus").textContent = s; }
function setStats(s){ $("stats").textContent = s; }

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
    chainTol: Math.max(0.0005, Number($("chainTol").value || 0.02)),
    outPrec: Number($("outPrec").value || 0.01),
    snapGrid: Math.max(0.001, Number($("snapGrid").value || 0.02)),
    angleTolDeg: Math.max(1, Number($("angleTolDeg").value || 12)),
    toolComment: $("toolComment").value || "(T1 - 1/4 endmill, centerline, no comp)",
    spindleOn: $("spindleOn").checked,
    spindleS: Math.max(0, Number($("spindleS").value || 12000)),
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

function snapPoint(p, grid){
  return { x: Math.round(p.x/grid)*grid, y: Math.round(p.y/grid)*grid };
}
function samePt(a,b,tol){
  return Math.abs(a.x-b.x)<=tol && Math.abs(a.y-b.y)<=tol;
}
function collinear(a,b,c,eps){
  return Math.abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)) <= eps;
}

// ---------- Bulletproof point normalization ----------
function xyOf(pt){
  // Accept {x,y}, [x,y], {0:x,1:y}, nested {point:{x,y}}, or anything that has numeric x/y
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

// -------- DXF Extract (LINE/ARC/CIRCLE + POLYLINES + SPLINE fallback) --------
function extractSegments(dxf){
  const out = [];
  const ents = dxf?.entities || [];

  for(const e of ents){
    if(e.type === "LINE"){
      const a=xyOf(e.start), b=xyOf(e.end);
      if(a && b) out.push({kind:"line", a, b});
      continue;
    }

    if(e.type === "ARC"){
      const c=xyOf(e.center);
      const r = Number(e.radius);
      if(!c || !isFinite(r) || r<=0) continue;

      const a1=degToRad(Number(e.startAngle));
      const a2=degToRad(Number(e.endAngle));
      const a={x:c.x+r*Math.cos(a1), y:c.y+r*Math.sin(a1)};
      const b={x:c.x+r*Math.cos(a2), y:c.y+r*Math.sin(a2)};
      out.push({kind:"arc", a, b, c, r, ccw:true, a1, a2});
      continue;
    }

    if(e.type === "CIRCLE"){
      const c=xyOf(e.center);
      const r=Number(e.radius);
      if(!c || !isFinite(r) || r<=0) continue;
      const a={x:c.x+r,y:c.y}, m={x:c.x-r,y:c.y};
      out.push({kind:"arc", a, b:m, c, r, ccw:true});
      out.push({kind:"arc", a:m, b:a, c, r, ccw:true});
      continue;
    }

    if(e.type === "LWPOLYLINE" || e.type === "POLYLINE"){
      const verts = (e.vertices || [])
        .map(v => {
          const p = xyOf(v);
          if(!p) return null;
          return { x:p.x, y:p.y, bulge: Number(v.bulge || 0) };
        })
        .filter(Boolean);

      if(verts.length < 2) continue;

      for(let i=0;i<verts.length-1;i++){
        const p=verts[i], q=verts[i+1];
        if(Math.abs(p.bulge) > 1e-12) out.push(bulgeToArcSeg(p, q, p.bulge));
        else out.push({kind:"line", a:{x:p.x,y:p.y}, b:{x:q.x,y:q.y}});
      }
      if(e.closed){
        const p=verts[verts.length-1], q=verts[0];
        if(Math.abs(p.bulge) > 1e-12) out.push(bulgeToArcSeg(p, q, p.bulge));
        else out.push({kind:"line", a:{x:p.x,y:p.y}, b:{x:q.x,y:q.y}});
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

  return { kind:"arc", a:{x:x1,y:y1}, b:{x:x2,y:y2}, c:{x:cx,y:cy}, r, ccw };
}

// -------- Origin shift --------
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
function shiftSeg(s, dx, dy){
  if(s.kind==="line") return {...s, a:{x:s.a.x+dx,y:s.a.y+dy}, b:{x:s.b.x+dx,y:s.b.y+dy}};
  return {...s, a:{x:s.a.x+dx,y:s.a.y+dy}, b:{x:s.b.x+dx,y:s.b.y+dy}, c:{x:s.c.x+dx,y:s.c.y+dy}};
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

  return segs.map(s => shiftSeg(s, dx, dy));
}

// -------- Toolpath (snap + simplify, line-only, tolerant) --------
function mergeCollinear(pathSegs, tol){
  if(pathSegs.length<2) return pathSegs.slice();
  const out=[];
  const eps=Math.max(1e-12, tol*tol);
  let i=0;
  while(i<pathSegs.length){
    const s=pathSegs[i];
    let a=s.a, b=s.b;
    if(samePt(a,b,tol)){ i++; continue; }
    let j=i+1;
    while(j<pathSegs.length){
      const n=pathSegs[j];
      if(!samePt(b, n.a, tol)) break;
      if(samePt(n.a,n.b,tol)){ j++; continue; }
      if(!collinear(a,b,n.b,eps)) break;
      b=n.b; j++;
    }
    out.push({kind:"line", a,b});
    i=j;
  }
  return out;
}

function rebuildTracedPaths(segs, snapGrid, angleTolDeg, outPrec){
  const lines = segs
    .filter(s=>s.kind==="line" && s.a && s.b)
    .map(s=>({kind:"line", a:snapPoint(s.a,snapGrid), b:snapPoint(s.b,snapGrid)}))
    .filter(s=>isFinite(s.a.x)&&isFinite(s.a.y)&&isFinite(s.b.x)&&isFinite(s.b.y))
    .filter(s=>dist(s.a,s.b) >= Math.max(outPrec*0.9, snapGrid*0.5));

  const tol = snapGrid * 0.55;
  const angTol = degToRad(angleTolDeg);

  // Build adjacency on start points
  const map=new Map();
  const k=(p)=>`${Math.round(p.x/snapGrid)},${Math.round(p.y/snapGrid)}`;
  for(let i=0;i<lines.length;i++){
    const ks=k(lines[i].a);
    if(!map.has(ks)) map.set(ks,[]);
    map.get(ks).push(i);
  }

  const used=new Array(lines.length).fill(false);
  const paths=[];

  for(let i=0;i<lines.length;i++){
    if(used[i]) continue;
    used[i]=true;

    const chain=[lines[i]];
    let cur=lines[i];

    while(true){
      const end=cur.b;
      const cand=map.get(k(end))||[];
      const d0=angle(cur.a,cur.b);

      let best=-1, bestScore=Infinity;
      for(const idx of cand){
        if(used[idx]) continue;
        const s=lines[idx];
        if(!samePt(end, s.a, tol)) continue;

        const d1=angle(s.a,s.b);
        let da=Math.abs(d1-d0);
        da=Math.min(da, Math.abs(da-2*Math.PI));
        if(da<=angTol && da<bestScore){ best=idx; bestScore=da; }
      }
      if(best===-1) break;
      used[best]=true;
      chain.push(lines[best]);
      cur=lines[best];
    }

    paths.push({segments: mergeCollinear(chain, snapGrid)});
  }

  return paths;
}

function orderPathsNearest(paths){
  if(paths.length<=1) return paths;
  const remaining = paths.slice();
  const ordered = [];
  let cur = remaining.shift();
  ordered.push(cur);
  let curPt = cur.segments[cur.segments.length-1].b;

  while(remaining.length){
    let bestIdx=0, bestD=Infinity, flip=false;
    for(let i=0;i<remaining.length;i++){
      const p=remaining[i];
      const a=p.segments[0].a;
      const b=p.segments[p.segments.length-1].b;
      const dA=dist(curPt,a);
      const dB=dist(curPt,b);
      if(dA<bestD){ bestD=dA; bestIdx=i; flip=false; }
      if(dB<bestD){ bestD=dB; bestIdx=i; flip=true; }
    }
    cur = remaining.splice(bestIdx,1)[0];
    if(flip){
      cur.segments = cur.segments.slice().reverse().map(s => ({kind:"line", a:s.b, b:s.a}));
    }
    ordered.push(cur);
    curPt = cur.segments[cur.segments.length-1].b;
  }
  return ordered;
}

// -------- Moves / NC --------
function buildMoves(paths, opts){
  const m=[];
  m.push({type:"retract", z:opts.safeZ});

  const depth = Math.abs(opts.totalDepth);
  const step = opts.stepDown;
  const passCount = Math.max(1, Math.ceil(depth / step));
  const depths = [];
  for(let i=1;i<=passCount;i++) depths.push(-Math.min(depth, i*step));

  let curXY = {x:0,y:0};

  for(const passZ of depths){
    for(const p of paths){
      if(!p.segments?.length) continue;
      const start=p.segments[0].a;

      if(dist(curXY, start) > 1e-12) m.push({type:"rapidXY", x:start.x, y:start.y});
      curXY = {x:start.x, y:start.y};

      m.push({type:"plunge", z:passZ, f:opts.feedZ});
      m.push({type:"feedXY", f:opts.feedXY});

      for(const s of p.segments){
        m.push({type:"cutLine", x:s.b.x, y:s.b.y});
        curXY = {x:s.b.x, y:s.b.y};
      }
      m.push({type:"retract", z:opts.safeZ});
    }
  }
  return m;
}

function buildNC(moves, opts){
  const P = opts.outPrec;
  const g=[];
  g.push("%");
  g.push("(NorrisCAM - USB G-code)");
  g.push(opts.toolComment);
  g.push("G90 (absolute)");
  g.push("G94 (feed/min)");
  g.push("G17 (XY plane)");
  g.push("G20 (inches)");
  g.push("G40 (cancel cutter comp)");
  g.push("G49 (cancel tool length offset)");
  g.push("G54 (work offset)");

  if(opts.spindleOn && opts.spindleS > 0){
    g.push(`M3 S${Math.round(opts.spindleS)} (spindle on)`);
  }

  let lastF=null;
  let atZ=null;
  let atXY={x:null,y:null};

  const outXY=(x,y)=>`X${fmt(x,P)} Y${fmt(y,P)}`;
  const outZ=(z)=>`Z${fmt(z,P)}`;

  for(const m of moves){
    if(m.type==="retract"){
      if(atZ!==m.z){ g.push(`G0 ${outZ(m.z)}`); atZ=m.z; }
      continue;
    }
    if(m.type==="rapidXY"){
      if(atXY.x!==m.x || atXY.y!==m.y){ g.push(`G0 ${outXY(m.x,m.y)}`); atXY={x:m.x,y:m.y}; }
      continue;
    }
    if(m.type==="plunge"){
      if(lastF!==m.f){ g.push(`G1 ${outZ(m.z)} F${fmt(m.f,0.1)}`); lastF=m.f; }
      else g.push(`G1 ${outZ(m.z)}`);
      atZ=m.z;
      continue;
    }
    if(m.type==="feedXY"){
      if(lastF!==m.f){ g.push(`F${fmt(m.f,0.1)}`); lastF=m.f; }
      continue;
    }
    if(m.type==="cutLine"){
      g.push(`G1 ${outXY(m.x,m.y)}`);
      atXY={x:m.x,y:m.y};
      continue;
    }
  }

  if(opts.spindleOn) g.push("M5 (spindle stop)");
  g.push("M30 (end)");
  g.push("%");
  return g.join("\n");
}

// -------- Simulation playback --------
function buildPlayback(moves){
  const segs=[];
  let cur={x:0,y:0};
  let cum=0;

  for(const m of moves){
    if(m.type==="rapidXY" || m.type==="cutLine"){
      const mode = (m.type==="cutLine") ? "CUT" : "RAPID";
      const a={...cur}, b={x:m.x,y:m.y};
      const len=Math.hypot(b.x-a.x,b.y-a.y);
      cum+=len;
      segs.push({kind:"line",mode,a,b,len,cum});
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

// -------- Drawing / view --------
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
  ctx.strokeStyle="rgba(125,211,252,0.9)";
  ctx.lineWidth=2;
  for(const s of previewSegs){
    const a=worldToScreen(s.a), b=worldToScreen(s.b);
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
  }
  ctx.restore();
}
function drawToolpath(){
  if(!playback.length) return;

  // rapids
  ctx.save();
  ctx.strokeStyle="rgba(122,167,255,0.55)";
  ctx.lineWidth=2;
  ctx.setLineDash([6,6]);
  for(const s of playback){
    if(s.mode!=="RAPID") continue;
    const a=worldToScreen(s.a), b=worldToScreen(s.b);
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
  }
  ctx.restore();

  // cuts
  ctx.save();
  ctx.strokeStyle="rgba(255,122,122,0.9)";
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

// -------- Pan/Zoom --------
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

// -------- UI --------
$("file").addEventListener("change", async (e)=>{
  const f=e.target.files?.[0];
  if(!f) return;

  setTopStatus(`Loading ${f.name}…`);
  dxfText = await f.text();

  try{
    const parser=new window.DxfParser();
    dxfParsed = parser.parseSync(dxfText);
  }catch(err){
    console.error(err);
    alert("DXF parse failed. Try exporting as R12 / ASCII DXF.");
    setTopStatus("DXF parse failed");
    return;
  }

  const opts=readOpts();
  let segs = extractSegments(dxfParsed);
  if(!segs.length){
    alert("No usable geometry extracted. Re-export DXF as R12/ASCII or explode polylines.");
    setTopStatus("No geometry extracted");
    return;
  }

  segs = applyOriginShift(segs, opts.origin);
  previewSegs = segs.map(s=>({a:s.a,b:s.b}));

  playback = [];
  moves = [];
  lastNC = "";
  $("download").disabled = true;

  fitViewToSegments(previewSegs);
  $("fit").disabled = false;

  setTopStatus(`Loaded: ${f.name}`);
  setStats(`Preview ready. Segments extracted: ${segs.length}. Click “Build Toolpath + NC”.`);
  draw();
});

$("buildToolpath").addEventListener("click", ()=>{
  if(!dxfParsed){
    alert("Import a DXF first.");
    return;
  }

  try{
    setTopStatus("Building toolpath…");
    const opts=readOpts();

    let segs = extractSegments(dxfParsed);
    segs = applyOriginShift(segs, opts.origin);

    const paths = orderPathsNearest(
      rebuildTracedPaths(segs, opts.snapGrid, opts.angleTolDeg, opts.outPrec)
    );

    if(!paths.length){
      alert("No paths created. This DXF might be curves-only (arcs/splines). Try re-exporting as polylines.");
      setTopStatus("Build produced 0 paths");
      return;
    }

    moves = buildMoves(paths, opts);
    lastNC = buildNC(moves, opts);
    playback = buildPlayback(moves);

    $("download").disabled = false;
    $("play").disabled = false;
    $("pause").disabled = false;
    $("scrub").disabled = false;
    $("scrub").value = "0";
    playing = false;

    setTopStatus("Built toolpath");
    setStats(`Paths: ${paths.length} | NC lines: ${lastNC.split("\n").length} | Origin: ${opts.origin.toUpperCase()} | Output: inches (.nc)`);
    draw();
  }catch(err){
    console.error(err);
    setTopStatus("Build failed");
    setStats(`Build error: ${err?.message || String(err)}`);
    alert(`Build failed:\n${err?.message || String(err)}\n\n(If you want, paste this message back to me.)`);
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
  let segs = applyOriginShift(extractSegments(dxfParsed), opts.origin);
  previewSegs = segs.map(s=>({a:s.a,b:s.b}));
  playback=[]; moves=[]; lastNC="";
  $("download").disabled=true;
  $("play").disabled=true; $("pause").disabled=true; $("scrub").disabled=true;
  fitViewToSegments(previewSegs);
  setTopStatus("Origin changed (preview updated)");
  setStats("Rebuild toolpath to update the .nc output.");
  draw();
});

$("play").addEventListener("click", ()=>{ if(playback.length) playing=true; });
$("pause").addEventListener("click", ()=>{ playing=false; });
$("scrub").addEventListener("input", ()=>{ playing=false; draw(); });

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
  resize();
  const r=canvas.getBoundingClientRect();
  view.ox = r.width/2;
  view.oy = r.height/2;
  setTopStatus("Idle");
  tick();
}
init();
