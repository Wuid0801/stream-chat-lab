# 스트림 프로토콜

클라이언트(`apps/web`)와 목 서버(`apps/mock-server`)가 지키는 계약이다. 타입과 스키마는 `packages/chat-protocol`에 있고, 양쪽이 같은 스키마로 검증한다.

## 흐름: 보내기와 받기를 나눈다

```
POST /turns                    Authorization: Bearer <demo-token>
  { clientId, text, scenario?, scenarioOptions?, seed? }
  → { turnId, streamToken }

GET  /turns/:id/stream?token=<streamToken>[&lastEventId=N]                (EventSource)
GET  /turns/:id/stream   Authorization: Bearer <demo-token>  [Last-Event-ID: N]   (fetch)
  → text/event-stream

POST /turns/:id/stream-token   Authorization: Bearer <demo-token>
  → { streamToken }            이어 받기용 새 1회용 토큰

GET  /turns/:id                Authorization: Bearer <demo-token>
  → { id, clientId, status, userMessage, assistantMessage | null }

GET  /messages?cursor=&limit=  Authorization: Bearer <demo-token>
  → { messages (오래된 순), nextCursor | null }
```

- 사용자 메시지는 `POST /turns`에서 바로 저장된다. 응답 메시지는 생성이 끝났을 때 저장된다.
- **응답 생성은 연결과 따로 돈다.** 서버는 첫 구독 때 생성을 시작하고, 이벤트를 턴별 버퍼에 쌓는다. 연결이 끊겨도 생성은 끝까지 돌아 저장된다. ([decisions/011](decisions/011-resumable-stream.md))
- 메시지를 GET 쿼리 스트링에 싣지 않는다. URL 길이 제한이나 서버·프록시 로그에 대화 내용이 남는 문제가 없다.

## 이벤트

SSE의 `event:` 필드는 쓰지 않는다(모두 기본 `message`). 이벤트 종류는 `data` JSON의 `type`으로 구분한다.

- 이유: `event: error`를 보내면 EventSource의 연결 오류 이벤트(`error`)와 이름이 겹쳐 둘을 구분할 수 없다. ([decisions/004](decisions/004-event-type-in-data.md))
- 모든 이벤트에 `id:`가 붙는다. 턴 안에서 1부터 1씩 오른다. 이어 받기 위치로 쓴다.

| type    | 필드                                        | 의미                                    |
| ------- | ------------------------------------------- | --------------------------------------- |
| `token` | `turnId`, `seq`, `text`                     | 응답 조각. 이어 붙이면 응답 전문이다.   |
| `done`  | `turnId`                                    | 생성이 끝났다는 알림. **종료가 아니다** |
| `final` | `turnId`, `userMessage`, `assistantMessage` | **유일한 정상 종료.** 서버 확정 메시지  |
| `error` | `turnId`, `code`, `message`                 | 서버가 알리는 실패. 실패로 종료한다.    |

### 순서

```
token* → done → final
token* → error
```

- 클라이언트는 `final` 또는 `error`를 받으면 연결을 닫는다.
- 그 뒤에 오는 이벤트와 연결 오류는 무시한다.
- `done`에서 연결을 닫지 않는다. 바로 뒤에 오는 `final`이 서버 확정 데이터(메시지 id 등)를 담고 있기 때문이다. (LEARNING.md 3장)

### 계약 위반 (클라이언트는 경고를 남긴다)

- 스키마에 맞지 않는 `data`: 그 이벤트를 무시한다.
- `final` 없이 `done` 뒤에 연결이 닫힘: `GET /turns/:id`로 서버 상태를 확인해 복구한다.
- `token`의 `seq`가 건너뜀: 빠진 범위를 경고한다. 이미 받은 `seq`는 무시한다.
- 스트림으로 받은 텍스트와 `final`의 응답 텍스트가 다름: 확정 텍스트를 쓴다.

## 끊김 처리

연결 오류 알림은 실패뿐 아니라 서버가 정상적으로 연결을 닫을 때도 온다. 클라이언트는 다음 순서로 처리한다.

