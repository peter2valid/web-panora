/**
 * Viewora — 360° Capture Engine
 * ─────────────────────────────
 * Architecture:
 *   1. Camera feed  → getUserMedia (rear cam, highest res)
 *   2. Orientation  → A-Frame's device-orientation / look-controls
 *   3. Nodes        → Spherical grid of target angles to capture
 *   4. Matching     → Dot-product check: crosshair vs node direction
 *   5. Capture      → drawImage to canvas → toBlob → store in session
 *   6. Upload       → FormData multipart POST to FastAPI /stitch
 *   7. Viewer       → Pannellum loads returned URL
 */

// ───────────────────────────────────────────────
// CONFIG
// ───────────────────────────────────────────────
const CONFIG = {
  BACKEND_URL: 'https://web-panora.up.railway.app',  // Railway public URL
  LOCK_THRESHOLD_DEG: 8,                  // degrees within which a node is "hit"
  CAPTURE_WIDTH: 1920,
  CAPTURE_HEIGHT: 1080,
  // Spherical grid: rings of nodes at different elevations
  NODE_RINGS: [
    { elevation: 60, count: 4 },   // top cap
    { elevation: 20, count: 8 },   // upper ring
    { elevation: -20, count: 8 },   // lower ring
    { elevation: -60, count: 4 },   // bottom cap
    { elevation: 0, count: 8 },   // equator
  ],
};

// ───────────────────────────────────────────────
// STATE
// ───────────────────────────────────────────────
const state = {
  screen: 'launch',       // launch | capture | processing | viewer
  sessionId: null,
  nodes: [],              // { id, azimuth, elevation, captured, el }
  capturedFrames: [],     // Blob[]
  mediaStream: null,
  animFrame: null,
  lastCapturedNodeId: null,
  currentBestNode: null,  // tracked by capture loop, used by tap-capture
  currentBestLocked: false,
};

// ───────────────────────────────────────────────
// DOM REFS
// ───────────────────────────────────────────────
const $ = id => document.getElementById(id);
const screens = {
  launch: $('screen-launch'),
  capture: $('screen-capture'),
  processing: $('screen-processing'),
  viewer: $('screen-viewer'),
};
const cameraFeed = $('camera-feed');
const canvas = $('capture-canvas');
const ctx = canvas.getContext('2d');
const crosshair = $('crosshair');
const guidanceEl = $('guidance-text');
const progressFill = $('progress-fill');
const progressPct = $('progress-pct');
const countDone = $('count-done');
const countTotal = $('count-total');
const sessionIdEl = $('session-id');
const btnUpload = $('btn-upload');
const btnStart = $('btn-start');
const btnNewCapture = $('btn-new-capture');
const btnTapCapture = $('btn-tap-capture');
const nodeMapSvg = $('node-map-svg');
const flashEl = $('capture-flash');
const toast = $('toast');

// ───────────────────────────────────────────────
// SCREEN MANAGEMENT
// ───────────────────────────────────────────────
function showScreen(name) {
  // Cancel the capture loop whenever we leave the capture screen
  if (state.screen === 'capture' && name !== 'capture') {
    cancelAnimationFrame(state.animFrame);
    state.animFrame = null;
  }
  Object.entries(screens).forEach(([k, el]) => {
    el.classList.toggle('hidden', k !== name);
  });
  // Show A-Frame container only when on capture screen.
  // It starts display:none to prevent A-Frame painting a white
  // canvas over the launch screen on mobile before WebGL initialises.
  const aframeContainer = document.getElementById('aframe-container');
  if (aframeContainer) {
    aframeContainer.style.display = (name === 'capture') ? 'block' : 'none';
  }
  state.screen = name;
}

// ───────────────────────────────────────────────
// TOAST
// ───────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
}

// ───────────────────────────────────────────────
// SESSION ID
// ───────────────────────────────────────────────
function genSessionId() {
  return 'VW-' + Date.now().toString(36).toUpperCase();
}

// ───────────────────────────────────────────────
// NODE GENERATION
// ───────────────────────────────────────────────
/**
 * Build a uniform-ish spherical grid of capture nodes.
 * Each node = { id, azimuth (°), elevation (°), captured, el }
 */
