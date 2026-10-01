# stream-chat-lab

> An SSE streaming chat rebuilt from production lessons: explicit stream-end contract, resumable streams, ID-stable optimistic messages, and render batching, verified with fault-injection scenarios and step-by-step benchmarks.

SSE 토큰 스트리밍 채팅에서 생기는 끊김, 오탐 오류, 메시지 중복, 렌더 비용, 스크롤 튐을 처음부터 다시 구현했다. 장애를 주입하는 목 서버와, 기법을 하나씩 더해 가며 재는 측정으로 확인한다.

## 데모

| 장면                                                    | 녹화                    |
| ------------------------------------------------------- | ----------------------- |
| 정상: 보낸 즉시 표시 → 토큰 스트리밍 → 확정             | `docs/media/normal.gif` |
| 연결 끊김 후 이어 받기 (`drop-mid-stream`, 재전송 없음) | `docs/media/resume.gif` |
| 실패 → 재시도 (`http-5xx`, 입력 내용 유지)              | `docs/media/retry.gif`  |
| 위로 불러오기 후 스크롤 유지 (v5)                       | `docs/media/scroll.gif` |

## 문제

[`docs/LEARNING.md`](docs/LEARNING.md)는 실무에서 SSE 채팅을 1년 넘게 고치며 겪은 문제를 정리한 문서다. 그중 이 저장소가 코드와 테스트로 증명하는 것만 골랐다.

| LEARNING.md                                              | 이 저장소에서 확인하는 방법                                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1장. 전송 방식 고르기: EventSource, 폴리필, fetch 스트림 | 같은 인터페이스의 어댑터 두 개(EventSource, fetch + 직접 만든 파서). 시나리오 E2E를 두 어댑터에서 모두 돌린다                                           |
| 2장. 청크는 이벤트 단위로 오지 않는다                    | 파서 단위 테스트 30개(무작위 바이트 분할 500회 포함), `chunk-chaos` 시나리오                                                                            |
| 3장. "끝났다"는 신호를 정하는 것이 가장 어려웠다         | `final`만 종료 신호. `done-only`, `close-after-final` 시나리오                                                                                          |
| 4장. 재연결은 켜는 것보다 끄는 것이 맞을 때가 있다       | 자동 재연결 대신 `Last-Event-ID` 이어 받기. 그래도 안 되면 서버 상태 확인으로 오탐 복구. `drop-mid-stream`, `drop-after-saved`, `long-silence` 시나리오 |
| 5장. 낙관적 메시지와 식별자: 텍스트 → 시각 → id          | clientId로만 매칭. `duplicate-text`, `out-of-order-history` 시나리오                                                                                    |
| 6장. 이전 턴의 늦은 이벤트를 막기                        | Turn 컨트롤러 단위 테스트(동기 예약, 세대 번호, 실패 경로의 예약 해제)                                                                                  |
| 7장. 토큰마다 렌더링하면 느려진다                        | 비교 버전 v0~v4를 CPU 4배 느리게 해서 측정                                                                                                              |
| 8장. 스크롤: 위로 불러오기와 맨 아래 따라가기            | 보정 시점 비교(v0~v4 rAF, v5 `useLayoutEffect`), 위치 ±1px E2E                                                                                          |

## 설계 판단

각 판단의 상황, 대안, 트레이드오프는 [`docs/decisions/`](docs/decisions/)에 있다.

