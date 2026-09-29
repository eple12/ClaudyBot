// ClaudyBot Live: a read-only mirror of a Lichess BOT for GitHub Pages.
// Boards, clocks and moves come from the public Lichess API (streams, no login). Engine output (eval, depth,
// PV, eval history) comes from the bot itself when it publishes GET /api/public/state (web.public) at a URL
// given as `telemetry` in config.js or ?telemetry=...
import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm";

const $ = (s, el = document) => el.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const qs = new URLSearchParams(location.search);
const CFG = window.VIEWER || {};
const BOT = (qs.get("bot") || CFG.bot || "ClaudyEngine").trim();
const BOT_ID = BOT.toLowerCase();
const TELE = (qs.get("telemetry") ?? CFG.telemetry ?? "").trim().replace(/\/+$/, "");
const LI = "https://lichess.org";

// ---- helpers --------------------------------------------------------------------------------------
function fmtClock(ms) {
  if (ms === null || ms === undefined) return "--:--";
  ms = Math.max(0, ms);
  const s = ms / 1000;
  if (s < 10) return `0:${s.toFixed(1).padStart(4, "0")}`;
  const t = Math.floor(s), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
function human(n) {
  n = n || 0;
  for (const [u, d] of [["G", 1e9], ["M", 1e6], ["k", 1e3]]) if (n >= d) return (n / d).toFixed(1) + u;
  return String(Math.round(n));
}
const winPct = cp => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-2000, Math.min(2000, cp)))) - 1);
function setText(e, t) { if (e && e.textContent !== t) e.textContent = t; }
function setClass(e, c, on) { if (e && e.classList.contains(c) !== !!on) e.classList.toggle(c, !!on); }

