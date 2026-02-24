"""
Viewora Backend — FastAPI Stitching Server
==========================================
Multi-user safe: stitching runs in a thread-pool (never blocks the event loop).
Hardened: session_id validated, file-size + count limits, per-session locks,
          stitch timeout, automatic cleanup of uploaded frames after success.

Run locally:
  uvicorn main:app --host 0.0.0.0 --port 8000 --reload

Production (Docker):
  CMD in Dockerfile uses gunicorn with uvicorn workers for true multi-process concurrency.
"""

import asyncio
import functools
import logging
import os
import re
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import List

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

# ─── CONFIG ─────────────────────────────────────────────────────────────────
BASE_DIR    = Path(__file__).parent
UPLOADS_DIR = BASE_DIR / "uploads"
OUTPUTS_DIR = BASE_DIR / "outputs"
UPLOADS_DIR.mkdir(exist_ok=True)
OUTPUTS_DIR.mkdir(exist_ok=True)

STITCH_ENGINE   = os.getenv("STITCH_ENGINE", "opencv")
MAX_FRAMES      = int(os.getenv("MAX_FRAMES", "60"))        # max frames per session
MAX_FRAME_BYTES = int(os.getenv("MAX_FRAME_MB", "10")) * 1024 * 1024  # default 10 MB per frame
STITCH_TIMEOUT  = int(os.getenv("STITCH_TIMEOUT_S", "300")) # 5 min max stitch time

# Thread pool sized to CPU count — ensures stitching never starves the event loop
_executor = ThreadPoolExecutor(max_workers=os.cpu_count() or 2)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
log = logging.getLogger("viewora")

# Per-session lock: prevents two concurrent uploads for the same session
_session_locks: dict[str, asyncio.Lock] = {}


