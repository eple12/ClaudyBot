# ClaudyBot

A Lichess BOT client for **any UCI engine**, with a console dashboard (Textual) and a browser dashboard:
live boards of all games (Caliente pieces), per-game engine table / eval history / raw UCI I/O, runtime
commands (pause, challenge filters, matchmaking, resign / draw, chat), pondering, network-lag compensation,
rating-limited games on request (`!diff <rating>`), separate game slots for bots and humans, long-lived
"challenge a friend" links (`link 5+3`), PGN export, and an offline mock Lichess server.

* Live read-only mirror (GitHub Pages): <https://eple12.github.io/ClaudyBot/> — see *Live viewer* below.
* Written for the [Claudy](https://github.com/eple12/ClaudyEngine) engine, but nothing in it is Claudy-specific:
  set `engine.path` (and its UCI options) in `config.yml`.
* Quick start: `pip install -r requirements.txt`, copy `config.example.yml` to `config.yml`, put the BOT
  account's API token (scope `bot:play`) into `token.txt`, run `run.bat` (or `python -m claudybot`).
  `demo.bat` plays against a fake local Lichess, no token needed.

The rest of this README is in Korean.

# ClaudyBot: Lichess 봇 대시보드

lichess-bot의 동작 방식(Bot API 이벤트 스트림, 대국 스트림, 시간 관리, 도전 필터, 매치메이킹)을
참고해서 처음부터 다시 만든 비동기(asyncio) 클라이언트입니다. 콘솔 대시보드(Textual)에서 여러 대국을
동시에 보면서, 실행 중에 명령으로 설정을 바꿀 수 있습니다.

## 설치

```bat
pip install -r requirements.txt
```

## 새 계정을 봇으로 만들기

1. 봇으로 쓸 계정으로 로그인한 상태에서 토큰을 발급합니다. 아래 주소를 열면 필요한 권한이 미리 체크되어 있습니다.
   `https://lichess.org/account/oauth/token/create?scopes[]=bot:play&scopes[]=challenge:read&scopes[]=challenge:write&description=ClaudyBot`
2. 토큰을 넣습니다. 둘 중 하나를 쓰면 됩니다.
   * `bot/token.txt`에 토큰 한 줄을 저장하고 config.yml에 `token_file: token.txt`를 적기
   * 환경변수로 저장: `setx LICHESS_BOT_TOKEN "lip_..."` 입력 후 새 터미널 열기
3. `run.bat --check`로 토큰 권한과 계정 상태를 확인합니다.
4. `run.bat --upgrade`로 BOT 계정으로 전환합니다. 계정 이름을 입력해야 실행됩니다.
   되돌릴 수 없고, 한 판도 두지 않은 계정만 전환됩니다.
5. 다시 `--check`를 실행해서 `title: BOT`이 나오면 준비가 끝난 것입니다.

토큰은 비밀번호와 같습니다. 채팅, 스크린샷, 공개 저장소에 올리지 마세요.

## 실행

```bat
copy config.example.yml config.yml   & rem 처음 한 번, 필요하면 수정
run.bat                              & rem 대시보드
run.bat --headless                   & rem 로그만 출력(서버용), 명령은 표준입력으로
run.bat --web                        & rem 대시보드 + 브라우저 대시보드 http://127.0.0.1:8080
demo.bat                             & rem 토큰 없이 가짜 Lichess 서버와 대국하는 오프라인 데모
```

`demo.bat`은 가짜 서버(`python -m claudybot.mockserver`)를 최소화된 창으로 띄웁니다. 데모가 끝나면 그 창도
닫으세요. 가짜 서버는 실제 시계와 시간패, 반복/50수 무승부, 채팅, 무승부 제안을 흉내 내고,
첫 수를 안 두는 상대(abort 테스트)와 도중에 나가는 상대(승리 청구 테스트)도 섞어서 보냅니다.

## 화면

* **맨 위 상태줄**: 계정, 신청 수락/일시정지 상태, 진행 중인 게임 수와 한도, 대기열, 매치메이킹 on/off,
  이벤트 스트림 연결 상태, 이번 세션 전적, 가동 시간
* **개요 화면**: 진행 중인 대국마다 카드가 하나씩 뜹니다. 카드에는 보드, 양쪽 시계, 평가값, 깊이, NPS,
  생각/폰더 상태가 표시되고, 내 차례인 카드는 초록 테두리가 됩니다. 오른쪽에는 도전 대기열,
  보낸 도전, 최근 결과, 현재 수락 조건이 나옵니다.
* **상세 화면**: 게임 번호를 입력하거나 카드를 클릭하면 열립니다.
  * 큰 보드(마지막 수와 체크 강조), 시계, 평가 막대
  * 엔진 표: 반복 심화의 매 깊이마다 Depth/SelDepth, Score, Time, Nodes, NPS, Hash, TB, PV(SAN)를
    cutechess처럼 보여 주고, 현재 상태(THINKING/PONDERING), 승률, ponderhit 비율도 표시
  * 평가 그래프(Lichess식 백 승률 영역 그래프)와 수순표(내 수마다 평가값)
  * 엔진 원문 입출력(UCI 송수신 원문 그대로)
* **맨 아래**: 이벤트 로그와 명령 입력줄. 명령 이름은 자동 완성되고, ↑/↓로 이전 명령을 불러옵니다.

단축키: F1 도움말 · F2/Esc 개요 · F3/F4 이전/다음 게임 · F5 신청 일시정지/재개 · F6 보드 뒤집기 ·
F7 도전 링크(기본값이 채워진 `link` 명령을 입력줄에 넣음, 고쳐서 Enter) ·
Ctrl+Q 종료(게임이 진행 중이면 3초 안에 한 번 더 누르기)

## 브라우저 대시보드 (`--web`)

`--web [포트]`를 붙이거나 config의 `web.enabled: true`로 켜면, 같은 봇을 브라우저에서도 볼 수 있습니다
(http://127.0.0.1:8080). 리체스 느낌의 어두운 화면에 Caliente 기물 그림 보드가 나오고, 수는 미끄러지듯
움직입니다. 태블릿·폰 화면(세로/가로)에 맞춰 배치가 바뀝니다.

* 개요: 게임 카드(보드, 시계, 평가 막대, 깊이/NPS, 생각 상태), 도전 대기열(수락/거절 버튼), 최근 결과,
  도전 링크 만들기(시간·모드·봇 색·유지 시간을 고르고 Create link, 만든 링크는 Copy/Share/Close 버튼)
* 상세: 큰 보드와 평가 막대, 탐색 표(cutechess식), 평가 그래프(눌러서 수마다 값 보기), 기보, 채팅 입력,
  엔진 입출력 원문, 뒤집기/무승부 제안/abort/기권 버튼
* 아래 입력창은 콘솔 명령 그대로입니다. 위쪽 버튼으로 도전 수락 일시정지와 매치메이킹을 켜고 끕니다.

기본은 이 기기에서만 접속됩니다(127.0.0.1). `web.host: 0.0.0.0`으로 바꾸면 같은 와이파이의 다른 기기에서도
열 수 있는데, 이때는 접속 키가 붙은 주소(로그에 표시)로만 명령을 받습니다. 안드로이드는 `../android/README.md`.

## 명령

| 명령 | 설명 |
|---|---|
| `help [명령]` | 명령 목록 |
| `<n>` 또는 `watch <n\|id>` / `back` | 게임 n의 상세 화면 / 개요로 돌아가기 |
| `games`, `status`, `queue` | 게임 목록, 상태 요약, 대기열과 보낸 도전 |
| `pause [ignore]` / `resume` | 신청 받기 일시정지(기본은 later 사유로 거절, ignore면 무응답) / 재개 |
| `accept <n\|id>` / `decline <n\|id> [사유]` | 대기열 신청을 필터와 상관없이 수락 / 거절 |
| `challenge <user> 3+2 [rated\|casual] [white\|black]` | 직접 도전 신청 |
| `cancel <id\|all>` | 보낸 도전 취소 |
| `link [3+2] [rated\|casual] [white\|black\|random] [48h]` | 누구나 열어서 봇과 둘 수 있는 도전 링크 (아래 참고) |
| `links` / `link cancel <n\|id\|all>` | 열려 있는 링크 목록 / 닫기 |
| `match on\|off\|now` | 온라인 봇 자동 매치메이킹 |
| `resign`, `abort`, `draw [n]` | 기권, 중단, 무승부 제안/수락 (n을 생략하면 지금 보고 있는 게임) |
| `offerdraw [n]` | 다음 엔진 수와 함께 무승부 제안 |
| `diff [n] <rating\|off>` | 게임 n을 그 레이팅 제한으로 두기 / 제한 해제 (다음 수부터) |
| `chat [n] [spectator] <text>` | 채팅 |
| `limit 3` / `limit bot 2` / `limit human off` | 동시 게임 수 / 그중 봇 상대 최대 / 사람 상대 제한 해제 |
| `tc 60-900 0-10` | 받을 기본 시간 범위(초)와 증가 시간 범위 |
| `speeds bullet,blitz` / `modes rated\|casual\|both` | 받을 속도 / 모드 |
| `block <user>` / `unblock <user>` | 차단 목록 |
| `set <키> <값>` / `config [접두어]` / `save` | 아무 설정이나 변경 / 보기 / config.yml에 저장 |
| `quit` / `quit now` | 진행 중인 게임을 다 끝낸 뒤 종료 / 즉시 종료 |
| `restart` / `restart now` | `quit`과 같지만 종료 코드 75로 끝냄. 안드로이드 `run.sh`는 이때 업데이트 후 다시 시작 |

예시: `set challenge.min_rating 1800`, `set engine.options.Threads 6` (새 게임부터 적용),
`set game.resign_enabled on`, `config matchmaking`.

## 동시 게임 슬롯 (사람 / 봇)

`challenge.concurrency`가 전체 동시 게임 수이고, 그 안에서 봇 상대와 사람 상대를 따로 제한할 수 있습니다.

| 설정 | 기본값 | |
|---|---|---|
| `challenge.concurrency` | 2 | 전체 동시 게임 수 |
| `challenge.concurrency_bot` | -1 | 봇 상대 최대 게임 수 (-1 = 따로 제한 없음) |
| `challenge.concurrency_human` | -1 | 사람 상대 최대 게임 수 (-1 = 따로 제한 없음) |

예: `concurrency: 3`, `concurrency_bot: 2`이면 봇끼리 2판이 돌고 있을 때 봇의 신청은 `later`로 거절하지만,
나머지 한 자리는 사람에게 남겨 둡니다. 사람은 3자리를 모두 쓸 수 있습니다. 실행 중에는 `limit bot 2`,
`limit human 1`, `limit bot off`로 바꿉니다. 상태줄과 대시보드에 `games 2/3 (bot 2/2 human 0/3)`처럼 표시됩니다.
자리가 없을 때 사람의 신청은 대기열(`queue_size`)에 넣었다가 자리가 나면 받고, 봇의 신청은 바로 거절합니다.
매치메이킹은 봇 자리가 비어 있을 때만 도전합니다.

## 도전 링크 (친구에게 도전하기)

`link 5+3`(또는 대시보드의 **Create link**, 콘솔의 F7)을 쓰면 `https://lichess.org/xxxxxxxx` 링크가 만들어지고,
그 링크를 처음 여는 사람이 봇과 대국합니다. 리체스 웹에서 만든 친구 도전은 만든 사람의 창이 닫히면 곧
사라지지만, 이 링크는 **정한 시간 동안 계속 열려 있습니다**(`link.hours`, 기본 24시간, 최대 2주).
rated 링크는 로그인한 사람만 들어올 수 있습니다.

* 원리: 리체스의 open challenge(`POST /api/challenge/open`)를 만들고 봇이 바로 첫 번째 자리에 앉습니다
  (원하는 색 지정 가능). 두 번째로 여는 사람이 들어오면 게임이 시작됩니다.
* 토큰에 `challenge:write` 권한이 없으면 링크를 익명으로 만든 뒤 봇이 자리에 앉으므로, `bot:play`만 있어도 됩니다.
* 링크 게임은 슬롯 한도와 상관없이 시작됩니다(직접 만든 게임이므로). 울트라불릿은 BOT 계정이 둘 수 없습니다.
* 기본값: `link.tc` 5+3, `link.rated` false, `link.color` random(봇의 색), `link.hours` 24.
  열려 있는 링크는 `logs/links.json`에 기록되어 봇을 다시 켜도 목록에 남습니다.

## 레이팅 제한 (`!diff`)

엔진은 `UCI_LimitStrength` / `UCI_Elo`로 100부터 3400(= 최대 실력)까지 **모든 정수 레이팅**을 한 단계씩
지원합니다. 레이팅이 낮을수록 탐색 노드 수가 줄고(1스레드), 약 2000 아래부터는 평가에 게임마다 다른 잡음이
섞이며, 1000 아래에서는 가끔 아무 수나 둡니다. 척도는 Stockfish의 `UCI_Elo`에 맞춰 보정했습니다(`DEVLOG.md`).

상대가 **자신의 첫 수를 두기 전에** 플레이어 채팅에 `!diff 1500`처럼 치면, 조건이 맞을 때 그 게임은
그 레이팅으로 둡니다. 없는 레벨이거나(범위 밖, 간격에 안 맞음), 이미 첫 수를 뒀거나, 조건이 안 맞으면
이유를 채팅으로 알려 줍니다. `!diff`만 치면 사용법과 현재 상태를 알려 줍니다.

| 설정 | 기본값 | |
|---|---|---|
| `strength.accept` | `true` | 요청을 받을지 (`set strength.accept off`로 끄기) |
| `strength.modes` | `casual` | `casual` / `rated` / `both` |
| `strength.opponents` | `human` | `human` / `bot` / `both` |
| `strength.min` / `strength.max` / `strength.step` | 100 / 3400 / 1 | 제공하는 레벨: min, min+step, … max |
| `strength.announce` | `true` | 조건이 맞는 게임의 시작 인사에 `!diff` 안내를 덧붙임 |

제한 게임에서는 평가가 일부러 흐트러지므로 기권·무승부 제안·무승부 수락을 하지 않고, `!eval`도 알려 주지
않으며, 폰더링도 끕니다. 대시보드와 PGN(`[ClaudyRatingLimit "1500"]`)에 제한이 표시됩니다.

## 동작 방식

* 대국마다 엔진 프로세스를 하나씩 띄웁니다. `concurrency x Threads`가 코어 수를 넘지 않게 맞추세요
  (도전 링크로 시작된 게임은 한도를 넘을 수 있습니다).
* 시간: 서버가 보낸 시계에서 받은 뒤 흐른 시간을 빼서 `go wtime/btime/winc/binc`로 넘기고,
  네트워크 지연은 엔진의 `Move Overhead`가 흡수합니다. 첫 수는 `first_move_ms`로 둡니다.
* 폰더: 내 수가 서버에 반영되면 엔진이 예상한 상대 수로 `go ponder`를 시작합니다. 예상이 맞으면
  `ponderhit`로 이어서 생각하고, 틀리면 `stop` 후 새로 탐색합니다.
* 수 전송이 네트워크 오류로 실패하면 다시 탐색해서 재전송하고, 엔진이 죽으면 재시작한 뒤 이어서 둡니다.
* 상대의 무르기 요청은 거절합니다. 무승부 제안은 설정값에 따라 수락하거나 거절합니다.
* 재시작하면 진행 중이던 게임을 `/api/account/playing`에서 찾아 이어서 둡니다.
* 끝난 게임은 `games/날짜.pgn`에 `[%eval]`, 깊이, 시간, 노드 수 주석을 붙여 저장합니다. 전체 로그는 `logs/`에 남습니다.

## 기물 표시

`ui.pieces` 설정으로 고릅니다. 실행 중에 `set ui.pieces <값>`으로 바로 바꿀 수 있습니다.

* `image` (기본): 리체스 기물 세트(기본 Caliente)로 보드를 그림으로 그려서 터미널 그래픽(Sixel)으로
  보여 줍니다. Windows Terminal 1.22 이상에서 동작합니다. 시작할 때 터미널이 그림을 지원하는지 확인하고,
  지원하지 않으면 자동으로 `sprites`로 표시합니다. 로그 첫 줄에 어느 쪽인지 나옵니다.
  * 다른 기물 세트를 쓰려면 `bot/assets/<이름>/`에 `wK.svg`…`bP.svg`(또는 png)를 넣고
    `set ui.piece_set <이름>`을 입력한 뒤 다시 시작하세요.
* `sprites`: 블록 문자로 그린 픽셀 기물입니다. 글꼴과 상관없이 칸 정가운데에 놓입니다.
* `letters`: 흰 칩/검은 칩 위에 기물 글자(K Q R B N P)를 씁니다.
* `unicode`: 체스 글꼴 기호(♚♛♜…)입니다. 글꼴에 따라 작거나 치우쳐 보일 수 있습니다.

`image` 모드에서 보드가 세로나 가로로 길어 보이면 `set ui.cell_aspect <값>`으로 맞추세요(글자 칸의 세로/가로 비율, 기본 2.12).
Windows Terminal은 Sixel을 항상 칸당 10×20 픽셀로 보고하고 실제 글꼴 칸에 맞춰 늘려 그리므로, 실제 비율은 이 값으로 알려 줘야 합니다.
값을 키우면 보드가 가로로 넓어집니다.

보드 크기는 창 크기에 맞춰 자동으로 정해집니다. 개요 화면은 모든 카드가 한 화면에 들어가는 가장 큰 크기를 씁니다.

Caliente 기물: avi 제작(https://github.com/avi-0/caliente), lichess 배포본, CC BY-NC-SA 4.0 (`assets/caliente/LICENSE.txt`).

## 실시간 뷰어 (GitHub Pages, 읽기 전용)

`docs/`는 GitHub Pages로 배포되는 정적 페이지입니다: <https://eple12.github.io/ClaudyBot/>

* 보드, 시계, 수순, 레이팅, 온라인 상태, 최근 결과는 **Lichess 공개 API**(게임 스트림)로 직접 받아서 보여 줍니다.
  봇 PC와 연결할 필요가 없고, 누구나 볼 수 있으며, 조작은 전혀 안 됩니다.
* 다른 봇을 보려면 `?bot=계정이름`, 기본값은 `docs/config.js`의 `bot`.
* **엔진 정보(평가, 깊이, NPS, PV, 평가 그래프)**는 Lichess에 없으므로 봇이 직접 내보내야 합니다.
  `config.yml`에서 `web.public: true`로 켜면 대시보드 서버가 `GET /api/public/state`(읽기 전용, 명령·로그·채팅 없음,
  모든 출처 허용)를 제공합니다. 이 주소를 인터넷에 공개하는 방법(예: Cloudflare Tunnel)으로 연결한 뒤
  뷰어를 `?telemetry=https://<터널 주소>`로 열거나 `docs/config.js`의 `telemetry`에 적으면 엔진 패널이 켜집니다.
  공개 주소가 없으면 뷰어는 보드·시계·수순만 보여 줍니다.

### 터널 자동 연결 (Cloudflare 임시 터널)

```yaml
web:
  public_port: 8081       # 읽기 전용 포트: /api/public/state 말고는 전부 404
  tunnel: true
  tunnel_exe: C:/tools/cloudflared.exe
  tunnel_gist: <gist id>  # docs/config.js 의 telemetryGist 와 같게
```

봇이 시작하면 `cloudflared tunnel --url http://127.0.0.1:8081`로 `https://<무작위>.trycloudflare.com` 주소를 받고
(Cloudflare 계정 불필요), 그 주소를 GitHub CLI(`gh`, gist 권한으로 로그인)로 gist의 `telemetry.json`에 적습니다.
뷰어는 그 gist에서 주소를 찾아 엔진 정보를 받아 옵니다. 봇을 끝내면 터널을 닫고 gist를 비웁니다.
봇이 강제로 종료돼 남은 터널은 다음 실행 때 정리합니다(`logs/cloudflared.pid`).

* 터널에 연결되는 것은 읽기 전용 포트뿐이라 대시보드(`web.port`)와 명령은 인터넷에서 닿지 않습니다.
* 임시 터널 주소는 실행할 때마다 바뀌고 가용성 보장이 없습니다. Cloudflare에 도메인이 있다면 이름 있는 터널로
  고정 주소를 만들고 `docs/config.js`의 `telemetry`에 그 주소를 적으면 됩니다(gist 불필요).

## 파일

| 파일 | 역할 |
|---|---|
| `claudybot/lichess.py` | 비동기 Lichess API 클라이언트 (ndjson 스트림, 429 처리) |
| `claudybot/engine.py` | UCI 엔진 래퍼 (`info` 파싱, ponder/ponderhit/stop) |
| `claudybot/game.py` | 대국 하나: 스트림 처리, 엔진 구동, 무승부/기권 정책, 채팅, PGN |
| `claudybot/manager.py` | 이벤트 스트림, 도전 대기열, 매치메이킹 |
| `claudybot/challenges.py` | 도전 필터와 거절 사유 |
| `claudybot/commands.py` | 콘솔 명령 (대시보드와 headless 공용) |
| `claudybot/tui.py`, `render.py`, `sprites.py`, `boardimg.py` | 대시보드, 보드/그래프/표 렌더링, 픽셀 기물, 보드 그림 |
| `claudybot/web.py`, `web/` | 브라우저 대시보드 (표준 라이브러리 HTTP 서버 + HTML/JS) |
| `docs/` | GitHub Pages 읽기 전용 실시간 뷰어 (Lichess 공개 API + 선택적 엔진 텔레메트리) |
| `claudybot/mockserver.py` | 테스트용 가짜 Lichess 서버 |
