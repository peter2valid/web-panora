# 🌐 Viewora — 360° Capture System

> **Lego-style PWA for guided 360° photo capture and equirectangular stitching.**
> Phone browser → A-Frame gyro tracking → FastAPI + OpenCV/Hugin → Pannellum viewer.

---

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│  PHONE BROWSER (HTTPS)                                     │
│                                                            │
│  ┌──────────────┐    ┌──────────────────────────────────┐  │
│  │  Camera Feed │    │  A-Frame 3D HUD (transparent)    │  │
│  │  getUserMedia│    │  • Device orientation look-ctrl  │  │
│  │  rear cam    │    │  • 32 spherical target nodes     │  │
│  └──────┬───────┘    │  • Dot-product lock detection    │  │
│         │            └──────────────┬───────────────────┘  │
│         └──────── auto-capture ─────┘                      │
│                       │                                    │
│              canvas.toBlob() → session[]                   │
│                       │                                    │
│         FormData multipart POST /stitch                    │
└───────────────────────┼────────────────────────────────────┘
                        │  ~20-32 JPEGs
                        ▼
┌────────────────────────────────────────────────────────────┐
│  DOCKER CONTAINER (Python 3.11)                            │
│                                                            │
│  FastAPI /stitch endpoint                                  │
│       │                                                    │
│       ├─ STITCH_ENGINE=opencv  →  cv2.Stitcher.PANORAMA   │
│       │                                                    │
│       └─ STITCH_ENGINE=hugin   →  pto_gen → cpfind →      │
│                                    autooptimiser → nona →  │
│                                    enblend                 │
│                                                            │
│  outputs/<session_id>.jpg  (served as static file)        │
└───────────────────────┬────────────────────────────────────┘
                        │  { result_url }
                        ▼
┌────────────────────────────────────────────────────────────┐
│  PANNELLUM VIEWER                                          │
│  pannellum.viewer('container', { panorama: result_url })  │
└────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
viewora/
├── frontend/
│   ├── public/
│   │   ├── index.html          ← Full PWA UI (A-Frame + Pannellum)
│   │   └── manifest.json       ← PWA manifest
│   └── src/
│       └── app.js              ← Capture engine, state, API client
│
├── backend/
│   ├── app/
│   │   └── main.py             ← FastAPI server + OpenCV + Hugin pipeline
│   ├── uploads/                ← Temp frame storage (auto-created)
│   ├── outputs/                ← Stitched panoramas (served statically)
│   ├── Dockerfile
│   └── requirements.txt
│
├── docker/
│   └── nginx.conf              ← Dev proxy config
│
├── docker-compose.yml          ← Full stack local dev
├── vercel.json                 ← Frontend deployment config
└── README.md
```

---

## Quick Start

### Local Development

```bash
# Clone and start everything
git clone https://github.com/yourname/viewora
cd viewora
docker compose up --build
```

- Frontend: http://localhost:3000
- API docs: http://localhost:8000/docs

> ⚠️ **HTTPS required** for camera and gyroscope on real devices.
> Use `ngrok http 3000` or deploy to Vercel to test on your phone.

### Testing on Your Phone (via ngrok)

```bash
# Install ngrok, then:
ngrok http 3000
# → opens https://xxxx.ngrok.io → works on phone
```

---

## Deployment

### Frontend → Vercel

```bash
npm i -g vercel
vercel --prod
```

Update `CONFIG.BACKEND_URL` in `frontend/src/app.js` to your backend URL.

### Backend → Docker (any VPS / Railway / Fly.io)

```bash
cd backend
docker build -t viewora-backend .
docker run -d \
  -p 8000:8000 \
  -e STITCH_ENGINE=hugin \
  -v /data/uploads:/app/uploads \
  -v /data/outputs:/app/outputs \
  viewora-backend
```

---

## Stitching Engines

| Engine | Quality | Speed | Deps |
|--------|---------|-------|------|
| `opencv` | Good, 180°–270° panoramas | Fast | Just `opencv-python-headless` |
| `hugin` | Professional, true 360°, lens correction | Slower | `hugin-tools`, `enblend` (pre-installed in Docker) |

Set via environment variable: `STITCH_ENGINE=opencv` or `STITCH_ENGINE=hugin`

---

## Capture Node Grid

The sphere is divided into **32 nodes** across 5 rings:

| Ring | Elevation | Nodes | Purpose |
|------|-----------|-------|---------|
| 1 | +60° | 4 | Top cap |
| 2 | +20° | 8 | Upper sphere |
| 3 | 0°   | 8 | Equator (horizon) |
| 4 | −20° | 8 | Lower sphere |
| 5 | −60° | 4 | Bottom cap |

Adjust `CONFIG.NODE_RINGS` in `app.js` for denser/sparser coverage.

---

## Key Technical Notes

### HTTPS is Mandatory
`getUserMedia` and `DeviceOrientationEvent` both require a secure context. The app will warn you if running on `http://`.

### iOS Gyroscope Permission
iOS 13+ requires an explicit user gesture to call `DeviceOrientationEvent.requestPermission()`. The "INIT CAPTURE" button triggers this — don't call it on page load.

### A-Frame + Real Camera Feed
A-Frame is run in `embedded` mode with `background="color: transparent"` so the real camera video element shows through behind the 3D HUD. The camera entity uses `look-controls` with `magicWindowTrackingEnabled: true` for gyro-based rotation without VR mode.

### Lock Detection Algorithm
Each frame, we compute the dot product between the camera's forward vector and each uncaptured node's direction vector. If the angle is within `CONFIG.LOCK_THRESHOLD_DEG` (default: 8°), the node is considered "aligned" and a frame is auto-captured.

---

## API Reference

### `POST /stitch`

**Form fields:**
- `session_id` (string) — unique session identifier
- `frames` (file[]) — JPEG image files

**Response:**
```json
{
  "session_id": "VW-ABC123",
  "result_url": "/outputs/VW-ABC123.jpg"
}
```

**Errors:** `400` (no frames), `500` (stitching failed with details)

### `GET /outputs/{session_id}.jpg`
Serves the stitched panorama directly.

### `GET /health`
```json
{ "status": "ok", "engine": "opencv" }
```
