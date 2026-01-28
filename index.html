const $ = id => document.getElementById(id);
const ctx = $("c").getContext("2d");

let dxfText = "";
let paths = [];
let gcode = "";

const TOL_DIST = 0.05;     // inches
const TOL_ANGLE = 12;     // degrees

function rad(d){ return d*Math.PI/180; }

function draw(){
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,c.width,c.height);
  ctx.translate(c.width/2,c.height/2);
  ctx.scale(40,-40);

  ctx.strokeStyle="red";
  ctx.lineWidth=0.03;

  for(const p of paths){
    ctx.beginPath();
    ctx.moveTo(p[0].a.x,p[0].a.y);
    for(const s of p) ctx.lineTo(s.b.x,s.b.y);
    ctx.stroke();
  }
}

function snap(v){
  return {
    x: Math.round(v.x/TOL_DIST)*TOL_DIST,
    y: Math.round(v.y/TOL_DIST)*TOL_DIST
  };
}

function angle(a,b){
  return Math.atan2(b.y-a.y,b.x-a.x);
}

function rebuild(segs){
  const used=new Array(segs.length).fill(false);
  const out=[];

  for(let i=0;i<segs.length;i++){
    if(used[i]) continue;

    let path=[segs[i]];
    used[i]=true;

    let cur=segs[i];
    while(true){
      let found=false;
      for(let j=0;j<segs.length;j++){
        if(used[j]) continue;
        const d=Math.hypot(
          cur.b.x-segs[j].a.x,
          cur.b.y-segs[j].a.y
        );
        if(d>TOL_DIST) continue;

        const da=Math.abs(
          angle(cur.a,cur.b)-angle(segs[j].a,segs[j].b)
        );
        if(da<rad(TOL_ANGLE)){
          used[j]=true;
          path.push(segs[j]);
          cur=segs[j];
          found=true;
          break;
        }
      }
      if(!found) break;
    }
    out.push(path);
  }
  return out;
}

$("file").onchange=async e=>{
  dxfText=await e.target.files[0].text();
};

$("build").onclick=()=>{
  const parser=new DxfParser();
  const dxf=parser.parseSync(dxfText);

  let segs=[];
  for(const e of dxf.entities){
    if(e.type==="LINE"){
      segs.push({
        a:snap({x:e.start.x,y:e.start.y}),
        b:snap({x:e.end.x,y:e.end.y})
      });
    }
  }

  // center
  let minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
  for(const s of segs){
    minX=Math.min(minX,s.a.x,s.b.x);
    minY=Math.min(minY,s.a.y,s.b.y);
    maxX=Math.max(maxX,s.a.x,s.b.x);
    maxY=Math.max(maxY,s.a.y,s.b.y);
  }
  const cx=(minX+maxX)/2;
  const cy=(minY+maxY)/2;
  for(const s of segs){
    s.a.x-=cx; s.a.y-=cy;
    s.b.x-=cx; s.b.y-=cy;
  }

  paths=rebuild(segs);
  draw();
  buildGcode();
  $("download").disabled=false;
};

function buildGcode(){
  const safeZ=+$("safeZ").value;
  const cutZ=-Math.abs($("cutZ").value);
  const fxy=+$("feedXY").value;
  const fz=+$("feedZ").value;

  let g=[];
  g.push("%");
  g.push("G20 G90 G94 G17");
  g.push(`G0 Z${safeZ}`);

  for(const p of paths){
    const s=p[0].a;
    g.push(`G0 X${s.x.toFixed(3)} Y${s.y.toFixed(3)}`);
    g.push(`G1 Z${cutZ.toFixed(3)} F${fz}`);
    g.push(`F${fxy}`);
    for(const seg of p){
      g.push(`G1 X${seg.b.x.toFixed(3)} Y${seg.b.y.toFixed(3)}`);
    }
    g.push(`G0 Z${safeZ}`);
  }

  g.push("M30");
  g.push("%");
  gcode=g.join("\n");
}

$("download").onclick=()=>{
  const b=new Blob([gcode],{type:"text/plain"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(b);
  a.download="output.dat";
  a.click();
};
