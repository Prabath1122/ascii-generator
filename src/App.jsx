import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GIFEncoder, quantize, applyPalette } from "gifenc";

/* ------------------------------------------------------------------ */
/* Types & constants                                                   */
/* ------------------------------------------------------------------ */

const BG = { dark: "#0b1121", light: "#ffffff" };
const INK = { dark: "#35eac8", light: "#000000" };

const MAX_SIDE = 600; // longest side of the sampled image
const PAD = 70; // room around the image so pushed dots stay visible
const SPRING = 0.025;
const FRICTION = 0.88;
const GIF_MAX_WIDTH = 480;

function initialTheme() {
  try {
    return localStorage.getItem("portfolio-theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

const startTheme = initialTheme();

const DEFAULTS = {
  gap: 5,
  size: 2,
  radius: 80,
  force: 55,
  theme: startTheme,
  colorMode: "tone",
  ink: INK[startTheme],
  cutBackground: true,
  transparent: false,
};

/* ------------------------------------------------------------------ */
/* Particle engine (same physics as the original component)           */
/* ------------------------------------------------------------------ */

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(r, g, b) {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** Returns the background color if the image has a plain, opaque backdrop. */
function detectBackground(data, w, h) {
  const at = (x, y) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };
  const corners = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)];
  if (corners.some((c) => c[3] < 250)) return null; // already transparent
  const avg = [0, 1, 2].map((k) => corners.reduce((s, c) => s + c[k], 0) / 4);
  const spread = corners.every(
    (c) => Math.hypot(c[0] - avg[0], c[1] - avg[1], c[2] - avg[2]) < 30
  );
  return spread ? [avg[0], avg[1], avg[2]] : null;
}

function buildParticles(img, o) {
  const iw = img.naturalWidth || 600;
  const ih = img.naturalHeight || 600;
  const scale = Math.min(MAX_SIDE / iw, MAX_SIDE / ih, 2);
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));

  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const cx = c.getContext("2d", { willReadFrequently: true });
  if (!cx) return { particles: [], stage: { W: w + PAD * 2, H: h + PAD * 2 } };
  cx.drawImage(img, 0, 0, w, h);
  const data = cx.getImageData(0, 0, w, h).data;

  const bg = o.cutBackground ? detectBackground(data, w, h) : null;
  const ink = hexToRgb(o.ink);
  const particles = [];

  for (let y = 0; y < h; y += o.gap) {
    for (let x = 0; x < w; x += o.gap) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const alpha = data[i + 3] / 255;
      if (alpha < 0.1) continue;
      if (bg && Math.hypot(r - bg[0], g - bg[1], b - bg[2]) < 48) continue;

      const lum = (r + g + b) / 3 / 255;
      let a = alpha;
      let pr = r;
      let pg = g;
      let pb = b;

      if (o.colorMode === "tone") {
        // dark theme: bright pixels glow; light theme: dark pixels print heavier
        a = alpha * (o.theme === "dark" ? 0.2 + 0.8 * lum : 0.2 + 0.8 * (1 - lum));
        [pr, pg, pb] = ink;
      }
      a = Math.min(1, Math.max(0.03, a));

      const ox = PAD + x;
      const oy = PAD + y;
      particles.push({
        ox,
        oy,
        x: ox,
        y: oy,
        vx: 0,
        vy: 0,
        r: pr,
        g: pg,
        b: pb,
        a,
        fill: `rgba(${pr},${pg},${pb},${a.toFixed(3)})`,
      });
    }
  }

  return { particles, stage: { W: w + PAD * 2, H: h + PAD * 2 } };
}

function step(ps, mx, my, radius, force) {
  for (const p of ps) {
    const dx = p.x - mx;
    const dy = p.y - my;
    const d = Math.hypot(dx, dy);

    // push away from the pointer
    if (d < radius && d > 0.01) {
      const k = ((1 - d / radius) * force * 0.12) / d;
      p.vx += dx * k;
      p.vy += dy * k;
    }
    // spring back to origin
    p.vx += (p.ox - p.x) * SPRING;
    p.vy += (p.oy - p.y) * SPRING;
    // friction
    p.vx *= FRICTION;
    p.vy *= FRICTION;
    p.x += p.vx;
    p.y += p.vy;
  }
}

