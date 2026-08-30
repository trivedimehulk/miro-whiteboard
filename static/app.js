"use strict";

// ---------- State ----------
const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");
const textInput = document.getElementById("text-input");
const statusDot = document.getElementById("status");
const zoomLabel = document.getElementById("zoom-level");

let elements = new Map(); // id -> element
let tool = "select";
let color = "#1e1e1e";
let strokeWidth = 4;

// Viewport transform: screen = world * scale + offset
let scale = 1;
let offsetX = 0;
let offsetY = 0;

let drawing = null;       // element currently being drawn
let dragging = null;      // { el, startX, startY, orig } while moving with select
let panning = null;       // { startX, startY, origOffsetX, origOffsetY }
let spaceDown = false;
let erasedIds = new Set();
let remoteCursors = new Map(); // clientId -> {x, y, ts}
let clientId = null;

// ---------- WebSocket ----------
let ws = null;

// Chat rides this same socket: `chat:*` frames are handed to the miro-chat
// applet, everything else is board traffic.
const chatListeners = new Set();
const chatStatusListeners = new Set();

function emitChatStatus(status) {
  chatStatus = status;
  chatStatusListeners.forEach((fn) => fn(status));
}

let chatStatus = "connecting";

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    statusDot.classList.remove("disconnected");
    statusDot.classList.add("connected");
    emitChatStatus("connected");
    flushChatQueue();
  };
  ws.onclose = () => {
    statusDot.classList.remove("connected");
    statusDot.classList.add("disconnected");
    emitChatStatus("disconnected");
    setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (typeof msg.type === "string" && msg.type.startsWith("chat:")) {
      chatListeners.forEach((fn) => fn(msg));
      return;
    }
    switch (msg.type) {
      case "init":
        clientId = msg.clientId;
        elements = new Map(msg.elements.map((el) => [el.id, el]));
        break;
      case "add":
      case "update":
        elements.set(msg.element.id, msg.element);
        break;
      case "delete":
        msg.ids.forEach((id) => elements.delete(id));
        break;
      case "clear":
        elements.clear();
        break;
      case "cursor":
        remoteCursors.set(msg.clientId, { x: msg.x, y: msg.y, ts: Date.now() });
        break;
      case "leave":
        remoteCursors.delete(msg.clientId);
        break;
    }
    requestRender();
  };
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// Chat messages typed while offline are replayed once the socket is back.
const chatQueue = [];

function sendChat(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  else chatQueue.push(msg);
}

function flushChatQueue() {
  const pending = chatQueue.splice(0, chatQueue.length);
  pending.forEach(sendChat);
}

connect();

// ---------- Coordinates ----------
function toWorld(sx, sy) {
  return { x: (sx - offsetX) / scale, y: (sy - offsetY) / scale };
}

function pointerPos(ev) {
  const rect = canvas.getBoundingClientRect();
  return { sx: ev.clientX - rect.left, sy: ev.clientY - rect.top };
}

// ---------- Elements ----------
function newId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function elementBounds(el) {
  if (el.type === "pen") {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [px, py] of el.points) {
      minX = Math.min(minX, px); minY = Math.min(minY, py);
      maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  if (el.type === "text") {
    ctx.font = `${el.fontSize}px system-ui, sans-serif`;
    const lines = el.text.split("\n");
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width), 10);
    return { x: el.x, y: el.y, w, h: lines.length * el.fontSize * 1.25 };
  }
  const x = Math.min(el.x1, el.x2), y = Math.min(el.y1, el.y2);
  return { x, y, w: Math.abs(el.x2 - el.x1), h: Math.abs(el.y2 - el.y1) };
}

