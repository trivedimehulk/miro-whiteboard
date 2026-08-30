# Miro-style Collaborative Whiteboard

A lightweight real-time whiteboard built with pure HTML/CSS/JavaScript on the
frontend and a small Python WebSocket server on the backend.

## Features

- Freehand pen drawing
- Shapes: line, rectangle, ellipse
- Text (click to add, click existing text to edit)
- Eraser (removes whole elements)
- Select tool: drag elements to move them
- Pan (pan tool, space+drag, middle mouse, or drag empty space with select)
- Zoom (Ctrl+scroll / pinch, or toolbar +/- buttons)
- Real-time multi-user collaboration over WebSockets, including live cursors
- Board state kept on the server, so new joiners see the current board
- Room chat in the right-side pane (the [miro-chat](https://github.com/trivedimehulk/miro-chat)
  React micro-frontend applet), with history, presence, typing indicators and an
  unread badge

## Keyboard shortcuts

| Key | Tool |
| --- | --- |
| V | Select / move |
| P | Pen |
| L | Line |
| R | Rectangle |
| O | Ellipse |
| T | Text |
| E | Eraser |
| H | Pan |
| Space (hold) | Temporary pan |
| C | Toggle the chat pane |

## Running

Requires Python 3.10+ and the `websockets` package.

```bash
pip install -r requirements.txt
python3 server.py            # serves on http://0.0.0.0:8000
python3 server.py --port 9000
```

Open http://localhost:8000 in multiple browser tabs (or share the URL on your
network) to collaborate in real time.

## Architecture

- `server.py` — single-port server: serves the static frontend over HTTP and
  handles WebSocket connections for the same port. Keeps the board state
  (a dict of elements) in memory and broadcasts changes to all clients.
- `static/app.js` — canvas rendering, viewport transform (pan/zoom), tools,
  and WebSocket sync. Elements are simple JSON objects (`pen`, `line`,
  `rect`, `ellipse`, `text`) identified by random ids.

Protocol messages: `init`, `add`, `update`, `delete`, `clear`, `cursor`, `leave`.

## Chat pane

The chat pane is the `miro-chat` applet, vendored as a single bundle at
`static/chat/miro-chat.applet.js` and mounted by `app.js`:

```js
MiroChat.mount(chatPane, { roomId, user, transport: chatTransport, onUnreadChange });
```

It does **not** open its own socket — `app.js` passes a transport backed by the
board's existing WebSocket, and the server routes `chat:*` frames
(`chat:join`, `chat:message`, `chat:typing` in; `chat:history`, `chat:message`,
`chat:presence`, `chat:typing` out) to the chat room handler. Chat history and
presence are kept per room id in memory; the room defaults to `main-board` and
can be overridden with `?room=<id>`.

To pick up applet changes, rebuild the bundle from a `miro-chat` checkout:

```bash
scripts/update-chat-applet.sh ../miro-chat
```