function draw(ctx, ps, size, bg, rest, W, H) {
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.clearRect(0, 0, W, H);
  }
  for (const p of ps) {
    ctx.fillStyle = p.fill;
    ctx.fillRect(rest ? p.ox : p.x, rest ? p.oy : p.y, size, size);
  }
}

/* ------------------------------------------------------------------ */
/* Exporters                                                           */
/* ------------------------------------------------------------------ */

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function flatten(ps) {
  const out = [];
  for (const p of ps) out.push(p.ox, p.oy, p.r, p.g, p.b, Math.round(p.a * 255));
  return out;
}

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Standalone page: canvas + the same physics. Reacts to mouse hover and touch. */
function buildHtml(ps, st, s, title) {
  const bg = s.transparent ? null : BG[s.theme];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
html,body{margin:0;height:100%;background:${bg ?? "transparent"}}
body{display:grid;place-items:center}
canvas{display:block;width:100%;max-width:${st.W}px;height:auto;touch-action:none;cursor:crosshair}
</style>
</head>
<body>
<canvas id="c"></canvas>
<script>
(function(){
var D=${JSON.stringify(flatten(ps))},W=${st.W},H=${st.H},S=${s.size},R=${s.radius},F=${s.force},BG=${JSON.stringify(bg)};
var cv=document.getElementById("c"),ctx=cv.getContext("2d");
var dpr=Math.min(window.devicePixelRatio||1,2);
cv.width=Math.round(W*dpr);cv.height=Math.round(H*dpr);
cv.style.aspectRatio=W+" / "+H;
var n=D.length/6,ox=new Float32Array(n),oy=new Float32Array(n),x=new Float32Array(n),y=new Float32Array(n),vx=new Float32Array(n),vy=new Float32Array(n),fill=new Array(n);
for(var i=0;i<n;i++){var k=i*6;ox[i]=x[i]=D[k];oy[i]=y[i]=D[k+1];fill[i]="rgba("+D[k+2]+","+D[k+3]+","+D[k+4]+","+(D[k+5]/255).toFixed(3)+")";}
var mx=-1e3,my=-1e3;
function aim(e){var r=cv.getBoundingClientRect();mx=(e.clientX-r.left)*W/r.width;my=(e.clientY-r.top)*H/r.height;}
function away(){mx=-1e3;my=-1e3;}
cv.addEventListener("pointermove",aim);
cv.addEventListener("pointerdown",aim);
cv.addEventListener("pointerleave",away);
cv.addEventListener("pointercancel",away);
cv.addEventListener("pointerup",function(e){if(e.pointerType==="touch")away();});
function frame(){
  ctx.setTransform(dpr,0,0,dpr,0,0);
  if(BG){ctx.fillStyle=BG;ctx.fillRect(0,0,W,H);}else{ctx.clearRect(0,0,W,H);}
  for(var i=0;i<n;i++){
    var dx=x[i]-mx,dy=y[i]-my,d=Math.hypot(dx,dy);
    if(d<R&&d>0.01){var q=(1-d/R)*F*0.12/d;vx[i]+=dx*q;vy[i]+=dy*q;}
    vx[i]+=(ox[i]-x[i])*${SPRING};vy[i]+=(oy[i]-y[i])*${SPRING};
    vx[i]*=${FRICTION};vy[i]*=${FRICTION};
    x[i]+=vx[i];y[i]+=vy[i];
    ctx.fillStyle=fill[i];ctx.fillRect(x[i],y[i],S,S);
  }
  requestAnimationFrame(frame);
}
frame();
})();
</script>
</body>
</html>`;
}

/** Interactive SVG: one <rect> per dot plus a tiny script. Open it directly in a browser (or via <object>/<iframe>). */
function buildSvg(ps, st, s) {
  const bg = s.transparent ? null : BG[s.theme];
  const tone = s.colorMode === "tone";
  const dots = ps
    .map((p) =>
      tone
        ? `<rect x="${p.ox}" y="${p.oy}" width="${s.size}" height="${s.size}" fill-opacity="${p.a.toFixed(2)}"/>`
        : `<rect x="${p.ox}" y="${p.oy}" width="${s.size}" height="${s.size}" fill="${toHex(p.r, p.g, p.b)}"${
            p.a < 0.99 ? ` fill-opacity="${p.a.toFixed(2)}"` : ""
          }/>`
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${st.W} ${st.H}" width="${st.W}" height="${st.H}" style="touch-action:none">
<rect width="${st.W}" height="${st.H}" fill="${bg ?? "none"}" pointer-events="all"/>
<g id="p"${tone ? ` fill="${s.ink}"` : ""}>${dots}</g>
<script><![CDATA[
(function(){
var svg=document.documentElement,els=document.getElementById("p").children,n=els.length;
var R=${s.radius},F=${s.force};
var ox=[],oy=[],x=[],y=[],vx=[],vy=[],live=[];
for(var i=0;i<n;i++){ox[i]=x[i]=+els[i].getAttribute("x");oy[i]=y[i]=+els[i].getAttribute("y");vx[i]=0;vy[i]=0;live[i]=false;}
var mx=-1e3,my=-1e3,pt=svg.createSVGPoint();
function aim(e){var m=svg.getScreenCTM();if(!m)return;pt.x=e.clientX;pt.y=e.clientY;var q=pt.matrixTransform(m.inverse());mx=q.x;my=q.y;}
function away(){mx=-1e3;my=-1e3;}
svg.addEventListener("pointermove",aim);
svg.addEventListener("pointerdown",aim);
svg.addEventListener("pointerleave",away);
svg.addEventListener("pointercancel",away);
svg.addEventListener("pointerup",function(e){if(e.pointerType==="touch")away();});
function frame(){
  for(var i=0;i<n;i++){
    var dx=x[i]-mx,dy=y[i]-my,d=Math.hypot(dx,dy);
    if(d<R&&d>0.01){var k=(1-d/R)*F*0.12/d;vx[i]+=dx*k;vy[i]+=dy*k;}
    vx[i]+=(ox[i]-x[i])*${SPRING};vy[i]+=(oy[i]-y[i])*${SPRING};
    vx[i]*=${FRICTION};vy[i]*=${FRICTION};
    var moving=Math.abs(vx[i])+Math.abs(vy[i])>0.02||Math.abs(ox[i]-x[i])+Math.abs(oy[i]-y[i])>0.02;
    if(moving){
      x[i]+=vx[i];y[i]+=vy[i];
      els[i].setAttribute("x",x[i]);els[i].setAttribute("y",y[i]);live[i]=true;
    }else if(live[i]){
      x[i]=ox[i];y[i]=oy[i];vx[i]=0;vy[i]=0;
      els[i].setAttribute("x",ox[i]);els[i].setAttribute("y",oy[i]);live[i]=false;
    }
  }
  requestAnimationFrame(frame);
}
frame();
})();
]]></script>
</svg>`;
}