function buildNodes() {
  state.nodes = [];
  const nodesRoot = document.getElementById('nodes-root');
  nodesRoot.innerHTML = '';

  let id = 0;
  for (const ring of CONFIG.NODE_RINGS) {
    const step = 360 / ring.count;
    for (let i = 0; i < ring.count; i++) {
      const azimuth = i * step;
      const elevation = ring.elevation;
      const node = { id: id++, azimuth, elevation, captured: false, el: null };

      // Create A-Frame sphere entity as visual target
      const el = document.createElement('a-sphere');
      const pos = sphericalToCartesian(azimuth, elevation, 4.5);
      el.setAttribute('position', `${pos.x} ${pos.y} ${pos.z}`);
      el.setAttribute('radius', '0.12');
      el.setAttribute('material', 'shader: flat; color: #00ffc8; opacity: 0.55');
      el.dataset.nodeId = node.id;
      nodesRoot.appendChild(el);
      node.el = el;
      state.nodes.push(node);
    }
  }

  countTotal.textContent = state.nodes.length;
  renderNodeMap();
}

/**
 * Convert spherical coords (azimuth°, elevation°, radius) → cartesian {x,y,z}
 * Azimuth 0 = +Z (forward), elevation 0 = horizon
 */
function sphericalToCartesian(azimuthDeg, elevationDeg, r) {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  return {
    x: r * Math.cos(el) * Math.sin(az),
    y: r * Math.sin(el),
    z: r * Math.cos(el) * Math.cos(az),
  };
}

// ───────────────────────────────────────────────
// MINI NODE MAP (2D top-down projection)
// ───────────────────────────────────────────────
function renderNodeMap() {
  // Remove old dots
  nodeMapSvg.querySelectorAll('.node-dot').forEach(e => e.remove());
  const cx = 45, cy = 45, r = 36;
  for (const node of state.nodes) {
    const rad = (node.azimuth * Math.PI) / 180;
    const scale = Math.cos((node.elevation * Math.PI) / 180);
    const nx = cx + r * scale * Math.sin(rad);
    const ny = cy - r * scale * Math.cos(rad);
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', nx.toFixed(1));
    dot.setAttribute('cy', ny.toFixed(1));
    dot.setAttribute('r', node.captured ? '3.5' : '2.2');
    dot.setAttribute('fill', node.captured ? '#00ffc8' : 'rgba(0,255,200,0.3)');
    dot.setAttribute('stroke', node.captured ? '#00ffc8' : 'rgba(0,255,200,0.5)');
    dot.setAttribute('stroke-width', '0.8');
    dot.classList.add('node-dot');
    dot.style.transition = 'fill 0.3s, r 0.3s';
    nodeMapSvg.appendChild(dot);
  }
}

// ───────────────────────────────────────────────
// CAMERA INIT
// ───────────────────────────────────────────────
async function initCamera() {
  const constraints = {
    video: {
      facingMode: { ideal: 'environment' },   // rear camera
      width: { ideal: CONFIG.CAPTURE_WIDTH },
      height: { ideal: CONFIG.CAPTURE_HEIGHT },
    },
    audio: false,
  };

  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    state.mediaStream = stream;
    cameraFeed.srcObject = stream;
    cameraFeed.style.transform = ''; // don't mirror rear cam
    await cameraFeed.play();
    return true;
  } catch (err) {
    showToast(`CAMERA ERROR: ${err.message}`);
    console.error(err);
    return false;
  }
}

/** Stops all camera tracks and releases the device. */
function stopCamera() {
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach(t => t.stop());
    state.mediaStream = null;
  }
  cameraFeed.srcObject = null;
}

// ───────────────────────────────────────────────
// GYRO / ORIENTATION
// ───────────────────────────────────────────────

// Debugging flags exposed globally for console inspection
window._sensorFired = false;
window._lastAlpha = null;
window._lastBeta = null;
window._lastGamma = null;

// Sensor watchdog — fires if no deviceorientation arrives within 2s of capture start
let _gyroWatchdog = null;

function startGyroWatchdog() {
  clearTimeout(_gyroWatchdog);
  _gyroWatchdog = setTimeout(() => {
    if (!window._sensorFired) {
      showToast('⚠ NO GYRO SIGNAL — move your device or use mouse drag');
    }
    _gyroWatchdog = null;
  }, 2000);
}

function clearGyroWatchdog() {
  clearTimeout(_gyroWatchdog);
  _gyroWatchdog = null;
}

/**
 * Raw deviceorientation handler.
 * On Android/desktop, A-Frame's look-controls handles this automatically.
 * This listener acts as a direct fallback: if the A-Frame camera-rig object
 * exists, we apply alpha/beta/gamma directly via THREE's Euler so the
 * quaternion used in the capture loop is always up-to-date.
 */
