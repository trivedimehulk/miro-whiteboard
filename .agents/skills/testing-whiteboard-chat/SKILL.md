---
name: testing-whiteboard-chat
description: How to run and end-to-end test the miro-whiteboard app and its miro-chat right-side pane in a browser (two identities, WebSocket, canvas coordinates).
---

# Testing miro-whiteboard + miro-chat pane

## Run the app
```bash
cd /path/to/miro-whiteboard
setsid nohup python3 server.py > /tmp/wb.log 2>&1 < /dev/null &   # plain `nohup ... &` from a one-shot
                                                                  # shell tool dies when the call returns
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/
```
Single port 8000 serves static files and the `/ws` WebSocket. Board state and chat history are in
memory only — restarting the server wipes both (clients keep what they already rendered).
The chat applet is a vendored bundle at `static/chat/miro-chat.applet.js`; rebuild it from the
`miro-chat` repo with `npm run build` + `scripts/update-chat-applet.sh` if you change chat source.

## Getting two distinct users
Identity comes from `localStorage["miro-chat-user"]` (`storedUser()` in `static/app.js`). Two tabs in
the same profile share one identity. Use a normal window + an **incognito window**
(`ctrl+shift+n`) to get two different "Guest xxxx" users. `?room=<id>` scopes the chat room.

## Window layout for two-client tests
The screenshot coordinate space (1024x768) may be a downscale of the real display — check
`xdpyinfo | grep dimensions` before using `wmctrl`/`xdotool` geometry, which are in real pixels.
Tile with e.g. `wmctrl -i -r <winid> -e 0,0,0,800,1160`. The chat pane is a fixed 320px, and the
toolbar is centered on the remaining canvas, so windows narrower than ~700 real px push the left
toolbar buttons off-screen and the fixed toolbar overlaps the pane's presence row — give each
window at least ~800 real px or maximize when you need the whole toolbar.
Toolbar button order: select, pen, line, rect, ellipse, text, eraser, pan, then color/width/zoom,
clear, 💬 chat toggle. Count from the left before clicking; the eraser and ellipse are easy to mix up.

## Useful UI handles
- `#chat-toggle` (💬, also keyboard `C`) collapses/expands `#chat-pane`; badge is `#chat-unread`.
- Chat DOM: `.mc-status` (Connecting…/Live/Offline), `.mc-presence` ("N people here" + chips),
  `.mc-typing`, `.mc-input` composer, `.mc-own` for own (blue, right-aligned) bubbles.
- Typing indicator lives ~3s after the last keystroke — screenshot it in the *same* action batch as
  the typing, otherwise it has already cleared.
- `left_click_drag` sometimes does not register as a canvas draw; prefer
  `mouse_move` → `left_mouse_down` → `mouse_move`(x2) → `left_mouse_up`.

## Known-suspect areas (re-check these)
- The chat header can stay stuck on **"Connecting…"** after a fresh load even though the socket is
  open, because the applet subscribes to status after `ws.onopen` already fired. It self-heals after
  any reconnect. Symptom: whiteboard status dot green + header orange "Connecting…".
- The unread badge may increment while the pane is **open** (and count replayed history on load),
  since `markRead()` is only called when the pane is toggled open.
- To exercise offline/reconnect: `pkill -f "python3 server.py"` (expect "Offline" + disabled
  composer within ~2s), then restart (expect "Live", presence restored, messaging works).
