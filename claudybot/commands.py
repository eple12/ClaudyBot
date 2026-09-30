"""Console commands (shared by the dashboard and the headless mode)."""
from __future__ import annotations

import shlex
import time
from typing import TYPE_CHECKING, Awaitable, Callable

import chess
from rich.markup import escape

from .game import GameSession, fmt_ms, fmt_score
from .lichess import LichessError
from .manager import parse_tc

if TYPE_CHECKING:
    from .manager import BotManager

HELP = [
    ("help [command]", "this list"),
    ("<n> | watch <n|id>", "open the detail view of game n (F4/F3 next/prev, Esc back)"),
    ("back", "back to the overview"),
    ("games", "list running and recent games"),
    ("status", "bot status, results, settings summary"),
    ("pause [ignore] / resume", "stop / restart accepting challenges (declines with 'later', or leaves them)"),
    ("queue", "list challenges waiting for a free slot"),
    ("accept <n|id>", "accept a queued (or any pending) challenge, ignoring the filters"),
    ("decline <n|id> [reason]", "decline (reasons: generic later tooFast tooSlow timeControl rated casual variant noBot onlyBot)"),
    ("challenge <user> <min+inc> [rated|casual] [white|black]", "challenge someone, e.g. challenge maia9 3+2 casual"),
    ("cancel <id|all>", "cancel our outgoing challenge(s)"),
    ("link [min+inc] [rated|casual] [white|black|random] [<hours>h]",
     "make a 'challenge a friend' link anyone can open to play us, e.g. link 5+3 casual 48h"),
    ("links / link cancel <id|all>", "list / close our open links"),
    ("match on|off|now", "automatic matchmaking against online bots"),
    ("resign|abort|draw [n]", "resign / abort / offer-or-accept a draw in game n (default: watched game)"),
    ("offerdraw [n]", "offer a draw together with the next engine move"),
    ("diff [n] <rating|off>", "play game n at a rating limit (opponents use !diff <rating> in the chat)"),
    ("chat [n] [spectator] <text>", "write in the game chat"),
    ("limit <n> | limit bot|human <n|off>", "maximum simultaneous games (all / against bots / against humans)"),
    ("tc <min>-<max> [incmin-incmax]", "accepted base time in seconds, e.g. tc 60-900 0-10"),
    ("speeds <list>", "e.g. speeds bullet,blitz,rapid"),
    ("modes rated|casual|both", "accepted game modes"),
    ("block <user> / unblock <user>", "block list for incoming challenges and matchmaking"),
    ("set <key> <value>", "change any setting (see `config`); engine.options.X applies to new games"),
    ("config [prefix]", "show settings, e.g. config challenge"),
    ("save", "write the current settings to config.yml"),
    ("clear", "clear the log panel"),
    ("quit [now]", "quit after running games finish (or immediately)"),
    ("restart [now]", "quit like `quit`, with exit code 75: the Android run.sh then updates and starts again"),
]


class UI:
    """Hooks the dashboard implements; the headless mode uses this no-op version."""
    watched: str | None = None

    def watch(self, game: GameSession) -> None: ...
    def copy(self, text: str) -> None: ...
    def overview(self) -> None: ...
    def clear_log(self) -> None: ...