/** Looping GIF: a virtual cursor sweeps a figure-8 across the picture. */
async function renderGif(src, st, s, onProgress) {
  const FRAMES = 100;
  const STEPS = 2; // physics steps per frame
  const DELAY = 40; // ms per frame

  const k = Math.min(1, GIF_MAX_WIDTH / st.W);
  const gw = Math.round(st.W * k);
  const gh = Math.round(st.H * k);
  const canvas = document.createElement("canvas");
  canvas.width = gw;
  canvas.height = gh;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas is not available");

  const ps = src.map((p) => ({ ...p, x: p.ox, y: p.oy, vx: 0, vy: 0 }));
  const gif = GIFEncoder();

  const advance = (f) => {
    const t = f / FRAMES;
    const mx = st.W / 2 + st.W * 0.3 * Math.sin(2 * Math.PI * t);
    const my = st.H / 2 + st.H * 0.26 * Math.sin(4 * Math.PI * t);
    for (let i = 0; i < STEPS; i++) step(ps, mx, my, s.radius, s.force);
  };

  for (let f = 0; f < FRAMES; f++) advance(f); // warm-up lap so the loop is seamless

  for (let f = 0; f < FRAMES; f++) {
    advance(f);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    draw(ctx, ps, s.size, BG[s.theme], false, st.W, st.H);
    const { data } = ctx.getImageData(0, 0, gw, gh);
    const palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), gw, gh, { palette, delay: DELAY });
    onProgress((f + 1) / FRAMES);
    await new Promise((r) => setTimeout(r, 0)); // keep the UI responsive
  }

  gif.finish();
  return gif.bytes();
}

