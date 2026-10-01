# 데모 저장소 설계서 — SSE 스트리밍 AI 채팅

> 목표: 실무에서 겪은 SSE 채팅 문제(종료 계약, 재연결, 낙관적 메시지 매칭, 턴 격리, 렌더 비용, 스크롤)를
> **회사 코드 없이** 처음부터 다시 구현하고, 장애 시나리오와 측정으로 증명한다.
> 실무 버전의 "다시 만든다면"을 설계 목표로 삼는다 (`LEARNING.md` 10장).

---

## 1. 저장소 이름 후보

1. `stream-chat-lab` — 실험·측정 중심이라는 점이 드러남
2. `sse-chat-resilience` — 장애 대응(끊김, 오탐, 중복)이 주제임을 강조
3. `token-stream-chat` — 토큰 스트리밍 UI라는 기능 자체를 강조

추천: **`stream-chat-lab`** (비교 버전과 측정 결과를 담는 저장소라는 성격과 맞음)

---

## 2. 폴더 구조 (pnpm 모노레포)

```
stream-chat-lab/
├─ apps/
│  ├─ web/                    # React 19 + Vite (또는 Next.js App Router)
│  │  ├─ src/
│  │  │  ├─ chat/             # ChatView, MessageList, Composer
│  │  │  ├─ stream/           # 전송 어댑터: eventsource / fetch-stream
│  │  │  ├─ turn/             # Turn 객체(수명 전체 소유), 상태 머신
│  │  │  ├─ store/            # 메시지 정규화 스토어 + 매칭
│  │  │  └─ variants/         # v0~v5 비교 버전 토글 (?v=3)
│  │  └─ e2e/                 # Playwright
│  └─ mock-server/            # Node (Hono 또는 Fastify)
│     ├─ src/routes/turns.ts  # POST /turns, GET /turns/:id/stream
│     ├─ src/routes/messages.ts # GET /messages?cursor=
│     └─ src/scenarios/       # 장애 시나리오 (아래 4장)
├─ packages/
│  ├─ sse-parser/             # 프레임워크 무관 SSE 파서 (+ 단위 테스트)
│  ├─ chat-protocol/          # 이벤트 타입, zod 스키마 (클라/서버 공유 계약)
│  └─ bench/                  # Profiler 수집 스크립트, 결과 표 생성
├─ docs/
│  ├─ protocol.md             # 이벤트 계약: 종류, 순서, 종료 신호, 하트비트
│  └─ results.md              # 측정 결과
├─ .github/workflows/ci.yml
└─ pnpm-workspace.yaml
```

---

## 3. 기능

### 기본

- 메시지 전송 → 토큰 스트리밍 표시 → 확정
- 낙관적 사용자 메시지(즉시 표시), 서버 확정 시 교체
- 위로 무한 스크롤(커서 페이지네이션), 위치 유지
- 바닥 근처일 때만 자동 스크롤, 떨어져 있으면 "새 메시지 ↓" 버튼
- 중지 버튼(진행 중 턴 취소)
- 한글 IME 조합 중 Enter 무시

### 심화 (실무 회고의 "다시 만든다면")