function hitTest(el, x, y) {
  const pad = Math.max((el.strokeWidth || 4) / 2 + 4, 6) / scale;
  if (el.type === "pen") {
    for (let i = 0; i < el.points.length - 1; i++) {
      if (distToSegment(x, y, ...el.points[i], ...el.points[i + 1]) < pad) return true;
    }
    return false;
  }
  if (el.type === "line") {
    return distToSegment(x, y, el.x1, el.y1, el.x2, el.y2) < pad;
  }
  const b = elementBounds(el);
  if (el.type === "text") {
    return x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;
  }
  // rect / ellipse: hit on border or inside
  return x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function elementAt(x, y) {
  const list = [...elements.values()];
  for (let i = list.length - 1; i >= 0; i--) {
    if (hitTest(list[i], x, y)) return list[i];
  }
  return null;
}

function translateElement(el, dx, dy) {
  if (el.type === "pen") {
    el.points = el.points.map(([px, py]) => [px + dx, py + dy]);
  } else if (el.type === "text") {
    el.x += dx; el.y += dy;
  } else {
    el.x1 += dx; el.y1 += dy; el.x2 += dx; el.y2 += dy;
  }
}

// ---------- Rendering ----------
let renderQueued = false;
function requestRender() {
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }
}

function viewWidth() { return canvas.clientWidth; }
function viewHeight() { return canvas.clientHeight; }

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = viewWidth() * dpr;
  canvas.height = viewHeight() * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  requestRender();
}
window.addEventListener("resize", resize);