1. 연결을 즉시 닫는다. EventSource의 자동 재연결은 이미 쓴 1회용 토큰으로 같은 URL을 다시 요청하기 때문이다. 다시 구독할지는 클라이언트가 정한다.
2. `final`을 이미 받았다면 아무것도 하지 않는다.
3. 상태 코드가 401이면 `unauthorized`, 5xx면 `server-error`로 실패한다. 상태 코드는 fetch 어댑터만 알 수 있다.
4. `done`을 받았다면 이어 받지 않고 `GET /turns/:id`로 확인한다. 생성은 끝났고 `final`만 빠진 상황이다.
5. 아무 이벤트도 받지 못했다면 실패로 처리한다(`stream-failed`).
6. `token`을 받는 중이었다면 **이어 받는다.**
   - 0.5초 → 1초 → 2초를 기다리며 최대 3번 시도한다.
   - 매번 `POST /turns/:id/stream-token`으로 새 토큰을 받고, 마지막으로 받은 이벤트 id부터 다시 구독한다.
   - 이벤트를 하나라도 받으면 시도 횟수를 다시 센다.
   - **턴을 다시 만들지 않는다.** 재연결이 재전송이 되지 않는다.
7. 이어 받기를 모두 실패하면 `GET /turns/:id`로 확인한다. `completed`이면 성공, 아니면 실패로 처리한다. (오탐 복구)

## 하트비트와 타임아웃

- 서버는 이벤트가 `heartbeatMs`(기본 15초) 동안 없으면 주석 줄(`: ping`)을 보낸다. `final` 뒤에도 클라이언트가 닫을 때까지 보낸다.
- **fetch 어댑터**는 바이트를 직접 읽으므로 하트비트를 볼 수 있다. `idleTimeout`(기본 45초 = 하트비트 3번) 동안 아무 바이트도 오지 않으면 끊긴 것으로 보고 위의 끊김 처리로 넘어간다.
- **네이티브 EventSource**는 주석 줄을 이벤트로 넘기지 않아 하트비트를 볼 수 없다. 그래서 idle 타임아웃을 두지 않고, 연결 유지는 브라우저에 맡긴다. ([decisions/012](decisions/012-eventsource-vs-fetch.md))

## 인증

- API 요청은 `Authorization: Bearer <demo-token>` 헤더로 인증한다. 데모용 고정 토큰이다.
- EventSource 어댑터는 `POST /turns` 또는 `POST /turns/:id/stream-token`이 돌려준 `streamToken`을 쿼리로 보낸다.
  - 네이티브 EventSource는 요청 헤더를 넣을 수 없기 때문이다.
  - `streamToken`은 **60초 안에 한 번만** 쓸 수 있고, 발급된 턴에만 쓸 수 있다.
- fetch 어댑터는 같은 엔드포인트를 헤더로 인증한다. URL에 토큰을 넣지 않는다.

### 트레이드오프

URL의 토큰은 브라우저 기록, 서버·프록시 접근 로그, `Referer` 헤더에 남을 수 있다. 짧은 만료와 1회 사용으로 위험을 줄인다.

- 로그에 남은 토큰은 이미 쓰였거나 곧 만료된다.
- 토큰 하나로 열 수 있는 것은 그 턴의 스트림 하나뿐이다.

대가로 EventSource의 자동 재연결은 항상 401로 실패한다. 이 저장소는 자동 재연결을 쓰지 않고, 이어 받을 때마다 새 토큰을 받는다.

## 재전송 (같은 clientId)

같은 `clientId`로 `POST /turns`를 다시 보내는 경우 ([decisions/007](decisions/007-idempotent-turn-by-client-id.md), [013](decisions/013-retry-failed-turn.md))

