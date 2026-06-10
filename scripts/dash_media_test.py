"""Headless 'dashboard' that proves the full media-signaling seam:
dashboard --WS--> cloud --tunnel--> agent SFU, and a real decoded video frame back.
Run with the lab-agent venv (has aiortc + websockets). Cloud+agent must be up with the TV
calibrated/bound."""
import asyncio, json, urllib.request
import websockets
from aiortc import RTCPeerConnection, RTCSessionDescription

API = "http://localhost:8080"
WS = "ws://localhost:8080/dashboard"
TV = "tv-sim-samsung-01"


def post(path, token=None, body=b"{}"):
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = "Bearer " + token
    req = urllib.request.Request(API + path, data=body, headers=headers, method="POST")
    return json.load(urllib.request.urlopen(req))


async def main():
    token = post("/auth/login", body=json.dumps({"username": "operator", "password": "operator"}).encode())["token"]
    res = post(f"/tvs/{TV}/reserve", token=token)
    sid = res["session_id"]
    print("reserved session", sid[:8])

    pc = RTCPeerConnection()
    got = asyncio.get_event_loop().create_future()

    @pc.on("track")
    def on_track(track):
        async def reader():
            frame = await track.recv()
            if not got.done():
                got.set_result((track.kind, frame.width, frame.height))
        asyncio.ensure_future(reader())

    pc.addTransceiver("video", direction="recvonly")

    async with websockets.connect(WS) as ws:
        await ws.send(json.dumps({"type": "dashboard.hello", "token": token}))
        await ws.send(json.dumps({"type": "stream.subscribe", "tv_id": TV, "session_id": sid}))
        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        await ws.send(json.dumps({"type": "signal.offer", "tv_id": TV,
                                  "payload": {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type}}))
        # Read frames until we get the SFU's answer (ignore presence broadcasts).
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), 15))
            if msg.get("type") == "signal.answer":
                p = msg["payload"]
                await pc.setRemoteDescription(RTCSessionDescription(sdp=p["sdp"], type=p["type"]))
                break
            elif msg.get("type") == "error":
                raise SystemExit(f"FAIL: cloud error {msg}")
        kind, w, h = await asyncio.wait_for(got, 15)
        print(f"MEDIA_OK kind={kind} {w}x{h} (decoded a frame through cloud relay + local SFU)")
    await pc.close()


asyncio.run(main())