# ─── APP ─────────────────────────────────────────────────────────────────────
app = FastAPI(title="Viewora Stitching API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # tighten to your Vercel domain in production
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

# Serve finished panoramas as static files
app.mount("/outputs", StaticFiles(directory=str(OUTPUTS_DIR)), name="outputs")


# ─── VALIDATION ──────────────────────────────────────────────────────────────
_SESSION_RE = re.compile(r'^[A-Za-z0-9\-_]{1,64}$')

def validate_session_id(session_id: str) -> str:
    """Reject any session_id that could be used for path traversal."""
    if not _SESSION_RE.match(session_id):
        raise HTTPException(400, "Invalid session_id — only alphanumeric, hyphens, underscores allowed.")
    return session_id


# ─── ROUTES ──────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "engine": STITCH_ENGINE}


@app.post("/stitch")
async def stitch_session(
    request: Request,
    session_id: str = Form(...),
    frames: List[UploadFile] = File(...),
):
    """
    Accepts a multipart upload of JPEG frames.
    Returns: { result_url: "https://host/outputs/<session>.jpg" }

    - Validates session_id and frame limits.
    - Saves frames async, stitches in thread pool (non-blocking).
    - Cleans up uploads after success.
    - Per-session lock prevents duplicate concurrent stitches.
    """
    validate_session_id(session_id)

    # ── Guard: frame count limit
    if not frames:
        raise HTTPException(400, "No frames uploaded.")
    if len(frames) > MAX_FRAMES:
        raise HTTPException(400, f"Too many frames (max {MAX_FRAMES}).")

    log.info(f"[{session_id}] Received {len(frames)} frames")

    # ── Acquire per-session lock (prevents re-entrant stitches)
    if session_id not in _session_locks:
        _session_locks[session_id] = asyncio.Lock()
    lock = _session_locks[session_id]

    if lock.locked():
        raise HTTPException(409, f"Session {session_id} is already processing.")

    async with lock:
        session_dir = UPLOADS_DIR / session_id
        session_dir.mkdir(exist_ok=True)
        frame_paths: List[Path] = []

        try:
            # ── 1. Read and save frames (async, with size validation)
            for frame in frames:
                data = await frame.read()
                if len(data) > MAX_FRAME_BYTES:
                    raise HTTPException(413, f"Frame {frame.filename!r} exceeds size limit ({MAX_FRAME_BYTES // 1024 // 1024} MB).")
                if len(data) == 0:
                    raise HTTPException(400, f"Frame {frame.filename!r} is empty.")

                # Safe filename: strip any directory components
                safe_name = Path(frame.filename or f"frame_{len(frame_paths):03d}.jpg").name
                dest = session_dir / safe_name
                dest.write_bytes(bytes(data))
                frame_paths.append(dest)

            log.info(f"[{session_id}] Saved {len(frame_paths)} frames → {session_dir}")

            # ── 2. Stitch (runs in thread pool — never blocks the event loop)
            output_path = OUTPUTS_DIR / f"{session_id}.jpg"
            loop = asyncio.get_running_loop()

            def _stitch():
                if STITCH_ENGINE == "hugin":
                    stitch_with_hugin(session_dir, frame_paths, output_path, session_id)
                else:
                    stitch_with_opencv(frame_paths, output_path)

            try:
                stitch_fn = functools.partial(_stitch)
                await asyncio.wait_for(
                    loop.run_in_executor(_executor, stitch_fn),
                    timeout=STITCH_TIMEOUT,
                )
            except asyncio.TimeoutError:
                log.error(f"[{session_id}] Stitch timed out after {STITCH_TIMEOUT}s")
                raise HTTPException(504, "Stitching timed out — try fewer or smaller frames.")

        except HTTPException:
            raise
        except Exception as exc:
            log.exception(f"[{session_id}] Stitching failed: {exc}")
            raise HTTPException(500, f"Stitching failed: {exc}")
        finally:
            # ── 3. Always clean up uploads to free disk (keep outputs)
            if session_dir.exists():
                shutil.rmtree(session_dir, ignore_errors=True)
                log.info(f"[{session_id}] Cleaned up {session_dir}")
            # Release the session lock slot
            _session_locks.pop(session_id, None)

    # ── 4. Build absolute result URL
    base = str(request.base_url).rstrip("/")
    result_url = f"{base}/outputs/{session_id}.jpg"
    log.info(f"[{session_id}] Done → {result_url}")
    return JSONResponse({"session_id": session_id, "result_url": result_url})


# ─── OPENCV STITCHER ─────────────────────────────────────────────────────────
def stitch_with_opencv(frame_paths: List[Path], output: Path) -> None:
    """
    Uses cv2.Stitcher (PANORAMA mode).
    Raises RuntimeError with a clear message on failure.
    """
    images = []
    for p in frame_paths:
        img = cv2.imread(str(p))
        if img is None:
            raise ValueError(f"Cannot decode image: {p.name}")
        images.append(img)

    if len(images) < 2:
        raise ValueError("Need at least 2 frames to stitch.")

    stitcher = cv2.Stitcher.create(cv2.Stitcher_PANORAMA)
    stitcher.setRegistrationResol(0.6)
    stitcher.setSeamEstimationResol(0.1)
    stitcher.setCompositingResol(cv2.Stitcher_ORIG_RESOL)
    stitcher.setPanoConfidenceThresh(0.8)

    status, panorama = stitcher.stitch(images)

    STATUS_LABELS = {
        cv2.Stitcher_OK:                          "OK",
        cv2.Stitcher_ERR_NEED_MORE_IMGS:          "Need more images",
        cv2.Stitcher_ERR_HOMOGRAPHY_EST_FAIL:     "Homography estimation failed",
        cv2.Stitcher_ERR_CAMERA_PARAMS_ADJUST_FAIL: "Camera params failed",
    }
    if status != cv2.Stitcher_OK:
        label = STATUS_LABELS.get(status, f"code {status}")
        raise RuntimeError(f"cv2.Stitcher error: {label}")

    panorama = crop_black_borders(panorama)

    ok = cv2.imwrite(str(output), panorama, [cv2.IMWRITE_JPEG_QUALITY, 95])
    if not ok:
        raise RuntimeError(f"Failed to write output image to {output}")


def crop_black_borders(img: np.ndarray) -> np.ndarray:
    """Remove black bars from stitched output."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 1, 255, cv2.THRESH_BINARY)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return img
    x, y, w, h = cv2.boundingRect(max(contours, key=cv2.contourArea))
    return img[y:y + h, x:x + w]


# ─── HUGIN STITCHER ──────────────────────────────────────────────────────────
def stitch_with_hugin(
    session_dir: Path,
    frame_paths: List[Path],
    output: Path,
    session_id: str,
) -> None:
    """
    Runs the Hugin pipeline: pto_gen → cpfind → cpclean → autooptimiser →
    pano_modify → nona → enblend → JPEG conversion.
    Requires: hugin-tools, enblend installed.
    """
    pto_file = session_dir / f"{session_id}.pto"
    image_list = [str(p) for p in frame_paths]

    def run(cmd: List[str], label: str) -> None:
        log.info(f"[{session_id}] {label}: {' '.join(cmd)}")
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=120
        )
        if result.returncode != 0:
            raise RuntimeError(f"{label} failed:\n{result.stderr[:500] if result.stderr else ''}") 
        log.debug(result.stdout)

    run(["pto_gen", "--output", str(pto_file)] + image_list, "pto_gen")
    run(["cpfind", "--multirow", "--output", str(pto_file), str(pto_file)], "cpfind")
    run(["cpclean", "--output", str(pto_file), str(pto_file)], "cpclean")
    run(["autooptimiser", "-a", "-m", "-l", "-s", "-o", str(pto_file), str(pto_file)], "autooptimiser")
    run([
        "pano_modify",
        "--projection=2",
        "--fov=360x180",
        "--canvas=8000x4000",
        "--crop=AUTO",
        "--output", str(pto_file), str(pto_file),
    ], "pano_modify")

    prefix = str(session_dir / session_id)
    run(["nona", "-o", prefix, "-m", "TIFF_m", str(pto_file)], "nona")

    tiff_files = sorted(session_dir.glob(f"{session_id}*.tif"))
    if not tiff_files:
        raise RuntimeError("nona produced no output tiles")

    tiff_out = output.with_suffix(".tif")
    run(
        ["enblend", "--output", str(tiff_out)] + [str(t) for t in tiff_files],
        "enblend",
    )

    if not tiff_out.exists():
        raise RuntimeError("enblend produced no output")

    img = cv2.imread(str(tiff_out))
    if img is None:
        raise RuntimeError("Cannot read enblend TIFF output")
    ok = cv2.imwrite(str(output), img, [cv2.IMWRITE_JPEG_QUALITY, 95])
    if not ok:
        raise RuntimeError(f"Failed to write JPEG output to {output}")
    tiff_out.unlink(missing_ok=True)
