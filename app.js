<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>DXF → DAT + Toolpath Verify (G20 Inches)</title>
  <style>
    :root{
      --bg:#0b0c10; --panel:#12141a; --text:#e9eef6; --muted:#9aa4b2;
      --line:#2a2f3a; --good:#4ade80; --warn:#fbbf24; --bad:#fb7185;
      --btn:#0f1117;
    }
    body{ margin:0; font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial; background:var(--bg); color:var(--text); }
    header{
      padding:14px 16px; border-bottom:1px solid var(--line);
      background:rgba(18,20,26,0.85); position:sticky; top:0; backdrop-filter: blur(10px);
      z-index:10;
    }
    header h1{ margin:0; font-size:16px; font-weight:700; }
    header p{ margin:6px 0 0; font-size:12px; color:var(--muted); line-height:1.35; }

    .wrap{ display:grid; grid-template-columns: 420px 1fr; gap:14px; padding:14px; }
    .card{ background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:12px; }
    .card h2{ margin:0 0 10px; font-size:13px; color:var(--muted); font-weight:700; }
    label{ display:block; font-size:12px; color:var(--muted); margin:10px 0 6px; }

    input, select, button{ font:inherit; }
    input[type="number"], input[type="text"], select{
      width:100%; padding:10px; border-radius:12px; border:1px solid var(--line);
      background:#0f1117; color:var(--text);
      outline:none;
    }
    input[type="file"]{ width:100%; }
    .row{ display:grid; grid-template-columns: 1fr 1fr; gap:10px; }
    .btnrow{ display:flex; gap:10px; margin-top:12px; flex-wrap:wrap; }
    button{
      padding:10px 12px; border-radius:12px; border:1px solid var(--line);
      background:var(--btn); color:var(--text); cursor:pointer;
    }
    button:disabled{ opacity:0.45; cursor:not-allowed; }

    .pillrow{ display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
    .pill{
      font-size:12px; padding:6px 10px; border-radius:999px; border:1px solid var(--line);
      background:rgba(15,17,23,0.7); color:var(--muted);
    }
    .pill.good{ color:var(--good); border-color:rgba(74,222,128,0.35); }
    .pill.warn{ color:var(--warn); border-color:rgba(251,191,36,0.35); }
    .pill.bad{ color:var(--bad); border-color:rgba(251,113,133,0.35); }

    .viewer{ position:relative; min-height: 520px; }
    canvas{
      width:100%; height: calc(100vh - 120px); min-height:520px; display:block;
      border-radius:14px; background:#07080b; border:1px solid var(--line);
    }
    .hud{
      position:absolute; left:12px; top:12px; right:12px;
      display:flex; justify-content:space-between; gap:10px; pointer-events:none;
      font-size:12px; color:var(--muted);
    }
    .hud .hudpill{
      background:rgba(18,20,26,0.7); border:1px solid var(--line);
      border-radius:999px; padding:6px 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    .slider{ display:flex; align-items:center; gap:10px; margin-top:12px; }
    input[type="range"]{ width:100%; }

    .mono{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; }
    .tiny{ font-size:11px; color:var(--muted); line-height:1.35; margin-top:8px; }

    details summary{ cursor:pointer; color:var(--muted); font-size:12px; }
    hr{ border:0; border-top:1px solid var(--line); margin:12px 0; }
  </style>
</head>
<body>
  <header>
    <h1>DXF → DAT + Toolpath Verify (Generic CNC / Inches)</h1>
    <p>
      Exports <span class="mono">G20</span> inch G-code as <span class="mono">output.dat</span>.
      Supports LINE / ARC / CIRCLE / (LW)POLYLINE (bulge arcs) + SPLINE (flattened). Origin can be auto-centered.
      Verify sim only (no stock removal).
    </p>
  </header>

  <div class="wrap">
    <div class="card">
      <h2>Inputs</h2>

      <label>DXF file</label>
      <input type="file" id="file" accept=".dxf" />

      <label style="display:flex; gap:10px; align-items:center; margin-top:12px;">
        <input type="checkbox" id="centerXY" checked />
        Center part at X0 Y0 (origin in the middle)
      </label>

      <div class="row">
        <div>
          <label>Safe Z (in)</label>
          <input type="number" id="safeZ" value="0.5" step="0.01" />
        </div>
        <div>
          <label>Cut Z (in) <span class="tiny">(typical is negative)</span></label>
          <input type="number" id="cutZ" value="-0.0625" step="0.001" />
        </div>
      </div>

      <div class="row">
        <div>
          <label>Feed XY (in/min)</label>
          <input type="number" id="feedXY" value="30" step="1" />
        </div>
        <div>
          <label>Feed Z (in/min)</label>
          <input type="number" id="feedZ" value="20" step="1" />
        </div>
      </div>

      <div class="row">
        <div>
          <label>Tool diameter (in)</label>
          <input type="number" id="toolDia" value="0.25" step="0.01" />
        </div>
        <div>
          <label>SPLINE resolution <span class="tiny">(lower = fewer segments)</span></label>
          <input type="number" id="splineStep" value="0.02" step="0.005" />
        </div>
      </div>

      <div class="row">
        <div>
          <label>Chain tolerance (in)</label>
          <input type="number" id="chainTol" value="0.001" step="0.0005" />
        </div>
        <div>
          <label>Collinear merge angle (deg)</label>
          <input type="number" id="mergeAngleDeg" value="1.0" step="0.25" />
        </div>
      </div>

      <label style="display:flex; gap:10px; align-items:center;">
        <input type="checkbox" id="mergeCollinear" checked />
        Merge collinear line segments (safe)
      </label>

      <label style="display:flex; gap:10px; align-items:center;">
        <input type="checkbox" id="hideRapids" />
        Hide rapid moves in viewer
      </label>

      <label>Tool comment</label>
      <input type="text" id="toolComment" value="(T1 - 1/4 endmill, centerline, no comp)" />

      <div class="btnrow">
        <button id="build">Build toolpath</button>
        <button id="download" disabled>Download output.dat</button>
        <button id="fit" disabled>Fit view</button>
      </div>

      <div class="slider">
        <button id="play" disabled>Play</button>
        <button id="pause" disabled>Pause</button>
        <input type="range" id="scrub" min="0" max="1" step="0.001" value="0" disabled />
      </div>

      <div class="pillrow">
        <div class="pill" id="pillEntities">Entities: —</div>
        <div class="pill" id="pillPaths">Paths: —</div>
        <div class="pill" id="pillMoves">Moves: —</div>
        <div class="pill" id="pillSize">Lines: —</div>
      </div>

      <p class="mono" id="status" style="margin:10px 0 0; color:var(--muted);">Status: idle</p>

      <hr />
      <details>
        <summary>Controls</summary>
        <ul class="tiny" style="margin:8px 0 0; padding-left:16px;">
          <li>Mouse wheel: zoom</li>
          <li>Drag: pan</li>
          <li>Fit view button: reset view</li>
        </ul>
      </details>

      <details style="margin-top:10px;">
        <summary>Output conventions</summary>
        <ul class="tiny" style="margin:8px 0 0; padding-left:16px;">
          <li>Inches: <span class="mono">G20</span></li>
          <li>Arcs: <span class="mono">G2/G3</span> with <span class="mono">I/J</span> incremental center offsets</li>
          <li>No cutter comp, no offsets</li>
          <li>Continuous paths: one plunge + one retract per path (controller-friendly)</li>
        </ul>
      </details>
    </div>

    <div class="viewer card">
      <h2>Toolpath Verify</h2>
      <div style="position:relative;">
        <canvas id="c"></canvas>
        <div class="hud">
          <div class="hudpill" id="hudPos">XY: —</div>
          <div class="hudpill" id="hudMode">Mode: —</div>
        </div>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/dxf-parser@1.1.2/dist/dxf-parser.min.js"></script>
  <script src="./app.js"></script>
</body>
</html>