function onDeviceOrientation(evt) {
  window._sensorFired = true;
  window._lastAlpha = evt.alpha;
  window._lastBeta = evt.beta;
  window._lastGamma = evt.gamma;

  // Update live sensor HUD
  const hud = document.getElementById('sensor-hud');
  if (hud) {
    const a = evt.alpha != null ? evt.alpha.toFixed(0) : '--';
    const b = evt.beta != null ? evt.beta.toFixed(0) : '--';
    const g = evt.gamma != null ? evt.gamma.toFixed(0) : '--';
    hud.textContent = `α${a} β${b} γ${g}`;
    hud.style.color = 'rgba(0,255,200,0.6)';
  }
}

/**
 * iOS 13+ requires explicit permission for DeviceOrientation.
 * Also registers the raw listener so sensor HUD always works.
 */
async function requestOrientationPermission() {
  if (typeof DeviceOrientationEvent !== 'undefined' &&
    typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const perm = await DeviceOrientationEvent.requestPermission();
      if (perm !== 'granted') {
        clearGyroWatchdog();
        return false;
      }
    } catch {
      clearGyroWatchdog();
      return false;
    }
  }
  // Register raw listener (works on Android + iOS after permission granted)
  window.removeEventListener('deviceorientation', onDeviceOrientation, true); // avoid double-register
  window.addEventListener('deviceorientation', onDeviceOrientation, true);
  return true;
}

// ───────────────────────────────────────────────
// CAPTURE LOOP — runs every animation frame
// ───────────────────────────────────────────────
function startCaptureLoop() {
  const scene = document.querySelector('a-scene');
  const camera = document.getElementById('main-camera');

  // Pre-allocated objects to avoid GC pressure in the 60fps rAF loop.
  // Instantiated here (not top-level) so THREE is guaranteed to exist after A-Frame.
  const _worldQuat = new THREE.Quaternion();
  const _forwardVec = new THREE.Vector3();
  const _nodeVec = new THREE.Vector3();

  function loop() {
    state.animFrame = requestAnimationFrame(loop);
    if (!scene.hasLoaded || !camera) return;

    const cam3D = camera.getObject3D('camera');
    if (!cam3D) return;

    // Use getWorldQuaternion so the camera-rig's orientation is composed in.
    // This matters when the <a-camera> is nested inside a <a-entity id="camera-rig">.
    cam3D.getWorldQuaternion(_worldQuat);

    // Current look direction (world space, normalised)
    _forwardVec.set(0, 0, -1).applyQuaternion(_worldQuat).normalize();
    const forward = _forwardVec;

    let bestNode = null;
    let bestAngle = Infinity;

    for (const node of state.nodes) {
      if (node.captured) continue;

      const pos = sphericalToCartesian(node.azimuth, node.elevation, 1);
      _nodeVec.set(pos.x, pos.y, pos.z).normalize();
      const angleDeg = THREE.MathUtils.radToDeg(forward.angleTo(_nodeVec));

      // Highlight the closest uncaptured node
      if (angleDeg < bestAngle) {
        bestAngle = angleDeg;
        bestNode = node;
      }
    }

    // Dim all nodes first
    for (const node of state.nodes) {
      if (!node.captured) {
        node.el.setAttribute('opacity', '0.35');
        node.el.setAttribute('color', '#00ffc8');
        node.el.setAttribute('scale', '1 1 1');
      }
    }

    if (bestNode) {
      const withinLock = bestAngle < CONFIG.LOCK_THRESHOLD_DEG;

      // Expose to tap-capture handler
      state.currentBestNode = bestNode;
      state.currentBestLocked = withinLock;

      // Highlight nearest
      bestNode.el.setAttribute('opacity', '0.9');
      bestNode.el.setAttribute('color', withinLock ? '#ffffff' : '#00ffc8');
      bestNode.el.setAttribute('scale', withinLock ? '1.5 1.5 1.5' : '1.2 1.2 1.2');

      if (withinLock) {
        crosshair.classList.add('locked');
        guidanceEl.textContent = '✓ LOCKED — HOLD STEADY';
        guidanceEl.classList.add('highlight');
        // Show manual tap-capture button
        btnTapCapture.classList.add('visible');
        autoCaptureNode(bestNode);
      } else {
        crosshair.classList.remove('locked');
        btnTapCapture.classList.remove('visible');
        guidanceEl.textContent =
          `ALIGN: ${bestNode.azimuth.toFixed(0)}° AZ / ${bestNode.elevation.toFixed(0)}° EL`;
        guidanceEl.classList.remove('highlight');
      }
    } else {
      state.currentBestNode = null;
      state.currentBestLocked = false;
      crosshair.classList.remove('locked');
      btnTapCapture.classList.remove('visible');
      guidanceEl.textContent = '✓ ALL NODES CAPTURED!';
      guidanceEl.classList.add('highlight');
    }

    updateProgress();
  }

  loop();
}

