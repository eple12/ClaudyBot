"use strict";
// ClaudyBot browser dashboard. Polls /api/state (and /api/game/<id> in the detail view) and sends
// console commands to /api/cmd. No libraries.

const $ = (s, el = document) => el.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ---- access key (only needed when the dashboard listens on the network) ----------------------
let KEY = new URLSearchParams(location.search).get("key") || "";
try {
  if (KEY) sessionStorage.setItem("claudy-key", KEY); else KEY = sessionStorage.getItem("claudy-key") || "";
} catch { /* ignore */ }

async function api(path, body) {
  const opt = { headers: {}, cache: "no-store" };
  if (KEY) opt.headers["X-Key"] = KEY;
  if (body !== undefined) {
    opt.method = "POST";
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(path, opt);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

// ---- formatting ---------------------------------------------------------------------------
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
function uptime(s) { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`; }

// ---- board ------------------------------------------------------------------------------------
const FILES = "abcdefgh";
const sqName = (f, r) => FILES[f] + (r + 1);
function parseFen(fen) {
  const m = new Map();
  let r = 7, f = 0;
  for (const ch of fen) {
    if (ch === "/") { r--; f = 0; continue; }
    if (ch >= "1" && ch <= "8") { f += +ch; continue; }
    m.set(sqName(f, r), (ch === ch.toUpperCase() ? "w" : "b") + ch.toUpperCase());
    f++;
  }
  return m;
}
for (const c of "wb") for (const p of "KQRBNP") { const i = new Image(); i.src = `/pieces/${c}${p}.svg`; }

class Board {
  constructor(root, coords = true) {
    this.root = root;
    this.coords = coords;
    this.sqEls = [];
    const grid = el("div", "squares");
    for (let i = 0; i < 64; i++) { const d = el("div", "sq"); grid.appendChild(d); this.sqEls.push(d); }
    this.layer = el("div", "pieces");
    root.append(grid, this.layer);
    this.pieces = new Map();          // square -> {el, code}
    this.orient = null;
    this.fen = null;
    this.marks = "";
    this.banner = null;
  }
  xy(sq) {
    const f = FILES.indexOf(sq[0]), r = +sq[1] - 1;
    return this.orient === "white" ? [f, 7 - r] : [7 - f, r];
  }
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
    if (orient !== this.orient) {
      this.orient = orient;
      this.drawSquares();
      still = true;
    }
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
    const next = parseFen(fen);
    const keep = new Map();
    const loose = [];
    for (const [sq, p] of this.pieces) {
      if (next.get(sq) === p.code) keep.set(sq, p); else loose.push([sq, p]);
    }
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
        p.el.style.backgroundImage = `url(/pieces/${code}.svg)`;
        this.layer.appendChild(p.el);
      }
      this.place(p, sq);
      keep.set(sq, p);
    }
    for (const [, p] of loose) {
      if (still) p.el.remove();
      else { p.el.classList.add("gone"); setTimeout(() => p.el.remove(), 230); }
    }
    if (still) for (const [sq, p] of keep) this.place(p, sq);
    this.pieces = keep;
    this.fen = fen;
    if (still) { void this.root.offsetWidth; this.root.classList.remove("still"); }
  }
  setBanner(text) {
    if (!text) { if (this.banner) { this.banner.remove(); this.banner = null; } return; }
    if (!this.banner) { this.banner = el("div", "banner"); this.root.appendChild(this.banner); }
    setText(this.banner, text);
  }
}

function setEvalBar(bar, g, orient) {
  const win = g.win === null || g.win === undefined ? 50 : g.win;
  const fill = $(".fill", bar), txt = $(".txt", bar);
  setClass(bar, "flip", orient === "black");
  const h = `${win}%`;
  if (fill.style.height !== h) fill.style.height = h;
  if (txt) {
    setText(txt, g.eval === null ? "" : g.eval_text.replace(/^\+/, ""));
    // number on the side that is ahead, in that side's contrasting colour
    const whiteAhead = win >= 50;
    setClass(txt, "top", whiteAhead === (orient === "black"));
  }
}

function playerHTML(g, color) {
  const p = g[color];
  const box = el("div", "name");
  if (p.title) box.appendChild(el("span", "title", p.title));
  box.appendChild(document.createTextNode(p.name));
  if (p.rating) box.appendChild(el("span", "rating", `${p.rating}${p.provisional ? "?" : ""}`));
  if (g.color === color) box.appendChild(el("span", "me", "ENGINE"));
  return box;
}

function stateText(g, since) {
  if (g.over) return [`${g.result} ${g.outcome || ""} (${g.status})`, g.outcome || ""];
  if (g.search === "think") return [`THINKING ${(g.search_s + since).toFixed(1)}s`, "think"];
  if (g.search === "ponder") return [`PONDERING ${g.ponder || ""}`, "ponder"];
  if (g.status === "started") return [g.my_turn ? "to move" : "waiting for opponent", ""];
  return [g.status, ""];
}

function bannerText(g) {
  if (!g.over) return "";
  const words = { win: "won", loss: "lost", draw: "draw" };
  return `${g.result} · ${words[g.outcome] || g.outcome || ""} · ${g.status}`;
}

// ---- state -------------------------------------------------------------------------------------
const S = {
  view: "overview",
  watched: null,
  flip: store.get("claudy-flip", {}),
  state: null,
  stateAt: 0,
  detail: null,
  detailAt: 0,
  logNext: 0,
  rawNext: 0,
  rawGame: null,
  cards: new Map(),
  offline: false,
  history: store.get("claudy-history", []),
  hpos: -1,
};

function orientOf(g) {
  const base = g.color;
  const flip = !!S.flip[g.id];
  return flip ? (base === "white" ? "black" : "white") : base;
}

// ---- log --------------------------------------------------------------------------------------
const logEl = $("#log");
function logAppend(nodes) {
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 30;
  for (const n of nodes) logEl.appendChild(n);
  while (logEl.childElementCount > 600) logEl.firstElementChild.remove();
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}
function logLine(time, cls, html) {
  const d = el("div", cls);
  if (time) d.appendChild(el("span", "t", time));
  const s = el("span");
  s.innerHTML = html;          // server-escaped markup
  d.appendChild(s);
  return d;
}
if (store.get("claudy-log", false)) document.body.classList.add("log-open");
$("#log-toggle").onclick = () => {
  document.body.classList.toggle("log-open");
  store.set("claudy-log", document.body.classList.contains("log-open"));
  logEl.scrollTop = logEl.scrollHeight;
};

// ---- commands ---------------------------------------------------------------------------------
async function runCommand(line, echo = true) {
  line = line.trim();
  if (!line) return;
  if (echo) {
    S.history = [line, ...S.history.filter(h => h !== line)].slice(0, 100);
    store.set("claudy-history", S.history);
  }
  const nodes = [logLine("", "cmd", `› ${line.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}`)];
  try {
    const r = await api("/api/cmd", { line, watched: S.view === "detail" ? S.watched : null });
    if (r.clear) logEl.textContent = "";
    for (const l of r.lines) nodes.push(logLine("", "", l));
    if (r.go === "") showOverview();
    else if (r.go) showDetail(r.go);
    if (r.lines.length && !document.body.classList.contains("log-open")) {
      document.body.classList.add("log-open");
    }
  } catch (e) {
    nodes.push(logLine("", "error", `command failed: ${e.message}`));
  }
  logAppend(nodes);
  poll(true);
}
$("#cmd-form").onsubmit = ev => {
  ev.preventDefault();
  const i = $("#cmd");
  const v = i.value;
  i.value = "";
  S.hpos = -1;
  runCommand(v);
};
$("#cmd").addEventListener("keydown", ev => {
  if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
    if (!S.history.length) return;
    S.hpos = Math.max(-1, Math.min(S.history.length - 1, S.hpos + (ev.key === "ArrowUp" ? 1 : -1)));
    ev.target.value = S.hpos < 0 ? "" : S.history[S.hpos];
    ev.preventDefault();
  } else if (ev.key === "Escape") {
    ev.target.blur();
  }
});
document.addEventListener("keydown", ev => {
  if (ev.key === "Escape" && document.activeElement.tagName !== "INPUT" && S.view === "detail") showOverview();
});
function confirmRun(question, line) { if (confirm(question)) runCommand(line); }

// ---- header -------------------------------------------------------------------------------------
$("#home").onclick = () => showOverview();
$("#btn-pause").onclick = () => runCommand(S.state && S.state.paused ? "resume" : "pause");
$("#btn-mm").onclick = () => runCommand(`match ${S.state && S.state.matchmaking ? "off" : "on"}`);

function renderHeader(st) {
  setText($("#user"), st.user);
  const dot = $("#dot");
  setClass(dot, "ok", st.stream);
  setClass(dot, "bad", !st.stream);
  dot.title = st.stream ? "event stream connected" : "event stream down";
  const r = st.results;
  const chips = [
    ["games", `<b>${st.games.length}</b>/${st.limit}`, ""],
    ["queue", `<b>${st.queue.length}</b>`, "opt"],
    ["score", `<b class="green">+${r.win}</b> <b class="yellow">=${r.draw}</b> <b class="red">-${r.loss}</b>`, ""],
    ["up", uptime(st.up), "opt"],
  ];
  const html = chips.map(([k, v, c]) => `<span class="chip ${c}">${k} ${v}</span>`).join("")
    + (st.quitting ? `<span class="chip red">quitting (${st.quitting})</span>` : "");
  const box = $("#chips");
  if (box.dataset.h !== html) { box.dataset.h = html; box.innerHTML = html; }
  const bp = $("#btn-pause");
  setText(bp, st.paused ? "Paused — resume" : "Accepting challenges");
  setClass(bp, "on", !st.paused);
  setClass(bp, "off", st.paused);
  const bm = $("#btn-mm");
  setText(bm, `Matchmaking ${st.matchmaking ? "on" : "off"}`);
  setClass(bm, "on", st.matchmaking);
  const dl = $("#cmds");
  if (dl.childElementCount !== st.cmds.length) {
    dl.textContent = "";
    for (const c of st.cmds) { const o = el("option"); o.value = c; dl.appendChild(o); }
  }
}

// ---- overview -------------------------------------------------------------------------------------
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

function renderPlayers(root, g, orient) {
  const topColor = orient === "white" ? "black" : "white";
  for (const [sel, color] of [[".player.top", topColor], [".player.bottom", orient]]) {
    const row = $(sel, root);
    const key = JSON.stringify([g[color], g.color === color]);
    if (row.dataset.k !== key) {
      row.dataset.k = key;
      $(".name", row).replaceWith(playerHTML(g, color));
    }
    const clk = $(".clock", row);
    clk.dataset.color = color;
  }
}

function tickClocks(root, g, fetchedAt) {
  if (!g) return;
  const since = (performance.now() - fetchedAt) / 1000;
  for (const clk of root.querySelectorAll(".clock")) {
    const color = clk.dataset.color;
    if (!color) continue;
    let ms = color === "white" ? g.wclock : g.bclock;
    const run = g.running === color;
    if (run && ms !== null) ms -= since * 1000;
    setText(clk, fmtClock(ms));
    setClass(clk, "run", run);
    setClass(clk, "low", ms !== null && ms < 10000);
  }
}

function renderOverview(st) {
  const cards = $("#cards");
  const seen = new Set();
  for (const g of st.games) {
    seen.add(g.id);
    let c = S.cards.get(g.id);
    if (!c) { c = makeCard(g); S.cards.set(g.id, c); cards.appendChild(c); }
    const orient = orientOf(g);
    setText($(".idx", c), `[${g.idx}] ${g.id}`);
    setText($(".tc", c), `${g.rated ? "rated" : "casual"} ${g.speed} ${g.tc}${g.limit ? ` · limit ${g.limit}` : ""}`);
    renderPlayers(c, g, orient);
    c.board.update({ fen: g.fen, last: g.last, check: g.check, orient, banner: bannerText(g) });
    setEvalBar($(".evalbar", c), g, orient);
    setText($(".ev", c), g.eval_text);
    setText($(".info", c), `d${g.depth} ${human(g.nps)}nps`);
    const [t, cls] = stateText(g, 0);
    const stEl = $(".state", c);
    setText(stEl, t);
    stEl.className = "state " + cls;
    setClass(c, "myturn", g.my_turn && !g.over);
    c.game = g;
  }
  for (const [id, c] of S.cards) if (!seen.has(id)) { c.remove(); S.cards.delete(id); }
  $("#empty").hidden = st.games.length > 0;

  const q = $("#queue");
  const qk = JSON.stringify(st.queue);
  if (q.dataset.k !== qk) {
    q.dataset.k = qk;
    q.textContent = "";
    if (!st.queue.length) q.appendChild(el("li", "none", "no waiting challenges"));
    st.queue.forEach((ch, i) => {
      const li = el("li");
      li.appendChild(el("span", "dim", `${i + 1}.`));
      li.appendChild(el("span", "grow", `${ch.title ? ch.title + " " : ""}${ch.who}${ch.rating ? ` (${ch.rating})` : ""} · ${ch.tc} ${ch.speed} ${ch.rated ? "rated" : "casual"}`));
      const a = el("button", "", "Accept"); a.onclick = () => runCommand(`accept ${ch.id}`);
      const d = el("button", "", "Decline"); d.onclick = () => runCommand(`decline ${ch.id}`);
      li.append(a, d);
      q.appendChild(li);
    });
  }
  const rc = $("#recent");
  const rk = JSON.stringify(st.recent);
  if (rc.dataset.k !== rk) {
    rc.dataset.k = rk;
    rc.textContent = "";
    if (!st.recent.length) rc.appendChild(el("li", "none", "no finished games yet"));
    for (const g of st.recent) {
      const li = el("li");
      li.appendChild(el("span", `res ${g.outcome}`, g.outcome));
      li.appendChild(el("span", "num", g.result));
      li.appendChild(el("span", "grow", `vs ${g.opponent} · ${g.tc} · ${g.status}`));
      const a = el("a", "", "view ↗"); a.href = g.url; a.target = "_blank"; a.rel = "noopener";
      li.appendChild(a);
      rc.appendChild(li);
    }
  }
}

// ---- detail ----------------------------------------------------------------------------------
const dBoard = new Board($("#d-board"), true);

function showOverview() {
  S.view = "overview";
  $("#overview").hidden = false;
  $("#detail").hidden = true;
  if (S.state) renderOverview(S.state);
}
function showDetail(id) {
  if (S.watched !== id) {
    S.watched = id;
    S.detail = null;
    S.rawNext = 0;
    S.rawGame = id;
    $("#d-raw").textContent = "";
    $("#d-table tbody").textContent = "";
    $("#d-moves").textContent = "";
    $("#d-chat").textContent = "";
    dBoard.fen = null;
  }
  S.view = "detail";
  $("#overview").hidden = true;
  $("#detail").hidden = false;
  poll(true);
}
function cycle(step) {
  const games = (S.state && S.state.games) || [];
  if (!games.length) return;
  const i = games.findIndex(g => g.id === S.watched);
  showDetail(games[(i + step + games.length) % games.length].id);
}
$("#d-prev").onclick = () => cycle(-1);
$("#d-next").onclick = () => cycle(1);
$("#d-flip").onclick = () => {
  if (!S.watched) return;
  S.flip[S.watched] = !S.flip[S.watched];
  store.set("claudy-flip", S.flip);
  if (S.detail) renderDetail(S.detail, false);
};
$("#d-draw").onclick = () => runCommand(`draw ${S.watched}`);
$("#d-abort").onclick = () => confirmRun("Abort this game?", `abort ${S.watched}`);
$("#d-resign").onclick = () => confirmRun("Resign this game?", `resign ${S.watched}`);
$("#chat-form").onsubmit = ev => {
  ev.preventDefault();
  const i = $("#chat-in");
  if (i.value.trim() && S.watched) runCommand(`chat ${S.watched} ${i.value.trim()}`, false);
  i.value = "";
};

function renderDetail(g, animate = true) {
  const orient = orientOf(g);
  const left = $("#d-left");
  setText($("#d-title"), `${g.idx ? `[${g.idx}] ` : ""}${g.id} · ${g.rated ? "rated" : "casual"} ${g.speed} ${g.tc}` +
    (g.limit ? ` · rating limit ${g.limit}` : "") +
    (g.opp_gone ? " · opponent left" : "") + ((g.color === "white" ? g.bdraw : g.wdraw) ? " · draw offered" : ""));
  renderPlayers(left, g, orient);
  dBoard.update({ fen: g.fen, last: g.last, check: g.check, orient, animate, banner: bannerText(g) });
  setEvalBar($("#d-bar"), g, orient);
  const link = $("#d-link");
  if (link.href !== g.url) link.href = g.url;
  for (const id of ["#d-draw", "#d-abort", "#d-resign"]) $(id).disabled = g.over;

  // engine summary
  setText($("#d-engname"), g.engine);
  const row = g.rows[0];
  const live = g.live;
  const [st, cls] = stateText(g, 0);
  const sum = $("#d-summary");
  const parts = [`<span class="state ${cls}" id="d-state">${st}</span>`];
  if (row) {
    parts.push(`<span class="big">${row.score}</span>`);
    if (row.cp !== null && Math.abs(row.cp) < 90000) parts.push(`<span class="kv">win <b>${winPct(row.cp).toFixed(0)}%</b></span>`);
    parts.push(`<span class="kv">depth <b>${row.d}/${row.sd}</b></span>`);
  }
  parts.push(`<span class="kv">nodes <b>${human(live.nodes)}</b></span>`, `<span class="kv">nps <b>${human(live.nps)}</b></span>`,
    `<span class="kv">hash <b>${(live.hash / 10).toFixed(0)}%</b></span>`, `<span class="kv">tb <b>${human(live.tb)}</b></span>`);
  if (g.ponder_total) parts.push(`<span class="kv">ponderhit <b>${g.ponder_hits}/${g.ponder_total}</b></span>`);
  if (g.lag) parts.push(`<span class="kv">${g.lag.replace(/[<>&]/g, "")} · overhead <b>${g.overhead ?? "-"}</b> ms</span>`);
  const sh = parts.join("");
  if (sum.dataset.h !== sh) { sum.dataset.h = sh; sum.innerHTML = sh; }

  // search table
  const tb = $("#d-table tbody");
  const tk = JSON.stringify(g.rows.slice(0, 25));
  if (tb.dataset.k !== tk) {
    tb.dataset.k = tk;
    tb.textContent = "";
    for (const r of g.rows.slice(0, 25)) {
      const tr = el("tr");
      const sc = el("td", r.cp > 30 ? "pos" : r.cp < -30 ? "neg" : "", r.score + (r.bound === "lowerbound" ? "↑" : r.bound === "upperbound" ? "↓" : ""));
      tr.append(el("td", "", `${r.d}/${r.sd}`), sc, el("td", "", (r.time / 1000).toFixed(2)), el("td", "", human(r.nodes)),
        el("td", "", human(r.nps)), el("td", "", `${(r.hash / 10).toFixed(0)}%`), el("td", "", human(r.tb)), el("td", "pv", r.pv));
      tb.appendChild(tr);
    }
  }
  renderChart(g);
  renderMoves(g);

  // chat
  const ch = $("#d-chat");
  const ck = JSON.stringify(g.chat);
  if (ch.dataset.k !== ck) {
    ch.dataset.k = ck;
    ch.textContent = "";
    for (const [t, room, user, text] of g.chat) {
      const d = el("div", "line");
      d.append(el("span", "room", `${t} ${room === "spectator" ? "[spec] " : ""}`), el("span", "who", `${user}: `), document.createTextNode(text));
      ch.appendChild(d);
    }
    ch.scrollTop = ch.scrollHeight;
  }

  // raw engine I/O (incremental)
  if (g.raw.length) {
    const pre = $("#d-raw");
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
    const frag = document.createDocumentFragment();
    for (const [t, dir, text] of g.raw) {
      const line = el("div", dir === ">" ? "o" : "");
      const d = new Date(t * 1000);
      line.append(el("span", "t", `${d.toTimeString().slice(0, 8)} ${dir} `), document.createTextNode(text));
      frag.appendChild(line);
    }
    pre.appendChild(frag);
    while (pre.childElementCount > 800) pre.firstElementChild.remove();
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }
  S.rawNext = g.raw_next;
}

function renderMoves(g) {
  const box = $("#d-moves");
  const key = `${g.sans.length}|${g.evals.length}|${g.color}`;
  if (box.dataset.k === key) return;
  box.dataset.k = key;
  box.textContent = "";
  const evalAt = new Map(g.evals.map(e => [e.ply, e]));
  const ourFirst = (g.color === "white") === g.start_white ? 0 : 1;   // parity of our plies
  let moveNo = g.start_move;
  let ply = 0;
  if (!g.start_white) {
    box.append(el("div", "n", `${moveNo}.`), el("div", "m", "…"));
  }
  for (const san of g.sans) {
    const white = (ply % 2 === 0) === g.start_white;
    if (white) box.appendChild(el("div", "n", `${moveNo}.`));
    const m = el("div", "m", san);
    if (ply % 2 === ourFirst) {
      m.classList.add("ours");
      const e = evalAt.get(ply);
      if (e) m.appendChild(el("span", "e", e.text));
    }
    if (ply === g.sans.length - 1) m.classList.add("cur");
    box.appendChild(m);
    if (!white) moveNo++;
    ply++;
  }
  box.scrollTop = box.scrollHeight;
}

function renderChart(g) {
  const svg = $("#d-chart");
  const pts = g.evals.filter(e => e.cp !== null);
  const key = pts.map(e => `${e.ply}:${e.cp}`).join(",");
  if (svg.dataset.k === key) return;
  svg.dataset.k = key;
  svg.chartPts = pts;
  if (!pts.length) { svg.innerHTML = `<text x="500" y="105" text-anchor="middle" fill="#8a8784" font-size="22">no evaluations yet</text>`; return; }
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
  const moveNo = Math.floor(best.ply / 2) + 1;
  tip.textContent = `${moveNo}${best.ply % 2 ? "…" : "."} ${best.san}  ${best.text}  d${best.d}  ${human(best.nps)}nps${best.ph ? "  ponderhit" : ""}`;
  tip.hidden = false;
  const x = (best.ply / svg.maxPly) * r.width;
  tip.style.left = `${Math.max(0, Math.min(r.width - tip.offsetWidth, x - tip.offsetWidth / 2))}px`;
}
$("#d-chart").addEventListener("pointermove", chartTip);
$("#d-chart").addEventListener("pointerdown", chartTip);
$("#d-chart").addEventListener("pointerleave", () => { $("#d-tip").hidden = true; });

// ---- polling -------------------------------------------------------------------------------
let timer = null;
let busy = false;
async function poll(now = false) {
  if (now) { clearTimeout(timer); timer = null; }
  if (busy) return;
  busy = true;
  try {
    const st = await api(`/api/state?log=${S.logNext}`);
    S.state = st;
    S.stateAt = performance.now();
    if (st.log.length) logAppend(st.log.map(([t, lvl, html]) => logLine(t, lvl, html)));
    S.logNext = st.log_next;
    renderHeader(st);
    if (S.view === "overview") renderOverview(st);
    if (S.view === "detail" && S.watched) {
      const first = !S.detail || S.detail.id !== S.watched;
      try {
        const g = await api(`/api/game/${S.watched}?raw=${S.rawGame === S.watched ? S.rawNext : 0}`);
        S.detail = g;
        S.detailAt = performance.now();
        renderDetail(g, !first);
      } catch (e) {
        if (e.message === "404") showOverview(); else throw e;
      }
    }
    if (S.offline) { S.offline = false; $("#offline").hidden = true; }
  } catch (e) {
    if (!S.offline) { S.offline = true; $("#offline").hidden = false; }
  } finally {
    busy = false;
    const delay = S.offline ? 2000 : document.hidden ? 3000 : 500;
    clearTimeout(timer);
    timer = setTimeout(poll, delay);
  }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(true); });

// clocks and "THINKING x.xs" move smoothly between polls
setInterval(() => {
  if (S.view === "overview" && S.state) {
    for (const [, c] of S.cards) tickClocks(c, c.game, S.stateAt);
  } else if (S.view === "detail" && S.detail) {
    tickClocks($("#d-left"), S.detail, S.detailAt);
    const g = S.detail;
    if (g.search === "think" && !g.over) setText($("#d-state"), stateText(g, (performance.now() - S.detailAt) / 1000)[0]);
  }
}, 100);

poll(true);
