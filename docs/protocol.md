# 스트림 프로토콜

클라이언트(`apps/web`)와 목 서버(`apps/mock-server`)가 지키는 계약이다. 타입과 스키마는 `packages/chat-protocol`에 있고, 양쪽이 같은 스키마로 검증한다.

## 흐름: 보내기와 받기를 나눈다

```
POST /turns                    Authorization: Bearer <demo-token>
  { clientId, text, scenario?, seed? }
  → { turnId, streamToken }

GET  /turns/:id/stream?token=<streamToken>      (EventSource)
GET  /turns/:id/stream  Authorization: Bearer <demo-token>   (fetch 스트림, M4)
  → text/event-stream

GET  /turns/:id                Authorization: Bearer <demo-token>
  → { id, clientId, status, userMessage, assistantMessage | null }

GET  /messages?cursor=&limit=  Authorization: Bearer <demo-token>
  → { messages (오래된 순), nextCursor | null }
```

- 사용자 메시지는 `POST /turns`에서 바로 저장된다. 응답 메시지는 생성이 끝났을 때 저장된다.
- 스트림 연결이 중간에 끊겨도 서버는 생성을 끝까지 마치고 저장한다. 클라이언트는 `GET /turns/:id`로 결과를 확인할 수 있다.
- 메시지를 GET 쿼리 스트링에 싣지 않는다. URL 길이 제한이나 서버·프록시 로그에 대화 내용이 남는 문제가 없다.

## 이벤트

SSE의 `event:` 필드는 쓰지 않는다(모두 기본 `message`). 이벤트 종류는 `data` JSON의 `type`으로 구분한다.

- 이유: `event: error`를 보내면 EventSource의 연결 오류 이벤트(`error`)와 이름이 겹쳐 둘을 구분할 수 없다. ([decisions/004](decisions/004-event-type-in-data.md))

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
- 그 뒤에 오는 이벤트와 연결 오류(`onerror`)는 무시한다.
- `done`에서 연결을 닫지 않는다. 바로 뒤에 오는 `final`이 서버 확정 데이터(메시지 id 등)를 담고 있기 때문이다. (LEARNING.md 3장)

### 계약 위반

- 스키마에 맞지 않는 `data`: 클라이언트는 경고를 남기고 그 이벤트를 무시한다.
- `final` 없이 `done` 뒤에 연결이 닫힘: 클라이언트는 경고를 남기고 `GET /turns/:id`로 서버 상태를 확인해 복구한다.

## 끊김 처리

EventSource의 `onerror`는 실패뿐 아니라 서버가 정상적으로 연결을 닫을 때도 발생한다. 클라이언트는 다음 순서로 처리한다.

1. 연결을 즉시 닫는다. 자동 재연결을 막기 위해서다. 같은 URL로 다시 연결하면 이미 쓴 1회용 토큰으로 재구독을 시도하게 된다.
2. `final`을 이미 받았다면 아무것도 하지 않는다.
3. `token`이나 `done`을 하나도 받지 못했다면 실패로 처리한다.
4. 받은 적이 있다면 `GET /turns/:id`로 확인한다. `completed`이면 성공, 아니면 실패로 처리한다. (오탐 복구)

## 하트비트

- 서버는 `final`을 보낸 뒤 연결을 닫기 전까지 15초마다 주석 줄(`: ping`)을 보낸다.
- 긴 침묵 중의 하트비트와 클라이언트 타임아웃 규칙은 M4(`long-silence` 시나리오)에서 정한다.

## 인증

- API 요청은 `Authorization: Bearer <demo-token>` 헤더로 인증한다. 데모용 고정 토큰이다.
- 스트림 구독은 `POST /turns`가 돌려준 `streamToken`을 쿼리로 보낸다.
  - 네이티브 EventSource는 요청 헤더를 넣을 수 없기 때문이다.
  - `streamToken`은 **60초 안에 한 번만** 쓸 수 있고, 발급된 턴에만 쓸 수 있다.
- fetch 스트림 어댑터(M4)는 같은 엔드포인트를 헤더로 인증한다.

### 트레이드오프

URL의 토큰은 브라우저 기록, 서버·프록시 접근 로그, `Referer` 헤더에 남을 수 있다. 짧은 만료와 1회 사용으로 위험을 줄인다.

- 로그에 남은 토큰은 이미 쓰였거나 곧 만료된다.
- 토큰 하나로 열 수 있는 것은 그 턴의 스트림 하나뿐이다.

대가로 EventSource의 자동 재연결은 항상 401로 실패한다. 이 저장소는 자동 재연결을 쓰지 않으므로(위 "끊김 처리") 문제가 되지 않는다.

## 재전송 (같은 clientId)

같은 `clientId`로 `POST /turns`를 다시 보내는 경우 ([decisions/007](decisions/007-idempotent-turn-by-client-id.md))

- 완료된 턴이 있으면 새 턴을 만들지 않고 같은 `turnId`와 새 `streamToken`을 준다. 그 스트림은 `final`만 보낸다.
- 진행 중인 턴이 있으면 `409 turn-in-progress`

## 식별자

- `clientId`: 클라이언트가 만든 사용자 메시지 id. 서버는 저장한 메시지에 그대로 돌려준다(echo).
- 응답 메시지의 `clientId`는 `replyClientId(userClientId)` = `<userClientId>:reply`
- 클라이언트는 낙관적 메시지와 서버 메시지를 **clientId로만** 매칭한다. 텍스트나 시각은 쓰지 않는다.

## 장애 시나리오

`POST /turns`의 `scenario`로 고른다. web은 페이지 URL의 `?scenario=&seed=`를 그대로 보낸다. 같은 `seed`는 같은 응답(토큰 분할, 속도)을 만든다.

| 시나리오            | 서버 동작                                           | 클라이언트 결과                     |
| ------------------- | --------------------------------------------------- | ----------------------------------- |
| `normal`            | token(20~60/s) → done → final, 연결 유지 + 하트비트 | 정상 완료                           |
| `done-only`         | token → done 후 close (final 없음), 서버 저장 완료  | 계약 위반 경고 + 서버 확인으로 복구 |
| `close-after-final` | token → done → final 직후 close                     | 오류 없음                           |
| `drop-after-saved`  | token → 서버 저장 → done/final 전에 TCP 끊기        | 오탐 오류 없이 성공 복구            |

M4 예정: `slow-first-token`, `long-silence`, `drop-mid-stream`, `http-401`, `http-5xx`, `chunk-chaos`, `proxy-buffering`, `out-of-order-history`, `duplicate-text`

## M4 예정: 이어 받기

이벤트마다 `id:`를 붙이고, 서버는 턴별 이벤트 버퍼를 보관한다. 1회용 토큰을 유지하면서 이어 받기 위한 계획은 다음과 같다.

- 재구독할 때 `POST /turns/:id/stream-token`으로 새 토큰을 받는다.
- EventSource 어댑터는 `?lastEventId=` 쿼리로 위치를 보낸다. 새로 만든 EventSource는 `Last-Event-ID` 헤더를 직접 넣을 수 없기 때문이다.
- fetch 어댑터는 `Last-Event-ID` 헤더로 보낸다.