// ───────────────────────────────────────────────
// AUTO-CAPTURE a node (debounced by node id)
// ───────────────────────────────────────────────
const captureDebounce = {};

function autoCaptureNode(node) {
  if (captureDebounce[node.id]) return;
  captureDebounce[node.id] = true;

  captureFrame(node);

  // Allow re-trigger only if we navigate away and come back
  setTimeout(() => { delete captureDebounce[node.id]; }, 2000);
}

// ───────────────────────────────────────────────
// FRAME CAPTURE
// ───────────────────────────────────────────────
function captureFrame(node) {
  // Guard: skip if camera stream not ready (avoids capturing blank frames)
  // readyState 2 = HAVE_CURRENT_DATA, which means at least one frame is available
  if (cameraFeed.readyState < 2) {
    showToast('⚠ CAMERA NOT READY — try again');
    // Clear debounce so it can retry
    delete captureDebounce[node.id];
    return;
  }
  const vw = cameraFeed.videoWidth || CONFIG.CAPTURE_WIDTH;
  const vh = cameraFeed.videoHeight || CONFIG.CAPTURE_HEIGHT;
  canvas.width = vw;
  canvas.height = vh;
  ctx.drawImage(cameraFeed, 0, 0, vw, vh);

  canvas.toBlob(blob => {
    if (!blob) return;
    state.capturedFrames.push({ blob, nodeId: node.id });
    node.captured = true;

    // Visual feedback
    node.el.setAttribute('color', '#0044ff');
    node.el.setAttribute('opacity', '0.2');
    node.el.setAttribute('scale', '1 1 1');

    flashCapture();
    renderNodeMap();
    updateProgress();

    const allDone = state.nodes.every(n => n.captured);
    if (allDone) {
      btnUpload.classList.add('visible');
      guidanceEl.textContent = '✓ CAPTURE COMPLETE — READY TO STITCH';
    }
  }, 'image/jpeg', 0.92);
}

function flashCapture() {
  flashEl.classList.add('flash');
  setTimeout(() => flashEl.classList.remove('flash'), 120);
  countDone.textContent = state.capturedFrames.length;
}

// ───────────────────────────────────────────────
// PROGRESS
// ───────────────────────────────────────────────
function updateProgress() {
  const pct = Math.round((state.capturedFrames.length / state.nodes.length) * 100);
  progressFill.style.width = pct + '%';
  progressPct.textContent = pct + '%';
  countDone.textContent = state.capturedFrames.length;
}

