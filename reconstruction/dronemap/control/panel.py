"""The operator panel: a single self-contained HTML page served at ``/``.

One window, everything: LIVE mode with raw video / depth-map / 3D point-cloud
feeds, OFFLINE photogrammetry (over a stored session, or a fresh recording)
with phase progress, and a results list with download buttons. The 3D view is
a dependency-free WebGL point renderer so the page works with no internet.
"""

PANEL_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dronemap</title>
<style>
  :root {
    --bg: #10161B; --panel: #171F26; --line: #2A3843;
    --ink: #DFE7EC; --muted: #8DA0AF;
    --good: #35C4B5; --warn: #E0A458; --bad: #E06C5B;
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--ink);
         font: 15px/1.5 system-ui, sans-serif; padding: 1.1rem; }
  main { max-width: 72rem; margin: 0 auto; display: grid; gap: 1rem; }
  h1 { font-size: 1.05rem; letter-spacing: .08em; font-weight: 700; }
  h2 { font-size: .76rem; letter-spacing: .1em; text-transform: uppercase;
       color: var(--muted); font-weight: 700; margin-bottom: .6rem; }
  .row { display: flex; gap: .8rem; flex-wrap: wrap; align-items: center; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  @media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
  .card { background: var(--panel); border: 1px solid var(--line);
          border-radius: 12px; padding: 1rem 1.1rem; }
  .chip { padding: .2rem .8rem; border-radius: 99px; font-weight: 700;
          background: var(--bg); border: 1px solid var(--line); font-size: .85rem; }
  .chip.run  { color: var(--good); border-color: var(--good); }
  .chip.idle { color: var(--muted); }
  .chip.lost { color: var(--bad); border-color: var(--bad); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr)); gap: .6rem; margin: .8rem 0; }
  .tile { background: var(--bg); border: 1px solid var(--line);
          border-radius: 9px; padding: .45rem .75rem; }
  .tile .k { color: var(--muted); font-size: .66rem; text-transform: uppercase; letter-spacing: .07em; }
  .tile .v { font-size: 1.2rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .bar { display: flex; height: 10px; border-radius: 5px; overflow: hidden;
         background: var(--line); margin: .4rem 0; }
  .bar div { height: 100%; }
  .legend { display: flex; gap: .9rem; flex-wrap: wrap; font-size: .74rem; color: var(--muted); }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: .3rem; }
  select, button, input {
    font: inherit; border-radius: 9px; border: 1px solid var(--line);
    background: var(--bg); color: var(--ink); padding: .5rem .85rem;
  }
  input[type=number] { width: 5.5rem; }
  button { font-weight: 700; cursor: pointer; border: 0; }
  button.primary { background: var(--good); color: #08211E; }
  button.danger  { background: var(--bad); color: #2A0F0A; }
  button.ghost   { background: var(--bg); border: 1px solid var(--line); color: var(--ink); }
  button:disabled { opacity: .35; cursor: default; }
  .msg { color: var(--muted); font-size: .82rem; min-height: 1.1em; }
  .feeds { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: .8rem; }
  @media (max-width: 900px) { .feeds { grid-template-columns: 1fr; } }
  .feed { background: var(--bg); border: 1px solid var(--line); border-radius: 10px;
          overflow: hidden; position: relative; aspect-ratio: 16/9; }
  .feed img, .feed canvas { width: 100%; height: 100%; object-fit: contain; display: block; }
  .feed .tag { position: absolute; top: .4rem; left: .55rem; font-size: .68rem;
               font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
               color: var(--muted); background: rgba(16,22,27,.75);
               padding: .1rem .5rem; border-radius: 6px; }
  .phase { display: flex; align-items: center; gap: .6rem; margin-top: .6rem; font-size: .9rem; }
  .spin { width: 14px; height: 14px; border: 2px solid var(--line);
          border-top-color: var(--good); border-radius: 50%;
          animation: spin .9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
  .grade { font-weight: 800; }
  .grade.GOOD { color: var(--good); }
  .grade.PARTIAL { color: var(--warn); }
  .grade.FRAGMENTED, .grade.FAILED { color: var(--bad); }
  a.dl { color: var(--good); text-decoration: none; font-weight: 700; margin-right: .6rem; }
  a.dl:hover { text-decoration: underline; }
  .files { line-height: 1.9; }
  details summary { cursor: pointer; font-weight: 600; padding: .3rem 0; }
  fieldset { border: 1px solid var(--line); border-radius: 9px;
             padding: .7rem .9rem; margin-top: .7rem; }
  legend { font-size: .74rem; color: var(--muted); text-transform: uppercase;
           letter-spacing: .08em; padding: 0 .4rem; }
</style>
</head>
<body>
<main>
  <div class="row" style="justify-content: space-between">
    <h1>DRONEMAP</h1>
    <div class="row">
      <label class="msg" for="device">camera</label>
      <select id="device"></select>
    </div>
  </div>

  <!-- LIVE -->
  <section class="card">
    <div class="row" style="justify-content: space-between">
      <h2 style="margin:0">Live reconstruction</h2>
      <div class="row">
        <span class="chip idle" id="state">…</span>
        <button class="primary" id="btn-start">Start</button>
        <button class="danger" id="btn-stop">Stop &amp; export</button>
        <button class="ghost" id="btn-viewer" title="full-detail 3D window (Rerun): image, depth, frusta, timeline">Open 3D viewer</button>
      </div>
    </div>
    <div class="grid">
      <div class="tile"><div class="k">Tracking</div><div class="v" id="tracking">–</div></div>
      <div class="tile"><div class="k">Keyframes</div><div class="v" id="kf">–</div></div>
      <div class="tile"><div class="k">FPS</div><div class="v" id="fps">–</div></div>
      <div class="tile"><div class="k">GPU</div><div class="v" id="vram">–</div></div>
      <div class="tile"><div class="k">Points</div><div class="v" id="npts">–</div></div>
    </div>
    <div class="bar" id="gatebar"></div>
    <div class="legend" style="margin-bottom:.8rem">
      <span><span class="dot" style="background:var(--good)"></span>moving</span>
      <span><span class="dot" style="background:var(--warn)"></span>rotating</span>
      <span><span class="dot" style="background:var(--bad)"></span>lost — slow down</span>
      <span><span class="dot" style="background:var(--line)"></span>idle</span>
    </div>
    <div class="feeds" id="feeds" hidden>
      <div class="feed"><span class="tag">camera</span><img id="feed-video" alt="live camera"></div>
      <div class="feed"><span class="tag">depth</span><img id="feed-depth" alt="depth map"></div>
      <div class="feed"><span class="tag">3d map — drag to orbit</span><canvas id="cloud"></canvas></div>
    </div>
    <div class="msg" id="live-msg"></div>
  </section>

  <!-- OFFLINE -->
  <section class="card">
    <h2>Photogrammetry (optional post-processing)</h2>
    <p class="msg">Highest-quality reconstruction, done after capture. Every
    live session already stores its frames — pick one and process it, no
    re-recording needed.</p>
    <fieldset>
      <legend>From a stored session</legend>
      <div class="row">
        <select id="session"></select>
        <button class="primary" id="btn-scan-session">Process</button>
      </div>
    </fieldset>
    <fieldset>
      <legend>Or record a fresh clip (needs the camera; live must be stopped)</legend>
      <div class="row">
        <label class="msg" for="secs">length</label>
        <input type="number" id="secs" value="60" min="10" max="600" step="10"> s
        <button class="ghost" id="btn-scan-record">Record &amp; process</button>
      </div>
    </fieldset>
    <div class="phase" id="scanphase" hidden>
      <div class="spin"></div><span id="scantext"></span>
    </div>
    <div id="scanresult" style="margin-top:.6rem"></div>
  </section>

  <!-- RESULTS -->
  <section class="card">
    <h2>Results</h2>
    <div id="results" class="msg">loading…</div>
  </section>
</main>
<script>
const $ = id => document.getElementById(id);

async function post(path) {
  try {
    const r = await fetch(path, {method: "POST"});
    const j = await r.json().catch(() => ({}));
    return {ok: r.ok, msg: r.ok ? "ok" : (j.detail || "failed")};
  } catch (e) { return {ok: false, msg: "request failed"}; }
}

// ---- device + session dropdowns ----
async function loadDevices() {
  try {
    const devs = await (await fetch("/devices")).json();
    $("device").innerHTML = devs.map(d =>
      `<option value="${d.device}">${d.device.replace("/dev/","")} — ${d.name}</option>`).join("");
    let saved = null;
    try { saved = localStorage.getItem("dronemap.device"); } catch (e) {}
    if (saved && devs.some(d => d.device === saved)) $("device").value = saved;
  } catch (e) {}
}
$("device").onchange = () => {
  try { localStorage.setItem("dronemap.device", $("device").value); } catch (e) {}
};
async function loadSessions() {
  try {
    const ss = await (await fetch("/sessions_scannable")).json();
    $("session").innerHTML = ss.length
      ? ss.map(s => `<option value="${s.name}">${s.name} (${s.frames} frames)</option>`).join("")
      : "<option value=''>no stored sessions yet</option>";
  } catch (e) {}
}

// ---- live ----
let wasRunning = false;
$("btn-start").onclick = async () => {
  const r = await post("/start?device=" + encodeURIComponent($("device").value));
  $("live-msg").textContent = r.msg === "ok" ? "" : r.msg;
};
$("btn-viewer").onclick = async () => {
  const r = await post("/viewer");
  $("live-msg").textContent = r.ok ? "3D viewer opening…" : r.msg;
  setTimeout(() => $("live-msg").textContent = "", 4000);
};
$("btn-stop").onclick = async () => {
  $("live-msg").textContent = "exporting — can take a minute…";
  await post("/stop");
  setTimeout(() => { loadResults(); loadSessions(); $("live-msg").textContent = ""; }, 9000);
};

function setFeeds(on) {
  $("feeds").hidden = !on;
  const v = $("feed-video"), d = $("feed-depth");
  if (on && !v.src) { v.src = "/stream/video"; d.src = "/stream/depth"; }
  if (!on) { v.removeAttribute("src"); d.removeAttribute("src"); }
}

async function tickLive() {
  let m;
  try { m = await (await fetch("/metrics")).json(); }
  catch (e) { $("state").textContent = "offline"; $("state").className = "chip lost"; return; }
  const s = m.session || {};
  const running = s.state === "running";
  $("state").textContent = s.state || "?";
  $("state").className = "chip " + (running ? (s.tracking_state === "lost" ? "lost" : "run") : "idle");
  $("tracking").textContent = s.tracking_state || "–";
  $("tracking").style.color = s.tracking_state === "tracking" ? "var(--good)"
    : s.tracking_state === "lost" ? "var(--bad)"
    : s.tracking_state === "degraded" ? "var(--warn)" : "var(--ink)";
  $("kf").textContent = s.keyframes ?? "–";
  const ing = (m.stages || {}).ingest || {};
  $("fps").textContent = ing.fps ? ing.fps.toFixed(1) : "–";
  const gpu = m.gpu || {};
  $("vram").textContent = gpu.used_mb ? (gpu.used_mb/1024).toFixed(1)+"G" : "–";
  const g = (m.keyframe_gate || {}).reasons || {};
  const groups = [["var(--good)", g.translation||0], ["var(--warn)", g.rotation||0],
                  ["var(--bad)", g.track_loss||0], ["var(--line)", (g.timeout||0)+(g.first||0)]];
  const total = groups.reduce((a,[,n]) => a+n, 0) || 1;
  $("gatebar").innerHTML = groups.map(([c,n]) =>
    `<div style="background:${c};width:${(100*n/total).toFixed(1)}%"></div>`).join("");
  setFeeds(running);
  if (running && !wasRunning) {
    cloudTimer = setInterval(refreshCloud, 4000);
    trajTimer = setInterval(refreshTraj, 1500);
  }
  if (!running && wasRunning) {
    clearInterval(cloudTimer); clearInterval(trajTimer);
    loadResults(); loadSessions();
  }
  wasRunning = running;
}

// ---- 3D point cloud (self-contained WebGL) ----
const canvas = $("cloud");
const gl = canvas.getContext("webgl", {antialias: false});
let prog, buf, nPts = 0, center = [0,0,0], radius = 3;
let trajBuf, nTraj = 0, frusBuf, nFrus = 0;
let yaw = -0.6, pitch = 0.5, dist = 2.2;
if (gl) {
  const vs = `attribute vec3 p; attribute vec3 c; uniform mat4 mvp;
    varying vec3 vc; void main(){ gl_Position = mvp*vec4(p,1.0);
    gl_PointSize = 2.5; vc = c; }`;
  const fs = `precision mediump float; varying vec3 vc;
    void main(){ gl_FragColor = vec4(vc,1.0); }`;
  function sh(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src);
    gl.compileShader(s); return s; }
  prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog); gl.useProgram(prog);
  buf = gl.createBuffer();
  trajBuf = gl.createBuffer();
  frusBuf = gl.createBuffer();
  gl.enable(gl.DEPTH_TEST);
}
function mat_mul(a, b) {
  const o = new Float32Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++)
    for (let k = 0; k < 4; k++) o[j*4+i] += a[k*4+i]*b[j*4+k];
  return o;
}
function drawCloud() {
  if (!gl || !nPts) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  gl.viewport(0, 0, w, h);
  gl.clearColor(0.063, 0.086, 0.106, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  const d = dist * radius;
  const eye = [center[0] + d*Math.cos(pitch)*Math.sin(yaw),
               center[1] - d*Math.sin(pitch),
               center[2] + d*Math.cos(pitch)*Math.cos(yaw)];
  // lookAt
  let zx = eye[0]-center[0], zy = eye[1]-center[1], zz = eye[2]-center[2];
  let zl = Math.hypot(zx,zy,zz); zx/=zl; zy/=zl; zz/=zl;
  const upx = 0, upy = -1, upz = 0;  // Y-down world (OpenCV convention)
  let xx = upy*zz-upz*zy, xy = upz*zx-upx*zz, xz = upx*zy-upy*zx;
  let xl = Math.hypot(xx,xy,xz) || 1; xx/=xl; xy/=xl; xz/=xl;
  const yx = zy*xz-zz*xy, yy = zz*xx-zx*xz, yz = zx*xy-zy*xx;
  const view = new Float32Array([xx,yx,zx,0, xy,yy,zy,0, xz,yz,zz,0,
    -(xx*eye[0]+xy*eye[1]+xz*eye[2]), -(yx*eye[0]+yy*eye[1]+yz*eye[2]),
    -(zx*eye[0]+zy*eye[1]+zz*eye[2]), 1]);
  const f = 1/Math.tan(0.4), asp = w/h, near = 0.01, far = radius*40;
  const projM = new Float32Array([f/asp,0,0,0, 0,f,0,0,
    0,0,(far+near)/(near-far),-1, 0,0,2*far*near/(near-far),0]);
  gl.uniformMatrix4fv(gl.getUniformLocation(prog,"mvp"), false, mat_mul(projM, view));
  const ap = gl.getAttribLocation(prog, "p"), ac = gl.getAttribLocation(prog, "c");
  function bindAndDraw(b, n, mode) {
    if (!n) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(ac); gl.vertexAttribPointer(ac, 3, gl.FLOAT, false, 24, 12);
    gl.drawArrays(mode, 0, n);
  }
  bindAndDraw(buf, nPts, gl.POINTS);
  bindAndDraw(trajBuf, nTraj, gl.LINE_STRIP);
  bindAndDraw(frusBuf, nFrus, gl.LINES);
}

function packLine(pts, color) {
  const a = new Float32Array(pts.length * 6);
  pts.forEach((pt, i) => {
    a[i*6] = pt[0]; a[i*6+1] = pt[1]; a[i*6+2] = pt[2];
    a[i*6+3] = color[0]; a[i*6+4] = color[1]; a[i*6+5] = color[2];
  });
  return a;
}

async function refreshTraj() {
  if (!gl) return;
  let t;
  try { t = await (await fetch("/trajectory")).json(); } catch (e) { return; }
  if (!t.traj || t.traj.length < 2) { nTraj = 0; nFrus = 0; return; }
  gl.bindBuffer(gl.ARRAY_BUFFER, trajBuf);
  gl.bufferData(gl.ARRAY_BUFFER, packLine(t.traj, [0.31, 0.78, 1.0]), gl.DYNAMIC_DRAW);
  nTraj = t.traj.length;
  if (t.last_T) {
    // camera frustum wireframe at the latest pose
    const T = t.last_T, sc = Math.max(0.15, radius * 0.12);
    const loc = [[0,0,0], [-0.6,-0.4,1], [0.6,-0.4,1], [0.6,0.4,1], [-0.6,0.4,1]]
      .map(v => v.map(x => x * sc));
    const w = loc.map(v => [
      T[0][0]*v[0]+T[0][1]*v[1]+T[0][2]*v[2]+T[0][3],
      T[1][0]*v[0]+T[1][1]*v[1]+T[1][2]*v[2]+T[1][3],
      T[2][0]*v[0]+T[2][1]*v[1]+T[2][2]*v[2]+T[2][3]]);
    const edges = [[0,1],[0,2],[0,3],[0,4],[1,2],[2,3],[3,4],[4,1]]
      .flatMap(([a2,b2]) => [w[a2], w[b2]]);
    gl.bindBuffer(gl.ARRAY_BUFFER, frusBuf);
    gl.bufferData(gl.ARRAY_BUFFER, packLine(edges, [1.0, 0.72, 0.35]), gl.DYNAMIC_DRAW);
    nFrus = edges.length;
  }
  drawCloud();
}
let drag = null;
canvas.addEventListener("pointerdown", e => { drag = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener("pointermove", e => {
  if (!drag) return;
  yaw += (e.clientX - drag[0]) * 0.008;
  pitch = Math.max(-1.5, Math.min(1.5, pitch + (e.clientY - drag[1]) * 0.008));
  drag = [e.clientX, e.clientY]; drawCloud();
});
canvas.addEventListener("pointerup", () => drag = null);
canvas.addEventListener("wheel", e => { e.preventDefault();
  dist = Math.max(0.2, Math.min(8, dist * (e.deltaY > 0 ? 1.12 : 0.9))); drawCloud(); }, {passive: false});

let cloudTimer = null, trajTimer = null;
async function refreshCloud() {
  if (!gl) return;
  let d;
  try { d = await (await fetch("/map/preview?max_points=60000")).json(); }
  catch (e) { return; }
  if (!d.n) return;
  nPts = d.n;
  $("npts").textContent = d.n >= 1000 ? (d.n/1000).toFixed(0)+"k" : d.n;
  const arr = new Float32Array(d.n * 6);
  const xyz = d.xyz, rgb = d.rgb;
  let mn = [1e9,1e9,1e9], mx = [-1e9,-1e9,-1e9];
  for (let i = 0; i < d.n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = xyz[i][k];
      arr[i*6+k] = v;
      if (v < mn[k]) mn[k] = v;
      if (v > mx[k]) mx[k] = v;
      arr[i*6+3+k] = rgb ? rgb[i][k]/255 : 0.8;
    }
  }
  center = [(mn[0]+mx[0])/2, (mn[1]+mx[1])/2, (mn[2]+mx[2])/2];
  radius = Math.max(0.5, Math.hypot(mx[0]-mn[0], mx[1]-mn[1], mx[2]-mn[2]) / 2);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW);
  drawCloud();
}

// ---- offline scan ----
let scanWasRunning = false;
$("btn-scan-session").onclick = async () => {
  const name = $("session").value;
  if (!name) return;
  const r = await post("/scan_session?name=" + encodeURIComponent(name));
  $("scanresult").innerHTML = r.ok ? "" : `<span class="msg">${r.msg}</span>`;
};
$("btn-scan-record").onclick = async () => {
  const dev = encodeURIComponent($("device").value);
  const secs = Math.max(10, Math.min(600, parseInt($("secs").value) || 60));
  const r = await post(`/scan?device=${dev}&seconds=${secs}`);
  $("scanresult").innerHTML = r.ok ? "" : `<span class="msg">${r.msg}</span>`;
};
function fmtElapsed(sec) {
  if (sec == null) return "";
  const m = Math.floor(sec / 60), s2 = Math.floor(sec % 60);
  return m ? `${m}m ${s2}s` : `${s2}s`;
}
function renderScan(st) {
  if (st.state === "done" && st.result) {
    const g = st.result.sfm.grade;
    const dense = st.result.dense
      ? ` · dense: ${st.result.dense.points.toLocaleString()} points`
      : "";
    const t = st.elapsed ? ` (took ${fmtElapsed(st.elapsed)})` : "";
    $("scanresult").innerHTML =
      `<span class="grade ${g}">${g}</span> — ${st.result.sfm.registered}/${st.result.sfm.images} frames connected${dense}${t}. Files in Results.`;
  } else if (st.state === "failed") {
    $("scanresult").innerHTML = `<span class="grade FAILED">FAILED</span> — ${st.detail}`;
  }
}
async function tickScan() {
  let st;
  try { st = await (await fetch("/scan/status")).json(); } catch (e) { return; }
  const active = st.state === "running";
  $("scanphase").hidden = !active;
  $("btn-scan-session").disabled = active;
  $("btn-scan-record").disabled = active;
  if (active) {
    scanWasRunning = true;
    $("scantext").textContent = st.phase
      + (st.detail ? " — " + st.detail : "")
      + "  ·  " + fmtElapsed(st.elapsed) + " elapsed";
  } else {
    // Render the latest outcome unconditionally, so a page refresh (or a scan
    // finished while the tab was closed) still shows the result.
    renderScan(st);
    if (scanWasRunning) { scanWasRunning = false; loadResults(); }
  }
}

// ---- results ----
async function loadResults() {
  let rs;
  try { rs = await (await fetch("/results")).json(); } catch (e) { return; }
  if (!rs.length) { $("results").textContent = "no results yet"; return; }
  $("results").innerHTML = rs.map((r, i) => `
    <details ${i === 0 ? "open" : ""}>
      <summary>${r.kind === "live" ? "🟢 live" : "🔵 scan"} · ${r.name}</summary>
      <div class="files">` +
      r.files.map(f =>
        `<a class="dl" href="/download?path=${encodeURIComponent(f.path)}" download>${f.name}</a><span class="msg">${f.size_mb} MB</span><br>`
      ).join("") + `</div></details>`).join("");
}

loadDevices(); loadSessions(); loadResults();
tickLive(); setInterval(tickLive, 1000);
tickScan(); setInterval(tickScan, 1500);
setInterval(loadResults, 45000);
</script>
</body>
</html>"""
