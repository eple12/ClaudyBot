"""Bot manager: event stream, challenge queue, games, matchmaking."""
from __future__ import annotations

import asyncio
import logging
import random
import time
from collections import Counter, deque
from typing import Callable

import httpx

from .challenges import Challenge, check
from .config import Config, token_shape
from .game import GameSession, LagTracker
from .lichess import Lichess, LichessError

LEVELS = {"debug": 10, "info": 20, "warning": 30, "error": 40}


def speed_of(limit: int, inc: int) -> str:
    est = limit + 40 * inc
    if est < 30:
        return "ultraBullet"
    if est < 180:
        return "bullet"
    if est < 480:
        return "blitz"
    if est < 1500:
        return "rapid"
    return "classical"


def parse_tc(tc: str) -> tuple[int, int]:
    """'3+2' -> (180, 2); '0.5+0' -> (30, 0)."""
    base, _, inc = tc.partition("+")
    return int(round(float(base) * 60)), int(inc or 0)


class BotManager:
    def __init__(self, cfg: Config, url: str | None = None, echo: Callable[[str], None] | None = None):
        self.cfg = cfg
        self.base_url = (url or cfg.get("url")).rstrip("/")
        self.web_url = self.base_url
        self.echo = echo
        self.events: deque[tuple[float, str, str]] = deque(maxlen=2000)
        self.events_total = 0
        self._setup_file_log()
        self.li = Lichess(self.base_url, cfg.token(), self.log)
        self.username = "?"
        self.user_id = "?"
        self.account: dict = {}
        self.games: dict[str, GameSession] = {}
        self.finished: deque[GameSession] = deque(maxlen=50)
        self.queue: list[Challenge] = []
        self.pending_accept: dict[str, float] = {}
        self.outgoing: dict[str, tuple[Challenge, float]] = {}
        self.results: Counter = Counter()
        self.started = time.time()
        self.stream_ok = False
        self.last_event_at = 0.0
        self.last_idle_start = time.monotonic()
        self.last_mm_attempt = 0.0
        self.mm_avoid: dict[str, float] = {}
        self.quitting: str | None = None           # None | "graceful" | "now"
        self.stopped = asyncio.Event()
        self.fatal: str | None = None
        self.tasks: list[asyncio.Task] = []
        self.web = None                             # WebServer (browser dashboard), see web.py
        self.tunnel = None                          # Tunnel (public telemetry), see tunnel.py
        self._tunnel_task: asyncio.Task | None = None
        self.lag = LagTracker()                     # network lag per move, shared by all games

    # ---- logging -------------------------------------------------------------
    def _setup_file_log(self) -> None:
        path = self.cfg.resolve(self.cfg.get("log.file"))
        path.parent.mkdir(parents=True, exist_ok=True)
        self.file_log = logging.getLogger("claudybot")
        self.file_log.setLevel(logging.DEBUG)
        if not self.file_log.handlers:
            h = logging.FileHandler(path, encoding="utf-8")
            h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
            self.file_log.addHandler(h)

    def log(self, level: str, msg: str) -> None:
        self.file_log.log(LEVELS.get(level, 20), msg)
        if LEVELS.get(level, 20) < LEVELS.get(self.cfg.get("log.level"), 20):
            return
        self.events.append((time.time(), level, msg))
        self.events_total += 1
        if self.echo:
            self.echo(f"{time.strftime('%H:%M:%S')} {level.upper():7} {msg}")

    # ---- state -----------------------------------------------------------------
    @property
    def paused(self) -> bool:
        return not self.cfg.get("challenge.accept")

    def active_count(self) -> int:
        return len(self.games) + len(self.pending_accept)

    def game_list(self) -> list[GameSession]:
        return list(self.games.values())

    # ---- lifecycle ---------------------------------------------------------------
    async def run(self) -> None:
        if self.web is not None and self.web.server is None:
            try:
                await self.web.start()
            except OSError as e:
                self.log("error", f"web dashboard: cannot listen on {self.web.host}:{self.web.port} ({e.strerror or e})")
            if self.web.pub_server and self.cfg.get("web.tunnel") and self.tunnel is None:
                from .tunnel import Tunnel
                self.tunnel = Tunnel(self, int(self.cfg.get("web.public_port")), str(self.cfg.get("web.tunnel_exe")),
                                     str(self.cfg.get("web.tunnel_gist") or ""))
                self._tunnel_task = asyncio.create_task(self.tunnel.start(), name="tunnel")
        try:
            acct = await self.li.account()
        except LichessError as e:
            if e.status == 401:
                tok, src = self.cfg.token_source()
                self.fatal = (f"token rejected by Lichess (HTTP 401): {token_shape(tok)}, from {src}. "
                              f"A personal token usually looks like lip_ + 20 letters/digits, created while "
                              f"logged in as the BOT account (python -m claudybot --check shows details)")
            else:
                self.fatal = f"cannot reach Lichess: {e}"
            self.log("error", self.fatal)
            self.stopped.set()
            return
        except httpx.HTTPError as e:
            self.fatal = f"cannot reach {self.base_url}: {e!r}"
            self.log("error", self.fatal)
            self.stopped.set()
            return
        self.account = acct
        self.username = acct.get("username", "?")
        self.user_id = acct.get("id", self.username.lower())
        self.li.set_username(self.username)
        if acct.get("title") != "BOT":
            self.log("warning", f"{self.username} is not a BOT account - the Bot API will refuse to play")
        self.log("info", f"logged in as {self.username} on {self.base_url}")
        try:
            for g in await self.li.playing():
                gid = g.get("gameId") or g.get("id")
                if gid and gid not in self.games:
                    self.log("info", f"resuming ongoing game {gid}")
                    self._start_game(gid, g)
        except (LichessError, httpx.HTTPError) as e:
            self.log("warning", f"could not list ongoing games: {e}")
        self.tasks = [asyncio.create_task(self._event_loop(), name="events"),
                      asyncio.create_task(self._housekeeping(), name="housekeeping")]
        await self.stopped.wait()

    async def close(self) -> None:
        for g in list(self.games.values()):
            g.cancel()
        for t in self.tasks:
            t.cancel()
        # give cancelled games a moment to kill their engines
        for _ in range(30):
            if not self.games:
                break
            await asyncio.sleep(0.1)
        for g in list(self.games.values()):
            if g.engine:
                await g.engine.quit()
        await self.li.close()
        if self.tunnel is not None:
            if self._tunnel_task and not self._tunnel_task.done():
                self._tunnel_task.cancel()
            await self.tunnel.stop()
        if self.web is not None:
            await self.web.stop()

    async def quit(self, now: bool = False) -> None:
        if now or not self.games:
            self.quitting = "now"
            self.stopped.set()
            return
        self.quitting = "graceful"
        self.log("info", f"quitting after {len(self.games)} running game(s) finish; new challenges are declined")
        for ch in list(self.queue):
            await self.decline(ch.id, "later")

    # ---- event stream ----------------------------------------------------------------
    async def _event_loop(self) -> None:
        failures = 0
        while not self.stopped.is_set():
            try:
                async for ev in self.li.event_stream():
                    if not self.stream_ok:
                        self.log("info", "event stream connected")
                    self.stream_ok = True
                    failures = 0
                    self.last_event_at = time.monotonic()
                    if ev:
                        try:
                            await self._on_event(ev)
                        except Exception as e:
                            self.log("error", f"event handling failed: {e!r} ({ev.get('type')})")
            except LichessError as e:
                if e.status == 401:
                    self.fatal = "token rejected (HTTP 401)"
                    self.log("error", self.fatal)
                    self.stopped.set()
                    return
                self.log("warning", f"event stream: {e}")
            except (httpx.HTTPError, OSError) as e:
                self.log("warning", f"event stream disconnected: {e!r}")
            self.stream_ok = False
            failures += 1
            await asyncio.sleep(min(2 ** min(failures, 5), 60))

    async def _on_event(self, ev: dict) -> None:
        t = ev.get("type")
        if t == "challenge":
            await self._on_challenge(ev["challenge"])
        elif t == "challengeCanceled":
            cid = ev["challenge"]["id"]
            self.queue = [c for c in self.queue if c.id != cid]
            self.outgoing.pop(cid, None)
            self.log("info", f"challenge {cid} canceled")
        elif t == "challengeDeclined":
            c = ev["challenge"]
            cid = c["id"]
            ch = self.outgoing.pop(cid, None)
            who = ch[0].challenger if ch else (c.get("destUser") or {}).get("name", "?")
            self.log("info", f"{who} declined our challenge: {c.get('declineReason') or c.get('declineReasonKey', '')}")
            self.mm_avoid[who.lower()] = time.monotonic() + 3600
        elif t == "gameStart":
            g = ev["game"]
            gid = g.get("gameId") or g.get("id")
            self.pending_accept.pop(gid, None)
            self.outgoing.pop(gid, None)
            if gid not in self.games:
                self._start_game(gid, g)
        elif t == "gameFinish":
            g = ev["game"]
            gid = g.get("gameId") or g.get("id")
            self.pending_accept.pop(gid, None)

    def _start_game(self, gid: str, start_event: dict | None) -> None:
        if self.stopped.is_set():
            return
        g = GameSession(self, gid, start_event)
        self.games[gid] = g
        opp = (start_event or {}).get("opponent") or {}
        self.log("info", f"game {gid} started vs {opp.get('username', '?')} ({self.web_url}/{gid})")
        g.start()

    def on_game_end(self, g: GameSession) -> None:
        self.games.pop(g.id, None)
        self.finished.appendleft(g)
        if g.moves:
            self.results[g.outcome_for_me()] += 1
        if not self.games:
            self.last_idle_start = time.monotonic()
        if self.quitting == "graceful" and not self.games:
            self.log("info", "all games finished; quitting")
            self.stopped.set()
            return
        asyncio.create_task(self._accept_from_queue())

    # ---- challenges ----------------------------------------------------------------
    async def _on_challenge(self, c: dict) -> None:
        ch = Challenge.from_event(c, self.user_id)
        if ch.direction == "out" or ch.challenger_id == self.user_id:
            self.outgoing[ch.id] = (ch, time.monotonic())
            return
        self.log("info", f"challenge {ch.id} from {ch.label()}")
        if self.quitting:
            await self.decline(ch.id, "later")
            return
        if self.paused:
            if self.cfg.get("challenge.paused_action") == "decline":
                await self.decline(ch.id, "later")
            else:
                self.log("info", f"paused: leaving challenge {ch.id} unanswered")
            return
        vs = sum(1 for g in self.games.values() if (g.opponent.get("id") or "").lower() == ch.challenger_id)
        vs += sum(1 for q in self.queue if q.challenger_id == ch.challenger_id)
        ok, reason = check(ch, self.cfg.get("challenge"), vs)
        if not ok:
            await self.decline(ch.id, reason)
            return
        free = self.active_count() < self.cfg.get("challenge.concurrency")
        if not free and len(self.queue) >= self.cfg.get("challenge.queue_size"):
            await self.decline(ch.id, "later")
            return
        self.queue.append(ch)
        if self.cfg.get("challenge.sort") == "best":
            self.queue.sort(key=lambda q: -(q.rating or 0))
        await self._accept_from_queue()

    async def _accept_from_queue(self) -> None:
        while (self.queue and not self.paused and not self.quitting
               and self.active_count() < self.cfg.get("challenge.concurrency")):
            ch = self.queue.pop(0)
            await self.accept(ch.id)

    async def accept(self, cid: str) -> bool:
        try:
            await self.li.accept(cid)
            self.pending_accept[cid] = time.monotonic()
            self.log("info", f"accepted challenge {cid}")
            return True
        except LichessError as e:
            self.log("warning", f"accept {cid} failed: {e}")
            return False

    async def decline(self, cid: str, reason: str = "generic") -> None:
        self.queue = [c for c in self.queue if c.id != cid]
        try:
            await self.li.decline(cid, reason)
            self.log("info", f"declined challenge {cid} ({reason})")
        except LichessError as e:
            self.log("warning", f"decline {cid} failed: {e}")

    async def send_challenge(self, user: str, limit: int, inc: int, rated: bool, color: str = "random") -> None:
        try:
            r = await self.li.create_challenge(user, limit=limit, increment=inc, rated=rated, color=color)
        except LichessError as e:
            msg = e.json().get("error") or str(e)
            self.log("warning", f"challenge to {user} failed: {msg}")
            if e.status == 400:
                self.mm_avoid[user.lower()] = time.monotonic() + 3600
            return
        c = r.get("challenge", r)
        if "id" in c:
            ch = Challenge.from_event(c, self.user_id)
            self.outgoing[ch.id] = (ch, time.monotonic())
            self.log("info", f"challenged {user} ({limit // 60 if limit >= 60 else limit / 60:g}+{inc}, "
                             f"{'rated' if rated else 'casual'}) id {ch.id}")
        else:
            self.log("warning", f"unexpected challenge response: {str(r)[:200]}")

    async def cancel_challenge(self, cid: str) -> None:
        self.outgoing.pop(cid, None)
        try:
            await self.li.cancel_challenge(cid)
            self.log("info", f"canceled our challenge {cid}")
        except LichessError as e:
            self.log("warning", f"cancel {cid} failed: {e}")

    # ---- matchmaking ------------------------------------------------------------------
    async def matchmake(self, force: bool = False) -> None:
        mm = self.cfg.get("matchmaking")
        self.last_mm_attempt = time.monotonic()
        try:
            bots = await self.li.online_bots(150)
        except (LichessError, httpx.HTTPError) as e:
            self.log("warning", f"matchmaking: cannot list online bots: {e}")
            return
        tc = random.choice(mm["tc"] or ["3+2"])
        limit, inc = parse_tc(tc)
        speed = speed_of(limit, inc)
        now = time.monotonic()
        block = {b.lower() for b in mm["block_list"]} | {b.lower() for b in self.cfg.get("challenge.block_list")}
        cands = []
        for b in bots:
            bid = b.get("id", "")
            if bid == self.user_id or bid in block or self.mm_avoid.get(bid, 0) > now or b.get("disabled"):
                continue
            perf = (b.get("perfs") or {}).get(speed) or {}
            r = perf.get("rating")
            if r is None or perf.get("prov") or not (mm["min_rating"] <= r <= mm["max_rating"]):
                continue
            cands.append((b.get("username", bid), r))
        if not cands:
            self.log("info", f"matchmaking: no suitable online bot for {speed} {tc}")
            return
        user, r = random.choice(cands)
        self.log("info", f"matchmaking: challenging {user} ({r}) {tc}")
        await self.send_challenge(user, limit, inc, mm["rated"])

    async def _housekeeping(self) -> None:
        while not self.stopped.is_set():
            await asyncio.sleep(2.0)
            now = time.monotonic()
            for cid, t in list(self.pending_accept.items()):
                if now - t > 30:
                    self.pending_accept.pop(cid, None)
                    self.log("warning", f"accepted challenge {cid} never started")
            timeout = self.cfg.get("matchmaking.timeout_seconds")
            for cid, (ch, t) in list(self.outgoing.items()):
                if now - t > timeout:
                    self.mm_avoid[ch.challenger.lower()] = now + 1800
                    await self.cancel_challenge(cid)
            if self.queue and not self.paused:
                await self._accept_from_queue()
            mm = self.cfg.get("matchmaking")
            if (mm["enabled"] and not self.paused and not self.quitting and self.active_count() == 0
                    and not self.outgoing and not self.queue and self.stream_ok
                    and now - self.last_idle_start > mm["idle_seconds"]
                    and now - self.last_mm_attempt > max(30, mm["idle_seconds"] / 2)):
                await self.matchmake()