function drawElement(el) {
  ctx.strokeStyle = el.color;
  ctx.fillStyle = el.color;
  ctx.lineWidth = el.strokeWidth || 4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (el.type === "pen") {
    if (el.points.length < 2) {
      const [x, y] = el.points[0];
      ctx.beginPath();
      ctx.arc(x, y, (el.strokeWidth || 4) / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(el.points[0][0], el.points[0][1]);
    for (const [px, py] of el.points.slice(1)) ctx.lineTo(px, py);
    ctx.stroke();
  } else if (el.type === "line") {
    ctx.beginPath();
    ctx.moveTo(el.x1, el.y1);
    ctx.lineTo(el.x2, el.y2);
    ctx.stroke();
  } else if (el.type === "rect") {
    ctx.strokeRect(Math.min(el.x1, el.x2), Math.min(el.y1, el.y2),
      Math.abs(el.x2 - el.x1), Math.abs(el.y2 - el.y1));
  } else if (el.type === "ellipse") {
    ctx.beginPath();
    ctx.ellipse((el.x1 + el.x2) / 2, (el.y1 + el.y2) / 2,
      Math.abs(el.x2 - el.x1) / 2, Math.abs(el.y2 - el.y1) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (el.type === "text") {
    ctx.font = `${el.fontSize}px system-ui, sans-serif`;
    ctx.textBaseline = "top";
    el.text.split("\n").forEach((line, i) => {
      ctx.fillText(line, el.x, el.y + i * el.fontSize * 1.25);
    });
  }
}

function drawGrid() {
  const step = 40 * scale;
  if (step < 8) return;
  ctx.fillStyle = "#d5d5d0";
  const w = viewWidth(), h = viewHeight();
  for (let x = offsetX % step; x < w; x += step) {
    for (let y = offsetY % step; y < h; y += step) {
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }
  }
}

function render() {
  ctx.save();
  ctx.clearRect(0, 0, viewWidth(), viewHeight());
  drawGrid();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);

  for (const el of elements.values()) drawElement(el);
  if (drawing) drawElement(drawing);

  // remote cursors
  const now = Date.now();
  for (const [id, cur] of remoteCursors) {
    if (now - cur.ts > 5000) { remoteCursors.delete(id); continue; }
    ctx.fillStyle = colorForId(id);
    ctx.beginPath();
    ctx.arc(cur.x, cur.y, 5 / scale, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function colorForId(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h}, 70%, 50%)`;
}

// ---------- Toolbar ----------
document.querySelectorAll("#toolbar .tool").forEach((btn) => {
  btn.addEventListener("click", () => setTool(btn.dataset.tool));
});

function setTool(t) {
  tool = t;
  document.querySelectorAll("#toolbar .tool").forEach((b) =>
    b.classList.toggle("active", b.dataset.tool === t));
  canvas.style.cursor = { pan: "grab", text: "text", eraser: "cell", select: "default" }[t] || "crosshair";
}

document.getElementById("color").addEventListener("input", (e) => { color = e.target.value; });
document.getElementById("width").addEventListener("change", (e) => { strokeWidth = +e.target.value; });

document.getElementById("clear").addEventListener("click", () => {
  if (elements.size && confirm("Clear the whole board for everyone?")) {
    elements.clear();
    send({ type: "clear" });
    requestRender();
  }
});

function setZoom(newScale, cx, cy) {
  newScale = Math.max(0.1, Math.min(5, newScale));
  const world = toWorld(cx, cy);
  scale = newScale;
  offsetX = cx - world.x * scale;
  offsetY = cy - world.y * scale;
  zoomLabel.textContent = Math.round(scale * 100) + "%";
  requestRender();
}

document.getElementById("zoom-in").addEventListener("click", () =>
  setZoom(scale * 1.2, viewWidth() / 2, viewHeight() / 2));
document.getElementById("zoom-out").addEventListener("click", () =>
  setZoom(scale / 1.2, viewWidth() / 2, viewHeight() / 2));
document.getElementById("zoom-reset").addEventListener("click", () => {
  scale = 1; offsetX = 0; offsetY = 0;
  zoomLabel.textContent = "100%";
  requestRender();
});

// ---------- Keyboard ----------
window.addEventListener("keydown", (e) => {
  if (e.target === textInput) return;
  if (e.code === "Space") { spaceDown = true; canvas.style.cursor = "grab"; e.preventDefault(); return; }
  if (e.key.toLowerCase() === "c" && !e.ctrlKey && !e.metaKey) { toggleChat(); return; }
  const keys = { v: "select", p: "pen", l: "line", r: "rect", o: "ellipse", t: "text", e: "eraser", h: "pan" };
  const t = keys[e.key.toLowerCase()];
  if (t && !e.ctrlKey && !e.metaKey) setTool(t);
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") { spaceDown = false; setTool(tool); }
});

// ---------- Text editing ----------
let editingTextEl = null;

function openTextEditor(worldX, worldY, existing) {
  editingTextEl = existing || {
    id: newId(), type: "text", x: worldX, y: worldY,
    text: "", color, fontSize: Math.max(16, strokeWidth * 5),
  };
  const sx = editingTextEl.x * scale + offsetX;
  const sy = editingTextEl.y * scale + offsetY;
  textInput.style.display = "block";
  textInput.style.left = sx + "px";
  textInput.style.top = sy + "px";
  textInput.style.fontSize = editingTextEl.fontSize * scale + "px";
  textInput.style.color = editingTextEl.color;
  textInput.value = editingTextEl.text;
  textInput.focus();
}

function commitText() {
  if (!editingTextEl) return;
  const text = textInput.value.trim();
  const isNew = !elements.has(editingTextEl.id);
  if (text) {
    editingTextEl.text = text;
    elements.set(editingTextEl.id, editingTextEl);
    send({ type: isNew ? "add" : "update", element: editingTextEl });
  } else if (!isNew) {
    elements.delete(editingTextEl.id);
    send({ type: "delete", ids: [editingTextEl.id] });
  }
  editingTextEl = null;
  textInput.style.display = "none";
  textInput.value = "";
  requestRender();
}

textInput.addEventListener("blur", commitText);
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { textInput.value = ""; commitText(); }
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitText(); }
});

// ---------- Pointer events ----------
// Touch pointers are tracked so two fingers pinch-zoom and pan instead of drawing.
const activePointers = new Map();
let gesture = null;

function gestureMetrics() {
  const [a, b] = [...activePointers.values()];
  return {
    dist: Math.hypot(a.sx - b.sx, a.sy - b.sy),
    cx: (a.sx + b.sx) / 2,
    cy: (a.sy + b.sy) / 2,
  };
}

function startGesture() {
  drawing = null;
  dragging = null;
  panning = null;
  erasedIds = new Set();
  gesture = { ...gestureMetrics(), scale, offsetX, offsetY };
  requestRender();
}

function endPointer(e) {
  activePointers.delete(e.pointerId);
  if (activePointers.size < 2) gesture = null;
}

canvas.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  const pos = pointerPos(e);
  activePointers.set(e.pointerId, pos);
  if (activePointers.size === 2) { startGesture(); return; }
  if (activePointers.size > 2) return;
  const { sx, sy } = pos;
  const { x, y } = toWorld(sx, sy);

  if (editingTextEl) { commitText(); return; }

  if (tool === "pan" || spaceDown || e.button === 1) {
    panning = { startX: sx, startY: sy, origOffsetX: offsetX, origOffsetY: offsetY };
    canvas.style.cursor = "grabbing";
    return;
  }

  if (tool === "select") {
    const el = elementAt(x, y);
    if (el) {
      dragging = { el, lastX: x, lastY: y };
      canvas.style.cursor = "move";
    } else {
      panning = { startX: sx, startY: sy, origOffsetX: offsetX, origOffsetY: offsetY };
    }
    return;
  }

  if (tool === "text") {
    const el = elementAt(x, y);
    openTextEditor(x, y, el && el.type === "text" ? el : null);
    return;
  }

  if (tool === "eraser") {
    erasedIds = new Set();
    eraseAt(x, y);
    drawing = { type: "_erasing" };
    return;
  }

  if (tool === "pen") {
    drawing = { id: newId(), type: "pen", points: [[x, y]], color, strokeWidth };
  } else {
    drawing = { id: newId(), type: tool, x1: x, y1: y, x2: x, y2: y, color, strokeWidth };
  }
  requestRender();
});

canvas.addEventListener("pointermove", (e) => {
  const pos = pointerPos(e);
  if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, pos);

  if (gesture && activePointers.size >= 2) {
    const now = gestureMetrics();
    const factor = gesture.dist > 0 ? now.dist / gesture.dist : 1;
    scale = Math.max(0.1, Math.min(5, gesture.scale * factor));
    const worldX = (gesture.cx - gesture.offsetX) / gesture.scale;
    const worldY = (gesture.cy - gesture.offsetY) / gesture.scale;
    offsetX = now.cx - worldX * scale;
    offsetY = now.cy - worldY * scale;
    zoomLabel.textContent = Math.round(scale * 100) + "%";
    requestRender();
    return;
  }

  const { sx, sy } = pos;
  const { x, y } = toWorld(sx, sy);

  throttledCursor(x, y);

  if (panning) {
    offsetX = panning.origOffsetX + (sx - panning.startX);
    offsetY = panning.origOffsetY + (sy - panning.startY);
    requestRender();
    return;
  }

  if (dragging) {
    translateElement(dragging.el, x - dragging.lastX, y - dragging.lastY);
    dragging.lastX = x;
    dragging.lastY = y;
    throttledUpdate(dragging.el);
    requestRender();
    return;
  }

  if (!drawing) return;

  if (drawing.type === "_erasing") {
    eraseAt(x, y);
    return;
  }

  if (drawing.type === "pen") {
    drawing.points.push([x, y]);
  } else {
    drawing.x2 = x;
    drawing.y2 = y;
  }
  requestRender();
});

canvas.addEventListener("pointercancel", endPointer);

canvas.addEventListener("pointerup", (e) => {
  const wasGesture = gesture !== null;
  endPointer(e);
  if (wasGesture) { drawing = null; panning = null; return; }
  if (panning) {
    panning = null;
    setTool(tool);
    return;
  }
  if (dragging) {
    send({ type: "update", element: dragging.el });
    dragging = null;
    setTool(tool);
    return;
  }
  if (!drawing) return;
  if (drawing.type === "_erasing") {
    drawing = null;
    erasedIds = new Set();
    return;
  }
  const el = drawing;
  drawing = null;
  // ignore zero-size shapes
  if (el.type !== "pen" && el.x1 === el.x2 && el.y1 === el.y2) { requestRender(); return; }
  elements.set(el.id, el);
  send({ type: "add", element: el });
  requestRender();
});

function eraseAt(x, y) {
  const el = elementAt(x, y);
  if (el && !erasedIds.has(el.id)) {
    erasedIds.add(el.id);
    elements.delete(el.id);
    send({ type: "delete", ids: [el.id] });
    requestRender();
  }
}

// ---------- Wheel: zoom (ctrl/pinch) or pan ----------
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setZoom(scale * factor, e.clientX, e.clientY);
  } else {
    offsetX -= e.deltaX;
    offsetY -= e.deltaY;
    requestRender();
  }
}, { passive: false });

// ---------- Throttled network updates ----------
let lastCursorSent = 0;
function throttledCursor(x, y) {
  const now = Date.now();
  if (now - lastCursorSent > 50) {
    lastCursorSent = now;
    send({ type: "cursor", x, y });
  }
}

let lastUpdateSent = 0;
function throttledUpdate(el) {
  const now = Date.now();
  if (now - lastUpdateSent > 60) {
    lastUpdateSent = now;
    send({ type: "update", element: el });
  }
}

// ---------- Chat pane ----------
const chatPane = document.getElementById("chat-pane");
const chatToggle = document.getElementById("chat-toggle");
const chatBadge = document.getElementById("chat-unread");

// The room id keeps chat scoped to the board being viewed (?room=...).
const roomId = new URLSearchParams(location.search).get("room") || "main-board";

function storedUser() {
  let user;
  try {
    user = JSON.parse(localStorage.getItem("miro-chat-user") || "null");
  } catch { user = null; }
  if (!user || !user.id) {
    user = { id: Math.random().toString(36).slice(2, 10) };
    user.name = "Guest " + user.id.slice(0, 4);
    try { localStorage.setItem("miro-chat-user", JSON.stringify(user)); } catch { /* private mode */ }
  }
  return user;
}

// The applet talks to the room through the board's existing socket instead of
// opening a second connection.
const chatTransport = {
  send: sendChat,
  subscribe(listener) {
    chatListeners.add(listener);
    return () => chatListeners.delete(listener);
  },
  onStatusChange(listener) {
    chatStatusListeners.add(listener);
    return () => chatStatusListeners.delete(listener);
  },
  getStatus: () => chatStatus,
};

const narrowScreen = window.matchMedia("(max-width: 760px)");
const storedChatOpen = localStorage.getItem("miro-chat-open");
// Phones start with the board visible; the pane is an overlay they open on demand.
let chatOpen = storedChatOpen === null ? !narrowScreen.matches : storedChatOpen !== "false";

// Messages only count as unread while the pane is collapsed.
function onUnreadChange(count) {
  if (chatOpen) {
    chatBadge.hidden = true;
    chat.markRead();
    return;
  }
  chatBadge.hidden = count === 0;
  chatBadge.textContent = count > 9 ? "9+" : String(count);
}

const chat = MiroChat.mount(chatPane, {
  roomId,
  user: storedUser(),
  transport: chatTransport,
  title: "Room chat",
  onUnreadChange,
});

function applyChatVisibility() {
  document.body.classList.toggle("chat-collapsed", !chatOpen);
  // On phones the pane overlays the board instead of shrinking it.
  const paneWidth = chatOpen && !narrowScreen.matches ? "320px" : "0px";
  document.documentElement.style.setProperty("--pane-width", paneWidth);
  chatToggle.classList.toggle("active", chatOpen);
  if (chatOpen) chat.markRead();
  resize();
}

function toggleChat() {
  chatOpen = !chatOpen;
  try { localStorage.setItem("miro-chat-open", String(chatOpen)); } catch { /* private mode */ }
  applyChatVisibility();
}

chatToggle.addEventListener("click", toggleChat);
document.getElementById("chat-close").addEventListener("click", toggleChat);
narrowScreen.addEventListener("change", applyChatVisibility);

// ---------- Init ----------
applyChatVisibility();
resize();
setTool("select");