| 판단                                                                                        | 기각한 대안                                                                        | 기록                                                                                                      |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `POST /turns`로 턴을 만들고, 받은 id로 스트림을 구독한다. 스트림 인증은 60초짜리 1회용 토큰 | GET 하나로 보내기와 받기를 함께 함(재연결이 재전송이 됨), 장기 토큰을 URL에 둠     | [003](docs/decisions/003-split-send-and-stream.md)                                                        |
| 이벤트 종류를 SSE `event:`가 아니라 data JSON의 `type`으로 구분한다                         | `event: error` (EventSource의 연결 오류와 이름이 겹침)                             | [004](docs/decisions/004-event-type-in-data.md)                                                           |
| `final`만 종료 신호. `done`에서 닫지 않는다                                                 | `done`도 종료로 처리 (뒤에 오는 확정 데이터를 잃음)                                | [protocol](docs/protocol.md)                                                                              |
| 턴 하나가 준비 → 스트림 → 서버 확인을 소유한다. 세대 번호는 한 곳에                         | 층마다 따로 두는 가드, React 상태에 턴을 넣음                                      | [005](docs/decisions/005-turn-controller.md)                                                              |
| 생성을 연결과 분리하고, 끊기면 마지막 이벤트 id부터 이어 받는다                             | 끊기면 턴을 다시 만듦(응답 중복), 서버 상태만 확인(생성 중이면 복구 불가)          | [011](docs/decisions/011-resumable-stream.md)                                                             |
| 어댑터마다 알 수 있는 만큼만 알린다(EventSource는 상태 코드와 하트비트를 모름)              | 하트비트를 이벤트로 바꿈, 상태 확인 API 추가                                       | [012](docs/decisions/012-eventsource-vs-fetch.md)                                                         |
| 같은 clientId 재전송은 같은 턴을 돌려준다                                                   | 재시도마다 새 턴 (사용자 메시지·응답 중복)                                         | [007](docs/decisions/007-idempotent-turn-by-client-id.md), [013](docs/decisions/013-retry-failed-turn.md) |
| 렌더 key를 확정 전후 모두 clientId로 유지한다                                               | 서버 id key (확정 때 리마운트)                                                     | [014](docs/decisions/014-client-id-render-key.md)                                                         |
| 위로 불러오기는 sentinel + IntersectionObserver로 시작하고 `useLayoutEffect`에서 보정한다   | `scrollTop <= 0` + 요청 완료 후 rAF 보정, `column-reverse`, 브라우저 스크롤 앵커링 | [015](docs/decisions/015-scroll-correction-timing.md)                                                     |
| 바닥 따라가기는 사용자가 위로 올렸을 때만 끄고, 렌더 시점에 위치를 다시 확인한다            | 거리만 보고 판단 (smooth 스크롤 중에 꺼지고, scroll 이벤트와 경합)                 | [008](docs/decisions/008-bottom-follow-scroll.md)                                                         |
| 중지하면 서버가 거기까지의 응답을 저장한다                                                  | 클라이언트만 끊음(서버는 끝까지 생성), 아무것도 저장 안 함(본 내용이 사라짐)       | [016](docs/decisions/016-stop-and-new-messages.md)                                                        |
| 렌더 기법은 플래그로 하나씩 더해 같은 컴포넌트에서 비교한다                                 | 버전마다 컴포넌트를 따로 만듦                                                      | [009](docs/decisions/009-render-variants.md)                                                              |

## 결과

### 장애 시나리오

DEMO_SPEC의 시나리오 13개를 모두 E2E로 확인한다. 서버 쪽 11개는 EventSource와 fetch 어댑터 양쪽에서 돌린다. E2E는 GitHub Actions에서도 매 push마다 돈다.

| 시나리오                | 확인하는 것                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `normal`                | 보낸 즉시 표시, 토큰 스트리밍, 확정                                                  |
| `done-only`             | final 없이 닫혀도 계약 위반 경고 후 서버 상태로 복구                                 |
| `close-after-final`     | final 직후 서버가 닫아도 오류 없음                                                   |
| `drop-after-saved`      | 저장 직후 끊겨도 이어 받아 오탐 오류 없음                                            |
| `drop-mid-stream`       | `POST /turns`는 1번만, 재구독에 `lastEventId`. 이어 받은 텍스트와 확정 텍스트가 같음 |
| `slow-first-token`      | 대기 표시 유지, 타임아웃 없음                                                        |
| `long-silence`          | 하트비트 on: 연결 유지. off: fetch는 idle 타임아웃 후 이어 받기, EventSource는 유지  |
| `http-401` / `http-5xx` | fetch는 재인증·서버 오류 안내, EventSource는 일반 실패. 재시도하면 같은 턴으로 성공  |
| `chunk-chaos`           | 무작위 바이트 분할과 줄바꿈 혼용에도 확정 텍스트와 같음                              |
| `proxy-buffering`       | 몰려서 표시되지만 내용 정확                                                          |
| `out-of-order-history`  | 히스토리가 확정보다 먼저 와도, 늦게 와도 중복·누락 없음                              |
| `duplicate-text`        | 같은 문장 두 번이 모두 표시됨                                                        |