| 목표 | 설계 |
|---|---|
| 보내기와 받기 분리 | `POST /turns` → `{ turnId }` → `GET /turns/:id/stream`. 두 가지 전송 어댑터를 같은 인터페이스로 제공: EventSource 계열 vs fetch 스트림 |
| 명시적 종료 계약 | `chat-protocol`에 `token`, `tool`, `done`, `final`, `error` 이벤트를 정의하고, **`final`만 종료**로 규정. 계약 위반을 감지해 경고 |
| 이어 받기 | 이벤트마다 `id:`. 끊기면 `Last-Event-ID`로 재구독. 서버는 턴별 이벤트 버퍼 보관. "재연결 = 재전송"이 아니게 됨 |
| 턴 객체 | `Turn { id, clientId, status, abort(), events }`가 준비 → 스트림 → reconcile을 모두 소유. 세대 번호를 한 곳에 둠 |
| 식별자 | 서버가 `clientId`를 echo. 렌더 key는 끝까지 `clientId` (리마운트 없음) |
| 실패 UX | `failed` 상태 말풍선에 재시도·복사. 입력 내용이 절대 사라지지 않음 |
| 렌더 비용 | rAF 배칭, 스트리밍 중 평문 → `final`에 마크다운, 지난 메시지 memo |
| 스크롤 | sentinel + `IntersectionObserver` 트리거, `useLayoutEffect` 보정 |
| 오탐 복구 | 토큰을 받은 뒤 끊기면 `GET /turns/:id`로 서버 상태 확인 → 완료돼 있으면 성공 처리 |

---

## 4. 목 서버 장애 시나리오

쿼리나 헤더(`?scenario=`)로 고른다. 모든 시나리오는 seed로 재현할 수 있게 한다.

| 시나리오 | 동작 | 클라이언트가 보여야 할 결과 |
|---|---|---|
| `normal` | 20~60 tokens/s, `done` → `final` | 정상 완료 |
| `slow-first-token` | 첫 토큰까지 5~15s | 타이핑 표시 유지, 타임아웃 없음 |
| `long-silence` | 중간에 60s 침묵 (주석 하트비트 on/off) | 하트비트 on이면 유지, off면 타임아웃 규칙대로 |
| `done-only` | `final` 없이 `done` 후 close | 계약 위반 경고 + 서버 상태 확인으로 복구 |
| `close-after-final` | `final` 직후 close (onerror 발생) | 오류 없음 |
| `drop-mid-stream` | N번째 토큰 후 TCP 끊기 | `Last-Event-ID`로 이어 받기 (재전송 없음) |
| `drop-after-saved` | 서버 저장 완료 후 응답 직전 끊기 | 오탐 오류 없이 성공 복구 |
| `http-401` / `http-5xx` | 스트림 시작 시 상태 코드 | 각각 재인증 안내 / 재시도 버튼 |
| `chunk-chaos` | 이벤트를 무작위 바이트 위치에서 분할, 한글 포함, `\r\n` 혼용 | 깨짐 없이 표시 |
| `proxy-buffering` | 토큰을 2s씩 모아 한 번에 전송 | 표시는 몰려서 되지만 내용 정확 |
| `out-of-order-history` | 히스토리 응답이 스트림 확정보다 늦게/먼저 도착 | 중복·누락 없음 |
| `duplicate-text` | 같은 문장을 연속 전송 | 두 메시지 모두 표시 |

---

## 5. 테스트

### 단위 (Vitest)

- `sse-parser`: 이벤트 분할, 한 청크 다중 이벤트, 여러 줄 data, 콜론 뒤 공백 규칙, 주석, `\r` 청크 경계, UTF-8 경계, 마지막 flush
- `turn`: 준비 중 두 번째 send 거부, 취소된 준비가 연결을 만들지 못함, 이전 턴 큐 이벤트 무시, `final → error` 무음, 언마운트 시 abort
- `store`: clientId 매칭, server id FIFO 매칭, 중복 텍스트, 순서 뒤바뀐 응답, 실패 → 재시도
- 렌더 key 안정성: 확정 전후 같은 key

### E2E (Playwright)

- 4장 시나리오마다 1개 이상
- 스트리밍 중 위로 스크롤 → 끌려 내려가지 않음
- 과거 로드 후 화면에 보이던 첫 메시지의 위치가 ±1px 이내로 유지
- 스트리밍 중 페이지 이동 → 콘솔 경고 없음, 열린 연결 없음
- IME: `compositionstart` 중 Enter → 전송 안 됨 (Chromium, WebKit)

### CI (`.github/workflows/ci.yml`)