async function ndjson(url, opts, onObj) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) { try { onObj(JSON.parse(line)); } catch { /* keep-alive or partial */ } }
    }
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- board (same drawing as the bot's own dashboard) ------------------------------------------------
const FILES = "abcdefgh";
const sqName = (f, r) => FILES[f] + (r + 1);
function parseFen(fen) {
  const m = new Map();
  let r = 7, f = 0;
  for (const ch of fen.split(" ")[0]) {
    if (ch === "/") { r--; f = 0; continue; }
    if (ch >= "1" && ch <= "8") { f += +ch; continue; }
    m.set(sqName(f, r), (ch === ch.toUpperCase() ? "w" : "b") + ch.toUpperCase());
    f++;
  }
  return m;
}
for (const c of "wb") for (const p of "KQRBNP") { const i = new Image(); i.src = `pieces/${c}${p}.svg`; }

class Board {
  constructor(root, coords = true) {
    this.root = root; this.coords = coords; this.sqEls = [];
    const grid = el("div", "squares");
    for (let i = 0; i < 64; i++) { const d = el("div", "sq"); grid.appendChild(d); this.sqEls.push(d); }
    this.layer = el("div", "pieces");
    root.append(grid, this.layer);
    this.pieces = new Map(); this.orient = null; this.fen = null; this.marks = ""; this.banner = null;
  }
  xy(sq) { const f = FILES.indexOf(sq[0]), r = +sq[1] - 1; return this.orient === "white" ? [f, 7 - r] : [7 - f, r]; }
  place(p, sq) { const [x, y] = this.xy(sq); p.el.style.transform = `translate(${x * 100}%, ${y * 100}%)`; }
  drawSquares() {
    this.sqEls.forEach((d, i) => {
      const x = i % 8, y = Math.floor(i / 8);
      const f = this.orient === "white" ? x : 7 - x, r = this.orient === "white" ? 7 - y : y;
      d.dataset.sq = sqName(f, r);
      d.className = "sq " + ((f + r) % 2 ? "l" : "d");
      d.textContent = "";
      if (this.coords) {
        if (x === 0) d.appendChild(el("span", "coord rank", String(r + 1)));
        if (y === 7) d.appendChild(el("span", "coord file", FILES[f]));
      }
    });
    this.marks = "";
  }
  update({ fen, last, check, orient, animate = true, banner = "" }) {
    let still = !animate;
    if (orient !== this.orient) { this.orient = orient; this.drawSquares(); still = true; }
    const marks = `${last ? last.join("") : ""}|${check || ""}`;
    if (marks !== this.marks) {
      this.marks = marks;
      for (const d of this.sqEls) {
        setClass(d, "last", !!last && last.includes(d.dataset.sq));
        setClass(d, "check", check === d.dataset.sq);
      }
    }
    this.setBanner(banner);
    if (fen === this.fen && !still) return;
    if (still) this.root.classList.add("still");
    const next = parseFen(fen), keep = new Map(), loose = [];
    for (const [sq, p] of this.pieces) { if (next.get(sq) === p.code) keep.set(sq, p); else loose.push([sq, p]); }
    const dist = (a, b) => Math.max(Math.abs(FILES.indexOf(a[0]) - FILES.indexOf(b[0])), Math.abs(a[1] - b[1]));
    for (const [sq, code] of next) {
      if (keep.has(sq)) continue;
      let best = -1, bestD = 99;
      loose.forEach(([osq, p], i) => {
        if (p.code !== code) return;
        const d = last && osq === last[0] ? -1 : dist(osq, sq);
        if (d < bestD) { bestD = d; best = i; }
      });
      let p;
      if (best >= 0 && !still) {
        p = loose.splice(best, 1)[0][1];
        p.el.classList.add("moving");
        setTimeout(() => p.el.classList.remove("moving"), 260);
      } else {
        p = { code, el: el("div", "piece") };
        p.el.style.backgroundImage = `url(pieces/${code}.svg)`;
        this.layer.appendChild(p.el);
      }
      this.place(p, sq);
      keep.set(sq, p);
    }
    for (const [, p] of loose) {
      if (still) p.el.remove(); else { p.el.classList.add("gone"); setTimeout(() => p.el.remove(), 230); }
    }
    if (still) for (const [sq, p] of keep) this.place(p, sq);
    this.pieces = keep; this.fen = fen;
    if (still) { void this.root.offsetWidth; this.root.classList.remove("still"); }
  }
  setBanner(text) {
    if (!text) { if (this.banner) { this.banner.remove(); this.banner = null; } return; }
    if (!this.banner) { this.banner = el("div", "banner"); this.root.appendChild(this.banner); }
    setText(this.banner, text);
  }
}

// ---- state ----------------------------------------------------------------------------------------
const games = new Map();      // id -> game
const recent = [];            // finished games (newest first)
const extra = new Map();      // games opened by link that are not (or no longer) running
let tele = null, teleAt = 0, teleOk = false;
const flip = {};
let view = "overview", watched = null;

function playerOf(p) {
  if (!p) return { name: "?", title: "", rating: null };
  const u = p.user || {};
  return { name: u.name || (p.aiLevel ? `Stockfish level ${p.aiLevel}` : "?"), id: u.id || "", title: u.title || "",
           rating: p.rating ?? null, provisional: !!p.provisional };
}

function newGame(info) {
  const g = {
    id: info.id, white: playerOf(info.players?.white), black: playerOf(info.players?.black),
    speed: info.speed || "", rated: !!info.rated, clock: info.clock || null,
    chess: new Chess(), sans: [], offset: 0, fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    last: null, check: null, wc: null, bc: null, at: performance.now(), plies: 0,
    over: false, status: "started", winner: null, endedAt: 0, streaming: false,
  };
  g.color = g.white.id === BOT_ID ? "white" : "black";
  return g;
}

function kingSquare(chess) {
  const turn = chess.turn();
  const b = chess.board();
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const p = b[r][f];
    if (p && p.type === "k" && p.color === turn) return sqName(f, 7 - r);
  }
  return null;
}

function plyOf(fen) {
  const p = fen.split(" ");
  return (parseInt(p[5] || "1", 10) - 1) * 2 + (p[1] === "b" ? 1 : 0);
}
function loadFen(g, fen) {
  try { g.chess.load(fen); } catch { return; }
  g.plies = plyOf(fen); g.offset = g.plies; g.sans = [];
}