### 렌더 비용 (v0 → v5, 기법을 하나씩 추가)

[`docs/results.md`](docs/results.md)의 값이다. 각 칸은 **중앙값 / p90**, 버전마다 10회 실행했다.

- 측정 조건: 메시지 200개, 응답 1,500토큰, 40 tokens/s
- 기기: Intel Core Ultra 7 155H, Chromium 153 headless, CPU 4배 느리게, 프로덕션(profiling) 빌드
- 측정 방법과 한계는 [010](docs/decisions/010-benchmark-method.md)에 있다.

| 버전 | 추가한 기법                            | 평균 렌더(ms) | Long task 총(ms) | INP(ms)   | 리마운트 |
| ---- | -------------------------------------- | ------------- | ---------------- | --------- | -------- |
| v0   | 기준: 토큰마다 dispatch, 모두 마크다운 | 57.0 / 59.5   | 36852 / 40186    | 144 / 176 | 2 / 2    |
| v1   | + 지난 메시지 memo                     | 4.1 / 4.8     | 191 / 243        | 60 / 88   | 2 / 2    |
| v2   | + rAF 배칭                             | 4.4 / 4.7     | 162.5 / 303      | 40 / 56   | 2 / 2    |
| v3   | + 스트리밍 중 평문                     | 0.5 / 0.6     | 125.5 / 168      | 44 / 56   | 2 / 2    |
| v4   | + key를 clientId로 유지                | 0.5 / 0.6     | 134.5 / 169      | 28 / 48   | 0 / 0    |
| v5   | + `useLayoutEffect` 스크롤 보정        | 0.5 / 0.6     | 137 / 221        | 44 / 152  | 0 / 0    |

- **memo(v1)의 효과가 가장 컸다.** v0은 응답이 스트리밍되는 37.5초 동안 메인 스레드가 Long task로 거의 막혀 있었다.
- **평문 렌더(v3)는 평균 렌더를 4.4ms → 0.5ms로 줄였다.** 대신 최대 렌더는 `final`에서 마크다운을 한 번에 파싱하면서 늘었다(86.4ms → 108.2ms).
- **rAF 배칭(v2)의 효과는 측정되지 않았다.** 토큰이 고르게 오는 조건에서도, 2초씩 몰려 오는 조건([`results-proxy-buffering.md`](docs/results-proxy-buffering.md): 커밋 수 v1 25.5, v2 26)에서도 차이가 없었다. 토큰이 프레임보다 짧은 간격으로 따로 오는 조건은 재지 않았다([009](docs/decisions/009-render-variants.md)).
- **key 승계(v4)로 리마운트가 턴당 2회에서 0회가 됐다.**
- v4와 v5는 턴 도중의 코드가 같다. INP p90의 차이(48ms, 152ms)는 측정 편차로 본다. v5는 10회 중 두 번이 152ms, 216ms로 튀었다.

### 위로 불러오기 스크롤 보정

과거 메시지 50개를 불러온 뒤, 화면 맨 위에 보이던 메시지가 제자리에 있는지 쟀다. 출처는 [`docs/results-raw.json`](docs/results-raw.json)의 실행별 값이다. 중앙값만 보면 두 방식 모두 위치 오차가 0이라서 차이가 가려지므로, 실행별 횟수로 적는다.

