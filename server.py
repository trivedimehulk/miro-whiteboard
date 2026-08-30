"""Collaborative whiteboard server.

Serves the static frontend and a WebSocket endpoint (/ws) on a single port.
Board state is kept in memory and broadcast to all connected clients. The same
socket also carries the room chat protocol (`chat:*`) used by the miro-chat
applet mounted in the right-side pane.

Usage: python3 server.py [--host 0.0.0.0] [--port 8000]
"""

import argparse
import asyncio
import http
import json
import mimetypes
import uuid
from collections import defaultdict
from pathlib import Path

from websockets.asyncio.server import serve
from websockets.http11 import Response
from websockets.datastructures import Headers

STATIC_DIR = Path(__file__).parent / "static"

CHAT_HISTORY_LIMIT = 200

elements: dict[str, dict] = {}
clients: dict = {}
chat_history: dict[str, list[dict]] = defaultdict(list)
chat_members: dict[str, dict] = defaultdict(dict)  # room id -> {connection: user}


def serve_static(connection, request):
    """Serve static files for non-WebSocket requests."""
    if request.headers.get("Upgrade", "").lower() == "websocket":
        return None

    path = request.path.split("?")[0]
    if path == "/":
        path = "/index.html"

    file_path = (STATIC_DIR / path.lstrip("/")).resolve()
    if not str(file_path).startswith(str(STATIC_DIR.resolve())) or not file_path.is_file():
        return Response(
            http.HTTPStatus.NOT_FOUND, "Not Found",
            Headers({"Content-Type": "text/plain"}), b"404 Not Found",
        )

    content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
    body = file_path.read_bytes()
    return Response(
        http.HTTPStatus.OK, "OK",
        Headers({"Content-Type": content_type, "Content-Length": str(len(body))}),
        body,
    )


async def broadcast(message: dict, exclude=None):
    await send_to(list(clients), message, exclude)


async def send_to(connections, message: dict, exclude=None):
    data = json.dumps(message)
    for ws in connections:
        if ws is not exclude:
            try:
                await ws.send(data)
            except Exception:
                pass


async def broadcast_presence(room_id: str):
    await send_to(list(chat_members[room_id]), {
        "type": "chat:presence",
        "roomId": room_id,
        "users": list(chat_members[room_id].values()),
    })


async def handle_chat(ws, msg: dict, joined_rooms: set[str]) -> None:
    room_id = msg.get("roomId")
    if not isinstance(room_id, str):
        return
    msg_type = msg["type"]

    if msg_type == "chat:join":
        chat_members[room_id][ws] = msg.get("user") or {}
        joined_rooms.add(room_id)
        await ws.send(json.dumps({
            "type": "chat:history",
            "roomId": room_id,
            "messages": chat_history[room_id],
        }))
        await broadcast_presence(room_id)
    elif msg_type == "chat:message":
        message = msg.get("message")
        if not isinstance(message, dict) or not message.get("id"):
            return
        chat_history[room_id].append(message)
        del chat_history[room_id][:-CHAT_HISTORY_LIMIT]
        await send_to(list(chat_members[room_id]), msg, exclude=ws)
    elif msg_type == "chat:typing":
        await send_to(list(chat_members[room_id]), msg, exclude=ws)


async def handler(ws):
    client_id = uuid.uuid4().hex[:8]
    clients[ws] = client_id
    joined_rooms: set[str] = set()
    try:
        await ws.send(json.dumps({
            "type": "init",
            "clientId": client_id,
            "elements": list(elements.values()),
        }))
        async for raw in ws:
            msg = json.loads(raw)
            msg_type = msg.get("type")

            if msg_type == "add" or msg_type == "update":
                el = msg.get("element")
                if el and el.get("id"):
                    elements[el["id"]] = el
                    await broadcast(msg, exclude=ws)
            elif msg_type == "delete":
                for el_id in msg.get("ids", []):
                    elements.pop(el_id, None)
                await broadcast(msg, exclude=ws)
            elif msg_type == "clear":
                elements.clear()
                await broadcast(msg, exclude=ws)
            elif msg_type == "cursor":
                msg["clientId"] = client_id
                await broadcast(msg, exclude=ws)
            elif isinstance(msg_type, str) and msg_type.startswith("chat:"):
                await handle_chat(ws, msg, joined_rooms)
    finally:
        clients.pop(ws, None)
        for room_id in joined_rooms:
            chat_members[room_id].pop(ws, None)
            await broadcast_presence(room_id)
        await broadcast({"type": "leave", "clientId": client_id})


async def main(host: str, port: int):
    async with serve(handler, host, port, process_request=serve_static):
        print(f"Whiteboard running at http://{host}:{port}")
        await asyncio.Future()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    try:
        asyncio.run(main(args.host, args.port))
    except KeyboardInterrupt:
        pass