function applyLine(g, o) {
  if (o.players) {
    g.white = playerOf(o.players.white); g.black = playerOf(o.players.black);
    g.color = g.white.id === BOT_ID ? "white" : "black";
    if (o.speed) g.speed = o.speed;
    g.rated = !!o.rated;
    if (o.clock) g.clock = o.clock;
    if (o.initialFen && o.initialFen !== "startpos") { try { g.chess.load(o.initialFen); } catch { /* ignore */ } }
  }
  if (o.fen) {
    const full = o.fen.split(" ").length > 1 ? o.fen : null;
    if (o.lm) {
      let ok = false;
      try {
        const mv = g.chess.move({ from: o.lm.slice(0, 2), to: o.lm.slice(2, 4), promotion: o.lm[4] || undefined });
        ok = !!mv && (!full || g.chess.fen().split(" ")[0] === full.split(" ")[0]);
        if (ok) g.sans.push(mv.san);
      } catch { ok = false; }
      if (ok) g.plies++;
      else if (full) loadFen(g, full);
      g.last = [o.lm.slice(0, 2), o.lm.slice(2, 4)];
    } else if (full && g.chess.fen().split(" ")[0] !== full.split(" ")[0]) {
      loadFen(g, full);                     // joined mid-game (or a position we could not follow)
    }
    g.fen = g.chess.fen();
    g.check = g.chess.inCheck() ? kingSquare(g.chess) : null;
  }
  if (o.wc !== undefined) { g.wc = o.wc * 1000; g.bc = o.bc * 1000; g.at = performance.now(); }
  if (o.status && typeof o.status === "object" && o.status.name && o.status.name !== "started") {
    if (games.has(g.id)) finish(g, { statusName: o.status.name, winner: o.winner });
    else { g.over = true; g.status = o.status.name; g.winner = o.winner || null; }
  }
}

async function streamGame(g, reconnect = true) {
  if (g.streaming) return;
  g.streaming = true;
  let first = true;
  try {
    await ndjson(`${LI}/api/stream/game/${g.id}`, {}, o => {
      if (first && o.players) { g.chess = new Chess(); g.sans = []; g.plies = 0; }
      first = false;
      applyLine(g, o);
      render();
    });
  } catch { /* network: finish event or reconnect below */ }
  g.streaming = false;
  if (reconnect && !g.over) { await sleep(3000); if (games.has(g.id) && !g.over) streamGame(g); }
}

function finish(g, info) {
  if (g.over) return;
  g.over = true;
  g.status = info.statusName || info.status || "over";
  g.winner = info.winner || null;
  g.endedAt = Date.now();
  setTimeout(() => {
    games.delete(g.id);
    recent.unshift(g);
    recent.splice(20);
    if (watched === g.id && view === "detail") { /* keep showing the finished game */ }
    render();
  }, 45000);
  render();
}

// All games of the bot: current ones at start, then every start / finish.
async function trackGames() {
  for (;;) {
    try {
      setOffline(false);
      await ndjson(`${LI}/api/stream/games-by-users?withCurrentGames=true`,
        { method: "POST", body: BOT_ID, headers: { "Content-Type": "text/plain" } }, o => {
          if (!o.id) return;
          const started = o.statusName === "started" || o.status === 20;
          let g = games.get(o.id);
          if (started) {
            if (!g) { g = newGame(o); games.set(o.id, g); streamGame(g); }
          } else if (g) {
            finish(g, o);
          } else if (!recent.some(r => r.id === o.id)) {
            const r = newGame(o); r.over = true; r.status = o.statusName || ""; r.winner = o.winner || null;
            recent.unshift(r); recent.splice(20);
          }
          render();
        });
    } catch { setOffline(true); }
    await sleep(5000);
  }
}