/* ------------------------------------------------------------------ */
/* Small UI pieces                                                     */
/* ------------------------------------------------------------------ */

function Range(props) {
  return (
    <label className="pd-range">
      <span>
        {props.label}
        <b>{props.value}</b>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}

function Segmented(props) {
  return (
    <div className="pd-field" role="group" aria-label={props.label}>
      <span className="pd-label">{props.label}</span>
      <div className="pd-seg">
        {props.options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={props.value === o.value}
            className={props.value === o.value ? "is-on" : ""}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

export default function App() {
  const [img, setImg] = useState(null);
  const [name, setName] = useState("image");
  const [s, setS] = useState(DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

  const canvasRef = useRef(null);
  const particlesRef = useRef([]);
  const stageRef = useRef(null);
  const mouseRef = useRef({ x: -1000, y: -1000 });
  const cfgRef = useRef(s);

  useEffect(() => {
    cfgRef.current = s;
  }, [s]);

  const set = (key, value) =>
    setS((prev) => ({ ...prev, [key]: value }));

  const setTheme = (theme) => setS((prev) => ({ ...prev, theme, ink: INK[theme] }));

  /* ---- load an image file ---- */
  const loadFile = useCallback((file) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Choose an image file (PNG, JPG, WebP or SVG).");
      return;
    }
    setError("");
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      setImg(im);
      setName(file.name.replace(/\.[^.]+$/, "") || "image");
      URL.revokeObjectURL(url);
    };
    im.onerror = () => {
      setError("That image couldn't be read. Try a PNG or JPG.");
      URL.revokeObjectURL(url);
    };
    im.src = url;
  }, []);

  const onPick = (e) => {
    loadFile(e.target.files?.[0]);
    e.target.value = "";
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    loadFile(e.dataTransfer.files?.[0]);
  };

  /* ---- (re)build particles when the image or look changes ---- */
  const built = useMemo(
    () =>
      img
        ? buildParticles(img, {
            gap: s.gap,
            theme: s.theme,
            colorMode: s.colorMode,
            ink: s.ink,
            cutBackground: s.cutBackground,
          })
        : null,
    [img, s.gap, s.theme, s.colorMode, s.ink, s.cutBackground]
  );
  const stage = built ? built.stage : null;
  const count = built ? built.particles.length : 0;

  useEffect(() => {
    if (!built) return;
    particlesRef.current = built.particles;
    stageRef.current = built.stage;
    const c = canvasRef.current;
    if (c) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      c.width = Math.round(built.stage.W * dpr);
      c.height = Math.round(built.stage.H * dpr);
    }
  }, [built]);

  /* ---- live animation loop ---- */
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const c = canvasRef.current;
      const st = stageRef.current;
      const ps = particlesRef.current;
      if (c && st && ps.length) {
        const ctx = c.getContext("2d");
        if (ctx) {
          const cfg = cfgRef.current;
          const dpr = c.width / st.W;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          step(ps, mouseRef.current.x, mouseRef.current.y, cfg.radius, cfg.force);
          draw(ctx, ps, cfg.size, BG[cfg.theme], false, st.W, st.H);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  /* ---- pointer (mouse + touch + pen) ---- */
  const aim = (e) => {
    const c = canvasRef.current;
    const st = stageRef.current;
    if (!c || !st) return;
    const r = c.getBoundingClientRect();
    mouseRef.current.x = ((e.clientX - r.left) * st.W) / r.width;
    mouseRef.current.y = ((e.clientY - r.top) * st.H) / r.height;
  };
  const away = () => {
    mouseRef.current.x = -1000;
    mouseRef.current.y = -1000;
  };

  /* ---- downloads ---- */
  const exportHtml = () => {
    const st = stageRef.current;
    if (!st || !particlesRef.current.length) return;
    const html = buildHtml(particlesRef.current, st, s, name);
    download(new Blob([html], { type: "text/html" }), `${name}-particles.html`);
  };

  const exportSvg = () => {
    const st = stageRef.current;
    if (!st || !particlesRef.current.length) return;
    const svg = buildSvg(particlesRef.current, st, s);
    download(new Blob([svg], { type: "image/svg+xml" }), `${name}-particles.svg`);
  };

  const exportPng = () => {
    const st = stageRef.current;
    if (!st || !particlesRef.current.length) return;
    const scale = 2;
    const c = document.createElement("canvas");
    c.width = st.W * scale;
    c.height = st.H * scale;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    draw(ctx, particlesRef.current, s.size, s.transparent ? null : BG[s.theme], true, st.W, st.H);
    c.toBlob((b) => b && download(b, `${name}-particles.png`), "image/png");
  };

  const exportGif = async () => {
    const st = stageRef.current;
    if (!st || !particlesRef.current.length || busy) return;
    setBusy(true);
    setProgress(0);
    setError("");
    try {
      const bytes = await renderGif(particlesRef.current, st, s, setProgress);
      download(new Blob([bytes], { type: "image/gif" }), `${name}-particles.gif`);
    } catch {
      setError("GIF export failed. Try a larger dot gap to reduce the size.");
    } finally {
      setBusy(false);
    }
  };

  const ready = Boolean(img && stage && count > 0);

  return (
    <div className="pd">
      <style>{STYLES}</style>

      {/* ---------------- stage ---------------- */}
      <main
        className={`pd-stage${dragging ? " is-drag" : ""}`}
        style={{ background: BG[s.theme] }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <canvas
          ref={canvasRef}
          className="pd-canvas"
          aria-label="Interactive particle image. Move your pointer or touch it to push the dots."
          style={{
            display: stage ? "block" : "none",
            maxWidth: stage?.W,
            aspectRatio: stage ? `${stage.W} / ${stage.H}` : undefined,
          }}
          onPointerMove={aim}
          onPointerDown={aim}
          onPointerLeave={away}
          onPointerCancel={away}
          onPointerUp={(e) => e.pointerType === "touch" && away()}
        />

        {!img && (
          <div className="pd-empty" style={{ color: s.theme === "dark" ? "#dfe6f3" : "#111" }}>
            <p className="pd-empty-title">Drop an image here</p>
            <p className="pd-empty-sub">
              PNG with a transparent background works best. Plain backgrounds are removed
              automatically.
            </p>
            <label className="pd-btn pd-btn--main">
              Choose image
              <input type="file" accept="image/*" onChange={onPick} hidden />
            </label>
          </div>
        )}
      </main>

      {/* ---------------- controls ---------------- */}
      <aside className="pd-panel">
        <section>
          <h2>Image</h2>
          <label className="pd-btn">
            {img ? "Replace image" : "Choose image"}
            <input type="file" accept="image/*" onChange={onPick} hidden />
          </label>
          {ready && <p className="pd-note">{count.toLocaleString()} dots</p>}
          {error && (
            <p className="pd-error" role="alert">
              {error}
            </p>
          )}
        </section>

        <section>
          <h2>Look</h2>
          <Segmented
            label="Theme"
            value={s.theme}
            options={[
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
            ]}
            onChange={setTheme}
          />
          <Segmented
            label="Dot color"
            value={s.colorMode}
            options={[
              { value: "tone", label: "Single color" },
              { value: "photo", label: "Photo colors" },
            ]}
            onChange={(v) => set("colorMode", v)}
          />
          {s.colorMode === "tone" && (
            <label className="pd-field pd-inline">
              <span className="pd-label">Color</span>
              <input
                type="color"
                value={s.ink}
                onChange={(e) => set("ink", e.target.value)}
              />
            </label>
          )}
          <label className="pd-check">
            <input
              type="checkbox"
              checked={s.cutBackground}
              onChange={(e) => set("cutBackground", e.target.checked)}
            />
            Remove plain background
          </label>
        </section>

        <section>
          <h2>Motion</h2>
          <Range label="Dot gap" value={s.gap} min={3} max={10} onChange={(v) => set("gap", v)} />
          <Range
            label="Dot size"
            value={s.size}
            min={1}
            max={4}
            step={0.5}
            onChange={(v) => set("size", v)}
          />
          <Range
            label="Hover radius"
            value={s.radius}
            min={30}
            max={200}
            onChange={(v) => set("radius", v)}
          />
          <Range
            label="Push force"
            value={s.force}
            min={10}
            max={120}
            onChange={(v) => set("force", v)}
          />
        </section>

        <section>
          <h2>Download</h2>
          <label className="pd-check">
            <input
              type="checkbox"
              checked={s.transparent}
              onChange={(e) => set("transparent", e.target.checked)}
            />
            Transparent background (HTML, SVG, PNG)
          </label>
          <div className="pd-grid">
            <button className="pd-btn pd-btn--main" disabled={!ready} onClick={exportHtml}>
              Interactive HTML
            </button>
            <button className="pd-btn pd-btn--main" disabled={!ready} onClick={exportSvg}>
              Interactive SVG
            </button>
            <button className="pd-btn" disabled={!ready || busy} onClick={exportGif}>
              {busy ? `GIF ${Math.round(progress * 100)}%` : "GIF"}
            </button>
            <button className="pd-btn" disabled={!ready} onClick={exportPng}>
              PNG
            </button>
          </div>
          <p className="pd-note">
            HTML and SVG react to hover and touch, just like this preview. A GIF or PNG can't
            react to a cursor, so the GIF plays a looping sweep and the PNG holds still.
          </p>
        </section>
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

const STYLES = `
.pd{box-sizing:border-box;min-height:100vh;display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:20px;padding:20px;background:#070c18;color:#dfe6f3;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.pd *{box-sizing:border-box}
@media (max-width:860px){.pd{grid-template-columns:1fr;padding:12px}}

.pd-stage{position:relative;display:grid;place-items:center;min-height:420px;border:1px solid #1b2742;border-radius:18px;overflow:hidden;transition:border-color .15s}
.pd-stage.is-drag{border-color:#35eac8}
.pd-canvas{width:100%;height:auto;touch-action:none;cursor:crosshair}

.pd-empty{display:grid;justify-items:center;gap:6px;padding:32px;text-align:center}
.pd-empty-title{margin:0;font-size:22px;font-weight:600}
.pd-empty-sub{margin:0 0 12px;max-width:34ch;opacity:.7}

.pd-panel{display:flex;flex-direction:column;gap:22px;padding:4px 2px}
.pd-panel h2{margin:0 0 10px;font-size:15px;font-weight:600;color:#9fb0cf}
.pd-panel section{display:flex;flex-direction:column;gap:12px}
.pd-panel section>h2{margin-bottom:0}

.pd-btn{display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:8px 14px;border:1px solid #2a3a5e;border-radius:10px;background:transparent;color:inherit;font:inherit;font-weight:500;cursor:pointer;transition:background .15s,border-color .15s}
.pd-btn:hover:not(:disabled){background:#111b33;border-color:#3b5086}
.pd-btn--main{background:#35eac8;border-color:#35eac8;color:#04231d}
.pd-btn--main:hover:not(:disabled){background:#5af0d3;border-color:#5af0d3}
.pd-btn:disabled{opacity:.4;cursor:not-allowed}
.pd :focus-visible{outline:2px solid #35eac8;outline-offset:2px}

.pd-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}

.pd-field{display:flex;flex-direction:column;gap:6px}
.pd-inline{flex-direction:row;align-items:center;justify-content:space-between}
.pd-label{font-size:13px;color:#9fb0cf}
.pd-seg{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;border:1px solid #2a3a5e;border-radius:10px;overflow:hidden}
.pd-seg button{min-height:36px;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer}
.pd-seg button+button{border-left:1px solid #2a3a5e}
.pd-seg button.is-on{background:#16233f;color:#35eac8;font-weight:600}
.pd input[type=color]{width:44px;height:30px;padding:0;border:1px solid #2a3a5e;border-radius:8px;background:none;cursor:pointer}

.pd-range{display:flex;flex-direction:column;gap:4px;font-size:13px;color:#9fb0cf}
.pd-range span{display:flex;justify-content:space-between}
.pd-range b{font-weight:600;color:#dfe6f3}
.pd-range input{width:100%;accent-color:#35eac8}

.pd-check{display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer}
.pd-check input{accent-color:#35eac8;width:16px;height:16px}

.pd-note{margin:0;font-size:13px;color:#8ea0c2}
.pd-error{margin:0;font-size:13px;color:#ff8d8d}
`;