- 완료된 턴이 있으면 새 턴을 만들지 않고 같은 `turnId`와 새 `streamToken`을 준다. 처음부터 구독하면 `final`만 보낸다.
- 응답을 만들기 전에 실패한 턴(`failed`)이 있으면 **같은 턴을 다시 쓴다.** 사용자 메시지가 중복되지 않는다.
- 진행 중인 턴이 있으면 `409 turn-in-progress`

## 식별자

- `clientId`: 클라이언트가 만든 사용자 메시지 id. 서버는 저장한 메시지에 그대로 돌려준다(echo).
- 응답 메시지의 `clientId`는 `replyClientId(userClientId)` = `<userClientId>:reply`
- 클라이언트는 낙관적 메시지와 서버 메시지를 **clientId로만** 매칭한다. 텍스트나 시각은 쓰지 않는다.

## 장애 시나리오

`POST /turns`의 `scenario`로 고른다. web은 페이지 URL의 `?scenario=&seed=`를 그대로 보낸다. 같은 `seed`는 같은 응답(토큰 분할, 속도, 바이트 분할)을 만든다. **끊기와 HTTP 오류는 첫 구독에만 적용**한다. 이어 받기와 재시도는 성공할 수 있어야 하기 때문이다.

| 시나리오            | 서버 동작                                                    | 클라이언트 결과                                                            |
| ------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `normal`            | token(20~60/s) → done → final, 연결 유지 + 하트비트          | 정상 완료                                                                  |
| `done-only`         | token → done 후 close (final 없음), 서버 저장 완료           | 계약 위반 경고 + 서버 확인으로 복구                                        |
| `close-after-final` | token → done → final 직후 close                              | 오류 없음                                                                  |
| `drop-after-saved`  | token → 서버 저장 → done 전에 TCP 끊기                       | 이어 받아 done/final 수신, 오탐 오류 없음                                  |
| `drop-mid-stream`   | 토큰 1/3 지점에서 TCP 끊기 (생성은 계속)                     | `lastEventId`부터 이어 받기, 턴 재생성 없음                                |
| `slow-first-token`  | 첫 토큰까지 5~15초 (`firstTokenDelayMs`)                     | 대기 표시 유지, 타임아웃 없음                                              |
| `long-silence`      | 응답 중간 60초 침묵 (`silenceMs`), 하트비트 on/off           | on: 연결 유지. off: fetch는 idle 타임아웃 후 이어 받기, EventSource는 유지 |
| `http-401`          | 스트림 시작 시 401, 턴은 `failed`                            | fetch: 재인증 안내. EventSource: 일반 실패. 재시도하면 같은 턴으로 성공    |
| `http-5xx`          | 스트림 시작 시 503, 턴은 `failed`                            | fetch: 서버 오류 안내. EventSource: 일반 실패. 재시도하면 성공             |
| `chunk-chaos`       | 1~7바이트 무작위 분할, 줄바꿈(`\n`, `\r\n`, `\r`) 혼용, 주석 | 깨짐 없이 표시, 확정 텍스트와 같음                                         |
| `proxy-buffering`   | 이벤트를 `bufferMs`(기본 2초)씩 모아 한 번에 전송            | 몰려서 표시되지만 내용 정확                                                |

시간 값은 `scenarioOptions`(`firstTokenDelayMs`, `silenceMs`, `heartbeat`, `heartbeatMs`, `bufferMs`)로 바꿀 수 있다. 기본값은 DEMO_SPEC 4장 그대로이고, E2E는 몇 초 단위로 줄여서 쓴다.

### 클라이언트 쪽 시나리오

서버의 `scenario`가 아니라 요청 순서와 입력으로 만든다.

| 시나리오               | 만드는 방법                                                                                           | 클라이언트 결과                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `out-of-order-history` | `GET /messages?delayMs=`(web은 `?historyDelay=`)로 처음 히스토리 응답을 늦춤. 페이지는 응답 시점 기준 | 히스토리가 `final`보다 먼저 와도, 늦게 와도 중복·누락 없음 |
| `duplicate-text`       | 같은 문장을 연속으로 보냄                                                                             | 두 메시지 모두 표시 (clientId로만 매칭)                    |