// ---- profile ----------------------------------------------------------------------------------
let profile = null, online = false;
async function loadProfile() {
  for (;;) {
    try {
      const [p, st] = await Promise.all([
        fetch(`${LI}/api/user/${BOT_ID}`).then(r => r.json()),
        fetch(`${LI}/api/users/status?ids=${BOT_ID}`).then(r => r.json()),
      ]);
      profile = p; online = !!(st[0] && st[0].online);
      renderHeader();
    } catch { /* retry */ }
    await sleep(60000);
  }
}
async function loadLastGame() {
  try {
    const g = await fetch(`${LI}/api/user/${BOT_ID}/current-game`, { headers: { Accept: "application/json" } }).then(r => r.json());
    if (g && g.id && g.status !== "started" && !games.has(g.id) && !recent.some(r => r.id === g.id)) {
      if (extra.has(g.id)) { const x = extra.get(g.id); x.status = g.status; x.winner = g.winner || null; x.white = playerOf(g.players.white); x.black = playerOf(g.players.black); x.color = x.white.id === BOT_ID ? "white" : "black"; x.speed = g.speed; x.rated = !!g.rated; x.clock = g.clock || null; }
      const r = newGame(g); r.over = true; r.status = g.status; r.winner = g.winner || null;
      recent.push(r);
      render();
    }
  } catch { /* optional */ }
}