// ───────────────────────────────────────────────
// UPLOAD + PROCESSING
// ───────────────────────────────────────────────
async function uploadAndStitch() {
  showScreen('processing');
  // Stop camera while processing — saves battery and device resources
  stopCamera();

  const steps = {
    upload: $('step-upload'),
    detect: $('step-detect'),
    stitch: $('step-stitch'),
    done: $('step-done'),
  };

  const setStep = (key) => {
    Object.values(steps).forEach(el => el.classList.remove('active'));
    steps[key].classList.add('active');
    const order = ['upload', 'detect', 'stitch', 'done'];
    const idx = order.indexOf(key);
    order.slice(0, idx).forEach(k => steps[k].classList.add('done'));
  };

  try {
    setStep('upload');
    const form = new FormData();
    form.append('session_id', state.sessionId);
    state.capturedFrames.forEach(({ blob, nodeId }, i) => {
      form.append('frames', blob, `frame_${String(i).padStart(3, '0')}_node${nodeId}.jpg`);
    });

    const res = await fetch(`${CONFIG.BACKEND_URL}/stitch`, {
      method: 'POST',
      body: form,
    });

    // BUG FIX: read json() immediately — before any delays —
    // otherwise the response body stream closes and json() rejects.
    const data = await res.json().catch(() => ({ detail: res.statusText }));

    if (!res.ok) {
      throw new Error(data.detail || 'Server error');
    }

    // Visual pacing steps (server already finished by this point)
    setStep('detect');
    await delay(600);
    setStep('stitch');
    await delay(500);
    setStep('done');
    await delay(400);

    launchViewer(data.result_url);

  } catch (err) {
    showToast(`UPLOAD FAILED: ${err.message}`);
    console.error(err);
    // Re-init camera and restart capture loop so user can retry without refreshing
    showScreen('capture');
    const camOk = await initCamera();
    if (camOk) startCaptureLoop();
  }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ───────────────────────────────────────────────
// PANNELLUM VIEWER
// ───────────────────────────────────────────────
function launchViewer(imageUrl) {
  showScreen('viewer');
  // Small delay to let the screen render first
  setTimeout(() => {
    pannellum.viewer('pannellum-container', {
      type: 'equirectangular',
      panorama: imageUrl,
      autoLoad: true,
      autoRotate: -2,
      compass: false,
      showControls: true,
      mouseZoom: true,
      hfov: 100,
      minHfov: 50,
      maxHfov: 120,
    });
  }, 200);
}

// ───────────────────────────────────────────────
// RESET
// ───────────────────────────────────────────────
function resetCapture() {
  cancelAnimationFrame(state.animFrame);
  state.animFrame = null;

  // Release camera if still running from a previous session
  stopCamera();

  state.capturedFrames = [];
  state.lastCapturedNodeId = null;
  state.currentBestNode = null;
  state.currentBestLocked = false;

  // Clear stale debounce state so old node IDs don't block new session
  Object.keys(captureDebounce).forEach(k => delete captureDebounce[k]);

  state.sessionId = genSessionId();
  sessionIdEl.textContent = `SESSION: ${state.sessionId}`;
  btnUpload.classList.remove('visible');
  btnTapCapture.classList.remove('visible');
  crosshair.classList.remove('locked');

  // Clear pannellum viewer
  const pc = $('pannellum-container');
  pc.innerHTML = '';

  buildNodes();
  updateProgress();
  // Reset sensor flag so gyro watchdog works correctly on new session
  window._sensorFired = false;
  startCaptureLoop();
  showScreen('capture');
}

// ───────────────────────────────────────────────
// INIT — triggered by "INIT CAPTURE" button
// ───────────────────────────────────────────────
let _isInitialising = false;

btnStart.addEventListener('click', async () => {
  // Guard: prevent double-tap while already starting up
  if (_isInitialising) return;
  _isInitialising = true;
  btnStart.disabled = true;

  try {
    // iOS gyro permission (also registers raw deviceorientation listener)
    const gyroOk = await requestOrientationPermission();
    if (!gyroOk) {
      showToast('GYROSCOPE PERMISSION DENIED');
      return;
    }

    const camOk = await initCamera();
    if (!camOk) return;

    state.sessionId = genSessionId();
    sessionIdEl.textContent = `SESSION: ${state.sessionId}`;

    // Reset sensor flag so watchdog fires correctly on this session
    window._sensorFired = false;
    // Start gyro watchdog — warns if no sensor signal after 2s
    startGyroWatchdog();

    // Wait for A-Frame to load before building nodes, then transition once
    const scene = document.querySelector('a-scene');
    const onLoaded = () => {
      buildNodes();
      updateProgress();
      startCaptureLoop();
      showScreen('capture');   // only called once, here
    };

    // Remove A-Frame's default white sky/background on mobile
    const enforceTransparentBg = () => {
      // Remove any default <a-sky> A-Frame may inject
      const sky = scene.querySelector('a-sky, [geometry*="sphere"]');
      if (sky && sky !== scene) sky.parentNode && sky.parentNode.removeChild(sky);
      // Force THREE.js renderer to clear with alpha=0 — this is the real fix on iOS/Android
      // where CSS transparency alone is ignored by the WebGL compositor
      if (scene.renderer) {
        scene.renderer.setClearColor(0x000000, 0);
      }
      // Belt-and-suspenders: also set CSS transparency
      const aCanvas = scene.querySelector('canvas');
      if (aCanvas) {
        aCanvas.style.background = 'transparent';
        aCanvas.style.backgroundColor = 'transparent';
      }
    };

    if (scene.hasLoaded) {
      enforceTransparentBg();
      onLoaded();
    } else {
      scene.addEventListener('loaded', () => {
        enforceTransparentBg();
        onLoaded();
      }, { once: true });
    }
  } finally {
    // Always re-enable so if something fails, user can try again
    _isInitialising = false;
    btnStart.disabled = false;
  }
});

btnUpload.addEventListener('click', () => uploadAndStitch());
btnNewCapture.addEventListener('click', () => resetCapture());

// Tap-to-capture: manual fallback when crosshair is locked on a node
btnTapCapture.addEventListener('click', () => {
  if (state.currentBestNode && state.currentBestLocked) {
    // Bypass debounce — user explicitly tapped
    delete captureDebounce[state.currentBestNode.id];
    captureFrame(state.currentBestNode);
  }
});

// ───────────────────────────────────────────────
// HTTPS CHECK
// ───────────────────────────────────────────────
if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
  showToast('⚠ HTTPS REQUIRED FOR GYRO + CAMERA ACCESS');
}