- `pnpm install --frozen-lockfile`
- `pnpm lint` (ESLint + Prettier check)
- `pnpm typecheck` (`tsc -b`)
- `pnpm test` (Vitest, 커버리지 리포트)
- `pnpm e2e` (Playwright, mock-server를 함께 띄움)
- (선택) Lighthouse CI: 채팅 페이지 TBT/INP 예산

---

## 6. 측정 계획

### 비교 버전 (한 번에 기법 하나씩)

| 버전 | 추가되는 기법 |
|---|---|
| v0 | 기준: 토큰마다 setState, 모든 메시지 마크다운, key = 서버 id(확정 시 교체) |
| v1 | + 지난 메시지 memo |
| v2 | + rAF 배칭 |
| v3 | + 스트리밍 중 평문, `final`에 마크다운 |
| v4 | + 렌더 key를 clientId로 유지 |
| v5 | + 스크롤 보정을 `useLayoutEffect`로 |

### 지표와 도구

| 지표 | 도구 |
|---|---|
| 스트리밍 1턴당 React 커밋 수, 평균/최대 커밋 시간 | React Profiler API (`<Profiler onRender>`) → `packages/bench` 수집 |
| Long task 수/총 시간, INP(스트리밍 중 입력) | PerformanceObserver(`longtask`, `event`), Playwright로 자동 입력 |
| 리마운트 수 | 말풍선 `useEffect` 마운트 카운터 |
| 과거 로드 후 위치 오차(px), 튄 프레임 수 | Playwright + `requestAnimationFrame` 샘플링 |
| 스트림 오탐 오류율 | 시나리오 `drop-after-saved` N회 반복 |

### 측정 조건 (고정)

- 메시지 200개가 있는 대화, 응답 1,500 토큰, 40 tokens/s (`normal` 시나리오, 고정 seed)
- Chrome 안정판, CPU 4× 스로틀링, 프로덕션 빌드, 확장 프로그램 없음
- 버전마다 10회 실행, 중앙값과 p90 보고

### 결과 표 틀 (`docs/results.md`)

| 버전 | 커밋 수/턴 | 평균 커밋(ms) | 최대 커밋(ms) | Long task 총(ms) | INP(ms) | 리마운트 | 위치 오차(px) |
|---|---|---|---|---|---|---|---|
| v0 | | | | | | | |
| v1 | | | | | | | |
| v2 | | | | | | | |
| v3 | | | | | | | |
| v4 | | | | | | | |
| v5 | | | | | | | |

> 칸은 측정 후에만 채운다. 추정치를 미리 쓰지 않는다.

---

## 7. README 목차 초안

1. **한 줄 소개**: SSE 토큰 스트리밍 채팅에서 끊김, 오탐, 중복, 렌더 비용을 다루는 실험 저장소
2. **GIF · 데모 링크**: 정상 / 연결 끊김 후 이어 받기 / 실패 → 재시도 / 스크롤 유지
3. **문제**: 실무에서 겪은 6가지 (종료 계약, 재연결 = 재전송, 낙관적 메시지 중복, 이전 턴 오염, 토큰마다 렌더, 스크롤 튐)
4. **설계 판단**: 보내기와 받기 분리, `final`만 종료, Turn 객체, clientId 승계, rAF + 평문 렌더, `useLayoutEffect` 보정 — 각각 기각한 대안 포함
5. **결과**: `docs/results.md` 표 요약 + 장애 시나리오 통과 목록
6. **실행 방법**: `pnpm i && pnpm dev` (web + mock-server), `?scenario=` / `?v=` 사용법, 테스트·측정 명령

---

## 8. 프로필 README 연결 문장

> **stream-chat-lab** — Rebuilt a production SSE streaming chat from scratch to test what I learned the hard way: an explicit stream-termination contract, resumable streams instead of re-sending on reconnect, ID-stable optimistic messages, and render batching — each verified against fault-injecting mock-server scenarios and measured one technique at a time.