// ---- telemetry (optional) ----------------------------------------------------------------------
async function pollTelemetry() {
  if (!TELE) { renderTele(); return; }
  for (;;) {
    try {
      const r = await fetch(`${TELE}/api/public/state`, { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      tele = await r.json(); teleAt = performance.now(); teleOk = true;
    } catch { teleOk = false; }
    syncTeleGames();
    renderTele();
    render();
    await sleep(document.hidden ? 8000 : 1500);
  }
}
const teleGames = new Map();
function syncTeleGames() {
  const seen = new Set();
  if (tele && teleOk) {
    for (const t of tele.games) {
      if (games.has(t.id)) continue;
      seen.add(t.id);
      let g = teleGames.get(t.id);
      if (!g) { g = newGame({ id: t.id }); g.fromTele = true; teleGames.set(t.id, g); }
      g.white = { name: t.white.name, title: t.white.title, rating: t.white.rating, id: "" };
      g.black = { name: t.black.name, title: t.black.title, rating: t.black.rating, id: "" };
      g.color = t.color; g.speed = t.speed; g.rated = t.rated; g.tcStr = t.tc;
      g.fen = t.fen; g.last = t.last; g.check = t.check; g.plies = t.ply;
      g.wc = t.wclock; g.bc = t.bclock; g.at = teleAt; g.runColor = t.running;
      g.sans = t.sans || []; g.offset = 0;
      g.over = t.over; g.status = t.status;
      g.winner = t.result === "1-0" ? "white" : t.result === "0-1" ? "black" : null;
    }
  }
  for (const id of [...teleGames.keys()]) if (!seen.has(id)) teleGames.delete(id);
}
function liveGames() { return [...games.values(), ...teleGames.values()]; }

function teleGame(id) {
  if (!tele || !teleOk) return null;
  return tele.games.find(x => x.id === id) || null;
}

// ---- rendering ----------------------------------------------------------------------------------
function orientOf(g) {
  const base = g.color;
  return flip[g.id] ? (base === "white" ? "black" : "white") : base;
}
function running(g) {
  if (g.fromTele) return g.over ? null : g.runColor;
  if (g.over || g.plies < 2) return null;
  return g.chess.turn() === "w" ? "white" : "black";
}
function playerBox(g, color) {
  const p = g[color];
  const box = el("div", "name");
  if (p.title) box.appendChild(el("span", "title", p.title));
  box.appendChild(document.createTextNode(p.name));
  if (p.rating) box.appendChild(el("span", "rating", `${p.rating}${p.provisional ? "?" : ""}`));
  if (g.color === color) box.appendChild(el("span", "me", "BOT"));
  return box;
}
function renderPlayers(root, g, orient) {
  const top = orient === "white" ? "black" : "white";
  for (const [sel, color] of [[".player.top", top], [".player.bottom", orient]]) {
    const row = $(sel, root);
    const key = JSON.stringify([g[color], g.color === color]);
    if (row.dataset.k !== key) { row.dataset.k = key; $(".name", row).replaceWith(playerBox(g, color)); }
    $(".clock", row).dataset.color = color;
  }
}
function tickClocks(root, g) {
  const since = performance.now() - g.at;
  const run = running(g);
  for (const clk of root.querySelectorAll(".clock")) {
    const color = clk.dataset.color;
    if (!color) continue;
    let ms = color === "white" ? g.wc : g.bc;
    if (run === color && ms !== null) ms -= since;
    setText(clk, fmtClock(ms));
    setClass(clk, "run", run === color);
    setClass(clk, "low", ms !== null && ms < 10000);
  }
}
function resultText(g) {
  if (!g.over) return "";
  const res = g.winner === "white" ? "1-0" : g.winner === "black" ? "0-1" : "½-½";
  const mine = g.winner ? (g.winner === g.color ? "won" : "lost") : "draw";
  return `${res} · ${mine} · ${g.status}`;
}
function setEvalBar(bar, t, orient) {
  const win = t && t.win !== null && t.win !== undefined ? t.win : 50;
  const fill = $(".fill", bar), txt = $(".txt", bar);
  setClass(bar, "flip", orient === "black");
  bar.style.opacity = t ? "1" : ".35";
  const h = `${win}%`;
  if (fill.style.height !== h) fill.style.height = h;
  if (txt) {
    setText(txt, t && t.eval !== null ? t.eval_text.replace(/^\+/, "") : "");
    setClass(txt, "top", (win >= 50) === (orient === "black"));
  }
}
function stateText(g, t) {
  if (g.over) return [resultText(g), g.winner ? (g.winner === g.color ? "win" : "loss") : "draw"];
  if (g.fromTele && t && !t.search) return [t.my_turn ? "bot to move" : "opponent to move", ""];
  if (t && t.search === "think") return ["THINKING", "think"];
  if (t && t.search === "ponder") return [`PONDERING ${t.ponder || ""}`, "ponder"];
  const run = running(g);
  if (!run) return ["opening", ""];
  return [run === g.color ? "bot to move" : "opponent to move", ""];
}

const cards = new Map();
function makeCard(g) {
  const c = el("div", "card");
  c.innerHTML = `<div class="head"><span class="idx"></span><span class="tc"></span></div>
    <div class="player top"><div class="name"></div><div class="clock"></div></div>
    <div class="board-row"><div class="evalbar"><div class="fill"></div><span class="txt"></span></div><div class="board"></div></div>
    <div class="player bottom"><div class="name"></div><div class="clock"></div></div>
    <div class="foot"><span class="ev"></span><span class="info dim"></span><span class="state"></span></div>`;
  c.board = new Board($(".board", c), false);
  c.onclick = () => showDetail(g.id);
  return c;
}
function tcText(g) {
  const c = g.clock;
  const tc = g.tcStr || (c ? `${c.initial / 60}+${c.increment}` : "");
  return `${g.rated ? "rated" : "casual"} ${g.speed} ${tc}`.trim();
}

function renderOverview() {
  const box = $("#cards");
  const seen = new Set();
  for (const g of liveGames()) {
    seen.add(g.id);
    let c = cards.get(g.id);
    if (!c) { c = makeCard(g); cards.set(g.id, c); box.appendChild(c); }
    const t = teleGame(g.id);
    const orient = orientOf(g);
    setText($(".idx", c), g.id);
    setText($(".tc", c), tcText(g) + (t && t.limit ? ` · limit ${t.limit}` : ""));
    renderPlayers(c, g, orient);
    c.board.update({ fen: g.fen, last: g.last, check: g.check, orient, banner: resultText(g) });
    setEvalBar($(".evalbar", c), t, orient);
    setText($(".ev", c), t ? t.eval_text : "");
    setText($(".info", c), t ? `d${t.depth} ${human(t.nps)}nps` : `${g.plies} plies`);
    const [st, cls] = stateText(g, t);
    const stEl = $(".state", c);
    setText(stEl, st);
    stEl.className = "state " + cls;
    c.game = g;
  }
  for (const [id, c] of cards) if (!seen.has(id)) { c.remove(); cards.delete(id); }
  $("#empty").hidden = seen.size > 0;
  setText($("#empty-text"), online ? `${BOT} is online, waiting for a game.` : `${BOT} is offline.`);

  const rc = $("#recent");
  const key = recent.map(g => g.id + g.status).join(",");
  if (rc.dataset.k !== key) {
    rc.dataset.k = key;
    rc.textContent = "";
    if (!recent.length) rc.appendChild(el("li", "none", "no finished games seen yet"));
    for (const g of recent) {
      const li = el("li");
      const oc = g.winner ? (g.winner === g.color ? "win" : "loss") : (g.status === "aborted" ? "aborted" : "draw");
      li.appendChild(el("span", `res ${oc}`, oc));
      const opp = g.color === "white" ? g.black : g.white;
      li.appendChild(el("span", "grow", `vs ${opp.title ? opp.title + " " : ""}${opp.name}${opp.rating ? ` (${opp.rating})` : ""} · ${tcText(g)} · ${g.status}`));
      const a = el("a", "", "lichess ↗"); a.href = `${LI}/${g.id}`; a.target = "_blank"; a.rel = "noopener";
      a.onclick = e => e.stopPropagation();
      li.appendChild(a);
      li.style.cursor = "pointer";
      li.onclick = () => showDetail(g.id);
      rc.appendChild(li);
    }
  }
}

const dBoard = new Board($("#d-board"), true);
function findGame(id) {
  return games.get(id) || teleGames.get(id) || extra.get(id) || recent.find(g => g.id === id) || null;
}
function showOverview() { view = "overview"; $("#overview").hidden = false; $("#detail").hidden = true; history.replaceState(null, "", location.pathname + location.search); render(); }
function showDetail(id) {
  const known = findGame(id);
  if (!known && /^[A-Za-z0-9]{8}$/.test(id)) {
    const g = newGame({ id }); g.over = true; g.status = "";
    extra.set(id, g);
    g.loaded = true;
    streamGame(g, false);
  } else if (known && known.over && !known.loaded && !known.streaming) {
    known.loaded = true;            // finished game seen only in a list: fetch its moves once
    streamGame(known, false);
  }
  watched = id; view = "detail";
  $("#overview").hidden = true; $("#detail").hidden = false;
  dBoard.fen = null;
  for (const k of ["#d-table tbody", "#d-moves"]) $(k).dataset.k = "";
  history.replaceState(null, "", `${location.pathname}${location.search}#${id}`);
  render();
}
$("#home").onclick = e => { e.preventDefault(); showOverview(); };
$("#d-back").onclick = () => showOverview();
$("#d-flip").onclick = () => { if (watched) { flip[watched] = !flip[watched]; render(); } };
document.addEventListener("keydown", e => { if (e.key === "Escape" && view === "detail") showOverview(); });

function renderDetail() {
  const g = findGame(watched);
  if (!g) { showOverview(); return; }
  const t = teleGame(g.id);
  const orient = orientOf(g);
  setText($("#d-title"), `${g.id} · ${tcText(g)}${t && t.limit ? ` · rating limit ${t.limit}` : ""}`);
  $("#d-link").href = `${LI}/${g.id}`;
  renderPlayers($("#d-left"), g, orient);
  dBoard.update({ fen: g.fen, last: g.last, check: g.check, orient, banner: resultText(g) });
  setEvalBar($("#d-bar"), t, orient);
  tickClocks($("#d-left"), g);

  const sum = $("#d-summary");
  const tb = $("#d-table tbody");
  setText($("#d-engname"), t ? t.engine : "");
  if (t) {
    const row = t.rows[0];
    const [st, cls] = stateText(g, t);
    const parts = [`<span class="state ${cls}">${st}</span>`];
    if (row) {
      parts.push(`<span class="big">${row.score}</span>`);
      if (row.cp !== null && Math.abs(row.cp) < 90000) parts.push(`<span class="kv">win <b>${winPct(row.cp).toFixed(0)}%</b></span>`);
      parts.push(`<span class="kv">depth <b>${row.d}/${row.sd}</b></span>`);
    }
    parts.push(`<span class="kv">nodes <b>${human(t.live.nodes)}</b></span>`, `<span class="kv">nps <b>${human(t.live.nps)}</b></span>`);
    const html = parts.join("");
    if (sum.dataset.h !== html) { sum.dataset.h = html; sum.innerHTML = html; }
    $("#d-tablewrap").hidden = false;
    const key = JSON.stringify(t.rows);
    if (tb.dataset.k !== key) {
      tb.dataset.k = key; tb.textContent = "";
      for (const r of t.rows) {
        const tr = el("tr");
        tr.append(el("td", "", `${r.d}/${r.sd}`), el("td", r.cp > 30 ? "pos" : r.cp < -30 ? "neg" : "", r.score),
          el("td", "", (r.time / 1000).toFixed(2)), el("td", "", human(r.nodes)), el("td", "", human(r.nps)),
          el("td", "", `${(r.hash / 10).toFixed(0)}%`), el("td", "pv", r.pv));
        tb.appendChild(tr);
      }
    }
  } else {
    const msg = TELE ? (teleOk ? "The bot publishes no data for this game." : "Engine telemetry is offline.")
                     : "Engine output is not published for this mirror (only boards, clocks and moves).";
    const html = `<div class="nodata">${msg}</div>`;
    if (sum.dataset.h !== html) { sum.dataset.h = html; sum.innerHTML = html; }
    $("#d-tablewrap").hidden = true;
    tb.dataset.k = "";
  }
  renderChart(t);
  renderMoves(g, t);
}

function renderMoves(g, t) {
  const box = $("#d-moves");
  const sans = t && t.sans && t.sans.length >= g.sans.length ? t.sans : g.sans;
  const offset = sans === g.sans ? g.offset : 0;
  const evalAt = new Map((t ? t.evals : []).map(e => [e.ply, e]));
  const key = `${sans.length}|${offset}|${evalAt.size}`;
  if (box.dataset.k === key) return;
  box.dataset.k = key;
  box.textContent = "";
  let ply = offset;
  if (ply % 2 === 1) box.append(el("div", "n", `${Math.floor(ply / 2) + 1}.`), el("div", "m", "…"));
  sans.forEach((san, i) => {
    const white = ply % 2 === 0;
    if (white) box.appendChild(el("div", "n", `${ply / 2 + 1}.`));
    const m = el("div", "m", san);
    const e = evalAt.get(ply);
    if (e) { m.classList.add("ours"); m.appendChild(el("span", "e", e.text)); }
    if (i === sans.length - 1) m.classList.add("cur");
    box.appendChild(m);
    ply++;
  });
  box.scrollTop = box.scrollHeight;
}

function renderChart(t) {
  const svg = $("#d-chart");
  const pts = t ? t.evals.filter(e => e.cp !== null) : [];
  const key = pts.map(e => `${e.ply}:${e.cp}`).join(",") + (t ? "" : "none");
  if (svg.dataset.k === key) return;
  svg.dataset.k = key;
  svg.chartPts = pts;
  if (!pts.length) {
    svg.innerHTML = `<text x="500" y="105" text-anchor="middle" fill="#8a8784" font-size="22">${t ? "no evaluations yet" : "no engine data"}</text>`;
    return;
  }
  const maxPly = Math.max(pts[pts.length - 1].ply, 20);
  const X = p => (p / maxPly) * 1000, Y = cp => 200 - winPct(cp) * 2;
  let line = "";
  pts.forEach((e, i) => { line += `${i ? "L" : "M"}${X(e.ply).toFixed(1)},${Y(e.cp).toFixed(1)}`; });
  const area = `M${X(pts[0].ply).toFixed(1)},200 ` + line.replace(/^M/, "L") + ` L${X(pts[pts.length - 1].ply).toFixed(1)},200 Z`;
  svg.innerHTML = `<path d="${area}" fill="#e8e6e3" fill-opacity=".85"/>
    <line x1="0" y1="100" x2="1000" y2="100" stroke="#d85000" stroke-opacity=".6" stroke-dasharray="6 6" vector-effect="non-scaling-stroke"/>
    <path d="${line}" fill="none" stroke="#3692e7" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  svg.maxPly = maxPly;
}
function chartTip(ev) {
  const svg = $("#d-chart"), tip = $("#d-tip");
  const pts = svg.chartPts || [];
  if (!pts.length) { tip.hidden = true; return; }
  const r = svg.getBoundingClientRect();
  const ply = (ev.clientX - r.left) / r.width * svg.maxPly;
  let best = pts[0];
  for (const e of pts) if (Math.abs(e.ply - ply) < Math.abs(best.ply - ply)) best = e;
  tip.textContent = `${Math.floor(best.ply / 2) + 1}${best.ply % 2 ? "…" : "."} ${best.san}  ${best.text}  d${best.d}`;
  tip.hidden = false;
  const x = (best.ply / svg.maxPly) * r.width;
  tip.style.left = `${Math.max(0, Math.min(r.width - tip.offsetWidth, x - tip.offsetWidth / 2))}px`;
}
$("#d-chart").addEventListener("pointermove", chartTip);
$("#d-chart").addEventListener("pointerdown", chartTip);
$("#d-chart").addEventListener("pointerleave", () => { $("#d-tip").hidden = true; });

function renderHeader() {
  const who = $("#who");
  who.href = `${LI}/@/${BOT}`;
  setText($("#user"), profile ? `${profile.title ? profile.title + " " : ""}${profile.username}` : BOT);
  setClass($("#dot"), "ok", online);
  setClass($("#dot"), "bad", !online);
  if (!profile) return;
  const perfs = profile.perfs || {};
  const chips = [];
  for (const k of ["bullet", "blitz", "rapid", "classical"]) {
    const p = perfs[k];
    if (p && p.games) chips.push(`<span class="chip">${k} <b>${p.rating}${p.prov ? "?" : ""}</b></span>`);
  }
  const c = profile.count || {};
  chips.push(`<span class="chip opt"><b class="green">+${c.win || 0}</b> <b class="yellow">=${c.draw || 0}</b> <b class="red">-${c.loss || 0}</b></span>`);
  const html = chips.join("");
  const box = $("#chips");
  if (box.dataset.h !== html) { box.dataset.h = html; box.innerHTML = html; }
}
function renderTele() {
  const p = $("#tele");
  if (!TELE) { p.hidden = true; return; }
  p.hidden = false;
  setText(p, teleOk ? "engine live" : "engine offline");
  setClass(p, "on", teleOk);
}
function setOffline(on) { $("#offline").hidden = !on; }

let pending = false;
function render() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    if (view === "overview") renderOverview(); else renderDetail();
  });
}
setInterval(() => {
  if (view === "overview") { for (const [, c] of cards) if (c.game) tickClocks(c, c.game); }
  else { const g = findGame(watched); if (g) tickClocks($("#d-left"), g); }
}, 100);

document.title = `${BOT} · ClaudyBot Live`;
setText($(".brand span"), `${BOT} Live`);
renderHeader();
renderTele();
trackGames();
loadProfile();
loadLastGame();
pollTelemetry();
window.addEventListener("hashchange", () => {
  const id = location.hash.slice(1);
  if (id && id !== watched) showDetail(id); else if (!id && view === "detail") showOverview();
});
if (location.hash.length > 1) showDetail(location.hash.slice(1)); else render();