class Commands:
    def __init__(self, mgr: "BotManager", ui: UI | None = None):
        self.mgr = mgr
        self.ui = ui or UI()
        self.table: dict[str, Callable[[list[str]], Awaitable[list[str]]]] = {
            "help": self.c_help, "h": self.c_help, "?": self.c_help,
            "watch": self.c_watch, "w": self.c_watch,
            "back": self.c_back, "b": self.c_back, "overview": self.c_back,
            "games": self.c_games, "g": self.c_games,
            "status": self.c_status, "s": self.c_status,
            "pause": self.c_pause, "resume": self.c_resume,
            "queue": self.c_queue, "q": self.c_queue,
            "accept": self.c_accept, "decline": self.c_decline,
            "challenge": self.c_challenge, "ch": self.c_challenge,
            "cancel": self.c_cancel,
            "link": self.c_link, "links": self.c_links,
            "match": self.c_match, "mm": self.c_match,
            "resign": self.c_resign, "abort": self.c_abort, "draw": self.c_draw, "offerdraw": self.c_offerdraw,
            "diff": self.c_diff,
            "chat": self.c_chat,
            "limit": self.c_limit, "tc": self.c_tc, "speeds": self.c_speeds, "modes": self.c_modes,
            "block": self.c_block, "unblock": self.c_unblock,
            "set": self.c_set, "get": self.c_config, "config": self.c_config,
            "save": self.c_save, "clear": self.c_clear,
            "quit": self.c_quit, "exit": self.c_quit, "restart": self.c_restart,
        }

    @property
    def names(self) -> list[str]:
        return sorted(self.table)

    async def execute(self, line: str) -> list[str]:
        line = line.strip()
        if not line:
            return []
        try:
            args = shlex.split(line, posix=True)
        except ValueError:
            args = line.split()
        cmd, rest = args[0].lower(), args[1:]
        if cmd.isdigit():
            cmd, rest = "watch", [cmd]
        fn = self.table.get(cmd)
        if fn is None:
            return [f"[red]unknown command[/] {escape(cmd)} - type [b]help[/]"]
        try:
            return await fn(rest)
        except LichessError as e:
            return [f"[red]Lichess:[/] {escape(str(e))}"]
        except KeyError as e:
            return [f"[red]unknown setting[/] {escape(str(e.args[0]) if e.args else '')} - see [b]config[/]"]
        except IndexError:
            return [f"[red]missing argument[/] - see [b]help {escape(cmd)}[/]"]
        except ValueError as e:
            return [f"[red]error:[/] {escape(str(e) or type(e).__name__)}"]

    # ---- lookups ---------------------------------------------------------------------------
    def game(self, args: list[str], required: bool = True) -> GameSession | None:
        games = self.mgr.game_list()
        if args:
            ref = args[0]
            if ref.isdigit() and 1 <= int(ref) <= len(games):
                return games[int(ref) - 1]
            for g in games:
                if g.id.startswith(ref):
                    return g
            for g in self.mgr.finished:
                if g.id.startswith(ref):
                    return g
            raise ValueError(f"no game {ref}")
        if self.ui.watched:
            g = self.mgr.games.get(self.ui.watched)
            if g:
                return g
        if len(games) == 1:
            return games[0]
        if required:
            raise ValueError("which game? give its number or id")
        return None

    def challenge_id(self, ref: str) -> str:
        if ref.isdigit() and 1 <= int(ref) <= len(self.mgr.queue):
            return self.mgr.queue[int(ref) - 1].id
        return ref

    # ---- commands ----------------------------------------------------------------------------
    async def c_help(self, a: list[str]) -> list[str]:
        rows = [(c, d) for c, d in HELP if not a or a[0] in c]
        w = max(len(c) for c, _ in rows) if rows else 0
        return ["[b]commands[/]"] + [f"  [cyan]{escape(c.ljust(w))}[/]  {escape(d)}" for c, d in rows]

    async def c_watch(self, a: list[str]) -> list[str]:
        g = self.game(a)
        assert g is not None
        self.ui.watch(g)
        return [f"watching {g.id} vs {escape(g.player_label(g.opponent))}"]

    async def c_back(self, a: list[str]) -> list[str]:
        self.ui.overview()
        return []

    async def c_games(self, a: list[str]) -> list[str]:
        out = ["[b]running[/]"] if self.mgr.games else ["no running games"]
        for i, g in enumerate(self.mgr.game_list(), 1):
            ev = g.current_eval_white()
            out.append(f"  [{i}] {g.id} {'W' if g.color == chess.WHITE else 'B'} vs {escape(g.player_label(g.opponent))} "
                       f"{g.tc} ply {len(g.moves)} eval {fmt_score(ev)} "
                       f"clock {fmt_ms(g.clock(g.color))}/{fmt_ms(g.clock(not g.color))}")
        if self.mgr.finished:
            out.append("[b]recent[/]")
            for g in list(self.mgr.finished)[:10]:
                out.append(f"  {g.id} {g.outcome_for_me():5} {g.result():7} vs {escape(g.player_label(g.opponent))} "
                           f"{g.tc} {g.status}")
        return out

    async def c_status(self, a: list[str]) -> list[str]:
        m = self.mgr
        c = m.cfg.get("challenge")
        up = int(time.time() - m.started)
        r = m.results
        return [
            f"[b]{escape(m.username)}[/] on {m.base_url}  up {up // 3600}h{up % 3600 // 60:02d}m  "
            f"stream {'ok' if m.stream_ok else 'DOWN'}",
            f"accepting: {'[red]paused[/]' if m.paused else '[green]yes[/]'}  games {m.slots_text()}  "
            f"queue {len(m.queue)}  outgoing {len(m.outgoing)}  links {len(m.links)}  matchmaking "
            f"{'on' if m.cfg.get('matchmaking.enabled') else 'off'}",
            f"session results: +{r['win']} ={r['draw']} -{r['loss']}",
            f"accept: {','.join(c['speeds'])} | {','.join(c['modes'])} | base {c['min_base']}-{c['max_base']}s "
            f"inc {c['min_inc']}-{c['max_inc']}s | bots {'yes' if c['accept_bots'] else 'no'} humans "
            f"{'yes' if c['accept_humans'] else 'no'} | rating {c['min_rating']}-{c['max_rating']}",
            f"engine: {escape(str(m.cfg.get('engine.path')))} {m.cfg.get('engine.options')} ponder "
            f"{m.cfg.get('engine.ponder')}",
        ]

    async def c_pause(self, a: list[str]) -> list[str]:
        self.mgr.cfg.data["challenge"]["accept"] = False
        if a and a[0] in ("ignore", "decline"):
            self.mgr.cfg.data["challenge"]["paused_action"] = a[0]
        act = self.mgr.cfg.get("challenge.paused_action")
        self.mgr.log("info", f"paused accepting challenges (new ones: {act})")
        return [f"[yellow]paused[/] - new challenges are {'declined (later)' if act == 'decline' else 'left unanswered'}; "
                f"running games continue"]

    async def c_resume(self, a: list[str]) -> list[str]:
        self.mgr.cfg.data["challenge"]["accept"] = True
        self.mgr.log("info", "accepting challenges again")
        await self.mgr._accept_from_queue()
        return ["[green]accepting challenges[/]"]

    async def c_queue(self, a: list[str]) -> list[str]:
        out = []
        for i, ch in enumerate(self.mgr.queue, 1):
            out.append(f"  [{i}] {ch.id} {escape(ch.label())}")
        for cid, (ch, t) in self.mgr.outgoing.items():
            out.append(f"  out {cid} -> {escape(ch.label())} ({time.monotonic() - t:.0f}s)")
        return out or ["queue is empty"]

    async def c_accept(self, a: list[str]) -> list[str]:
        cid = self.challenge_id(a[0])
        ch = next((c for c in self.mgr.queue if c.id == cid), None)
        self.mgr.queue = [c for c in self.mgr.queue if c.id != cid]
        ok = await self.mgr.accept(cid, "bot" if ch and ch.is_bot else "human")
        return [f"accepted {cid}" if ok else f"[red]could not accept {cid}[/]"]

    async def c_decline(self, a: list[str]) -> list[str]:
        cid = self.challenge_id(a[0])
        await self.mgr.decline(cid, a[1] if len(a) > 1 else "generic")
        return [f"declined {cid}"]

    async def c_challenge(self, a: list[str]) -> list[str]:
        if len(a) < 2:
            return ["usage: challenge <user> <minutes+inc> [rated|casual] [white|black|random]"]
        user = a[0]
        limit, inc = parse_tc(a[1])
        rated = "rated" in a[2:]
        color = next((x for x in a[2:] if x in ("white", "black", "random")), "random")
        await self.mgr.send_challenge(user, limit, inc, rated, color)
        return []

    async def c_cancel(self, a: list[str]) -> list[str]:
        ids = list(self.mgr.outgoing) if a and a[0] == "all" else [a[0]]
        for cid in ids:
            await self.mgr.cancel_challenge(cid)
        return [f"canceled {len(ids)} challenge(s)"]

    async def c_link(self, a: list[str]) -> list[str]:
        if a and a[0] in ("cancel", "close", "del"):
            ids = list(self.mgr.links) if a[1:] and a[1] == "all" else [self._link_id(a[1])]
            n = 0
            for cid in ids:
                n += await self.mgr.cancel_link(cid)
            return [f"closed {n} link(s)"]
        if a and a[0] in ("list", "ls"):
            return await self.c_links([])
        d = self.mgr.cfg.get("link")
        tc, rated, color, hours = str(d["tc"]), bool(d["rated"]), str(d["color"]), float(d["hours"])
        for x in a:
            x = x.lower()
            if "+" in x:
                tc = x
            elif x in ("rated", "casual"):
                rated = x == "rated"
            elif x in ("white", "black", "random"):
                color = x
            elif x.endswith(("h", "d")) and x[:-1].replace(".", "", 1).isdigit():
                hours = float(x[:-1]) * (24 if x.endswith("d") else 1)
            else:
                raise ValueError(f"what is {x}? usage: link [min+inc] [rated|casual] [white|black|random] [<hours>h]")
        limit, inc = parse_tc(tc)
        ln = await self.mgr.create_link(limit, inc, rated, color, hours)
        self.ui.copy(ln["url"])
        return [f"[green]link ready[/] ({escape(ln['tc'])} {'rated' if rated else 'casual'}, we play {color}, "
                f"open {hours:g} h): [b]{escape(ln['url'])}[/]"]

    def _link_id(self, ref: str) -> str:
        ids = list(self.mgr.links)
        if ref.isdigit() and 1 <= int(ref) <= len(ids):
            return ids[int(ref) - 1]
        return next((i for i in ids if i.startswith(ref)), ref)

    async def c_links(self, a: list[str]) -> list[str]:
        if not self.mgr.links:
            return ["no open links - make one with [b]link 5+3[/]"]
        out = ["[b]open links[/]"]
        for i, ln in enumerate(self.mgr.links.values(), 1):
            left = max(0, ln["expires"] - time.time())
            out.append(f"  [{i}] {escape(ln['url'])}  {escape(ln['tc'])} {'rated' if ln['rated'] else 'casual'} "
                       f"we play {ln['color']}, {left / 3600:.1f} h left")
        return out

    async def c_match(self, a: list[str]) -> list[str]:
        sub = a[0] if a else "status"
        mm = self.mgr.cfg.data["matchmaking"]
        if sub == "on":
            mm["enabled"] = True
            self.mgr.last_idle_start = min(self.mgr.last_idle_start, time.monotonic())
        elif sub == "off":
            mm["enabled"] = False
        elif sub == "now":
            await self.mgr.matchmake(force=True)
            return []
        return [f"matchmaking {'on' if mm['enabled'] else 'off'}: tc {','.join(mm['tc'])} "
                f"{'rated' if mm['rated'] else 'casual'} rating {mm['min_rating']}-{mm['max_rating']} "
                f"after {mm['idle_seconds']}s idle"]

    async def c_resign(self, a: list[str]) -> list[str]:
        g = self.game(a)
        assert g
        await g.resign()
        return [f"resigned {g.id}"]

    async def c_abort(self, a: list[str]) -> list[str]:
        g = self.game(a)
        assert g
        await g.abort()
        return [f"abort sent for {g.id}"]

    async def c_draw(self, a: list[str]) -> list[str]:
        g = self.game(a)
        assert g
        await g.draw()
        return [f"draw offered/accepted in {g.id}"]

    async def c_offerdraw(self, a: list[str]) -> list[str]:
        g = self.game(a)
        assert g
        g.offer_draw_next = True
        return [f"will offer a draw with the next move in {g.id}"]

    async def c_diff(self, a: list[str]) -> list[str]:
        g = self.game(a[:-1] if len(a) > 1 else [])
        assert g is not None
        arg = a[-1].lower()
        if arg in ("off", "full", "0"):
            g.set_limit(None)
            return [f"{g.id}: full strength from the next move"]
        lo, hi, _ = g.limit_levels()
        elo = int(arg)
        if not 100 <= elo <= 3400:
            raise ValueError("rating must be 100-3400")
        g.set_limit(elo)
        return [f"{g.id}: rating limit {elo} from the next move"]

    async def c_chat(self, a: list[str]) -> list[str]:
        g = None
        if a and (a[0].isdigit() or any(x.id.startswith(a[0]) for x in self.mgr.game_list())) and len(a) > 1:
            g = self.game(a[:1])
            a = a[1:]
        g = g or self.game([])
        room = "player"
        if a and a[0] in ("spectator", "player"):
            room, a = a[0], a[1:]
        assert g
        await g.say(" ".join(a), room)
        return [f"({room}) {escape(' '.join(a))}"]

    async def c_limit(self, a: list[str]) -> list[str]:
        if a and a[0].lower().rstrip("s") in ("bot", "human"):
            kind = a[0].lower().rstrip("s")
            v = a[1].lower() if len(a) > 1 else "off"
            self.mgr.cfg.set(f"challenge.concurrency_{kind}", "-1" if v in ("off", "-", "all", "-1") else v)
        elif a:
            self.mgr.cfg.set("challenge.concurrency", a[0])
        await self.mgr._accept_from_queue()
        return [f"games {self.mgr.slots_text()}"]

    async def c_tc(self, a: list[str]) -> list[str]:
        lo, _, hi = a[0].partition("-")
        self.mgr.cfg.set("challenge.min_base", lo)
        self.mgr.cfg.set("challenge.max_base", hi or lo)
        if len(a) > 1:
            ilo, _, ihi = a[1].partition("-")
            self.mgr.cfg.set("challenge.min_inc", ilo)
            self.mgr.cfg.set("challenge.max_inc", ihi or ilo)
        c = self.mgr.cfg.get("challenge")
        return [f"base {c['min_base']}-{c['max_base']}s, increment {c['min_inc']}-{c['max_inc']}s"]

    async def c_speeds(self, a: list[str]) -> list[str]:
        v = self.mgr.cfg.set("challenge.speeds", ",".join(a))
        return [f"speeds: {', '.join(v)}"]

    async def c_modes(self, a: list[str]) -> list[str]:
        m = a[0] if a else "both"
        v = self.mgr.cfg.set("challenge.modes", "rated,casual" if m == "both" else m)
        return [f"modes: {', '.join(v)}"]

    async def c_block(self, a: list[str]) -> list[str]:
        bl = self.mgr.cfg.data["challenge"]["block_list"]
        if a[0].lower() not in [x.lower() for x in bl]:
            bl.append(a[0])
        return [f"blocked {a[0]}"]

    async def c_unblock(self, a: list[str]) -> list[str]:
        bl = self.mgr.cfg.data["challenge"]["block_list"]
        bl[:] = [x for x in bl if x.lower() != a[0].lower()]
        return [f"unblocked {a[0]}"]

    async def c_set(self, a: list[str]) -> list[str]:
        if len(a) < 2:
            return ["usage: set <key> <value>   (see `config`)"]
        key, value = a[0], " ".join(a[1:])
        v = self.mgr.cfg.set(key, value)
        self.mgr.log("info", f"setting {key} = {v!r}")
        if key.startswith("challenge."):
            await self.mgr._accept_from_queue()
        note = "  (applies to new games)" if key.startswith("engine.") else ""
        return [f"{escape(key)} = {escape(repr(v))}{note}"]

    async def c_config(self, a: list[str]) -> list[str]:
        items = self.mgr.cfg.flat(a[0] if a else "")
        return [f"  [cyan]{escape(k)}[/] = {escape(repr(v))}" for k, v in items] or ["no such setting"]

    async def c_save(self, a: list[str]) -> list[str]:
        p = self.mgr.cfg.save()
        return [f"saved settings to {escape(str(p))}"]

    async def c_clear(self, a: list[str]) -> list[str]:
        self.ui.clear_log()
        return []

    async def c_restart(self, a: list[str]) -> list[str]:
        self.mgr.restart_requested = True
        out = await self.c_quit(a)
        return [line.replace("quitting", "restarting").replace("bye", "restarting") for line in out]

    async def c_quit(self, a: list[str]) -> list[str]:
        now = bool(a) and a[0] in ("now", "!", "force")
        await self.mgr.quit(now=now)
        if not now and self.mgr.games:
            return [f"[yellow]quitting after {len(self.mgr.games)} game(s); `quit now` to leave immediately[/]"]
        return ["bye"]
