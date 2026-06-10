"""Device Lab Phase 1 — Lab Controller Agent.

Connects OUT to the cloud control plane's /agent WebSocket, holds the real TV control sessions
(Samsung / LG / Android TV) and the local SFU, scans camera feeds for calibration QR codes, and
reports device/camera health up. Media stays local (spec §3).
"""

__version__ = "0.1.0"