| 보정 방식               | 실행 | 1프레임 이상 튐 | 보정 실패          |
| ----------------------- | ---- | --------------- | ------------------ |
| 요청 완료 → rAF (v0~v4) | 50회 | 50회            | 6회 (3,195px 밀림) |
| `useLayoutEffect` (v5)  | 10회 | 0회             | 0회                |

## 실행 방법

요구 사항: Node 22.12+, Yarn 1.22.22

```bash
yarn install
yarn dev         # mock-server(8787) + web(5173)
yarn lint        # ESLint + Prettier 검사
yarn typecheck   # tsc -b
yarn test        # Vitest 단위 테스트
yarn e2e         # Playwright E2E (mock-server와 web을 함께 띄운다)
yarn bench       # 렌더 비용 측정 → docs/results.md (v0~v5 × 10회, 약 50분)
```

E2E를 처음 실행할 때는 브라우저를 설치한다: `yarn playwright install chromium`

장애 시나리오는 URL로 고른다. 같은 `seed`는 같은 응답을 만든다.

```
http://localhost:5173/?scenario=normal&seed=11
http://localhost:5173/?scenario=done-only&seed=11
http://localhost:5173/?scenario=close-after-final&seed=11
http://localhost:5173/?scenario=drop-after-saved&seed=11
```

시나리오 11개의 서버 동작과 기대 결과는 [`docs/protocol.md`](docs/protocol.md)에 있다. 전송 방식은 `?transport=eventsource`(기본) 또는 `?transport=fetch`로 고른다. 두 방식의 차이는 [`docs/decisions/012`](docs/decisions/012-eventsource-vs-fetch.md)에 있다.

```
http://localhost:5173/?scenario=drop-mid-stream&seed=11&transport=fetch
http://localhost:5173/?scenario=long-silence&silence=8000&heartbeat=off&idleTimeout=3000&transport=fetch
```

렌더 비교 버전은 `?v=0`~`?v=5`로 고른다. 기본값은 v5다. 버전별 기법은 [`docs/decisions/009`](docs/decisions/009-render-variants.md), [`014`](docs/decisions/014-client-id-render-key.md), [`015`](docs/decisions/015-scroll-correction-timing.md)에 있고, 측정 방법은 [`docs/decisions/010`](docs/decisions/010-benchmark-method.md)에 있다. 다른 시나리오는 `yarn bench --scenario proxy-buffering --variants 1,2`처럼 고르고, 결과는 `docs/results-<시나리오>.md`에 쓴다. 빠르게 확인할 때는 `yarn bench --runs 1 --variants 0,5`를 쓴다. 이때는 결과를 출력만 하고 파일은 쓰지 않는다.

## 구조

```
apps/web               React 19 + Vite 채팅 클라이언트
apps/mock-server       Hono 목 서버, 장애 시나리오
packages/sse-parser    프레임워크와 무관한 SSE 스트리밍 파서
packages/chat-protocol 이벤트 타입과 zod 스키마 (클라이언트·서버 공유)
```

## 문서

| 문서                                                   | 내용                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| [`docs/protocol.md`](docs/protocol.md)                 | API, 이벤트 계약, 종료 신호, 끊김 처리, 하트비트, 인증, 시나리오 |
| [`docs/decisions/`](docs/decisions/)                   | 설계 판단 001~016 (상황 / 대안 / 결정 / 트레이드오프)            |
| [`docs/results.md`](docs/results.md)                   | 측정 결과와 측정 조건 (`yarn bench`가 생성)                      |
| [`docs/manual-checklist.md`](docs/manual-checklist.md) | 자동화하지 않은 확인 항목 (IME, Safari 스크롤)                   |
| [`docs/LEARNING.md`](docs/LEARNING.md)                 | 실무에서 배운 것 (이 저장소의 출발점)                            |
| [`docs/DEMO_SPEC.md`](docs/DEMO_SPEC.md)               | 이 저장소의 설계서                                               |
