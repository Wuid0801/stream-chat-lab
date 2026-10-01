# 004. 이벤트 종류를 SSE event 필드가 아니라 data JSON의 type으로 구분한다

## 상황

이벤트는 `token`, `done`, `final`, `error` 네 가지다. SSE의 `event:` 필드로 이름을 붙이면 EventSource에서 `addEventListener('token', …)`처럼 받을 수 있다.

그런데 `event: error`는 EventSource의 연결 오류 이벤트와 같은 이름이다. 둘 다 `error` 리스너로 들어오기 때문에 "서버가 보낸 실패"와 "연결 끊김"을 구분할 수 없다.

## 검토한 대안

1. `event:` 필드 사용 + `error`만 다른 이름(`failure` 등)으로 바꾸기 — 프로토콜 용어가 전송 방식 때문에 바뀐다.
2. `event:` 필드 사용 + 리스너에서 `MessageEvent`인지 검사 — 동작은 하지만 실수하기 쉽다.
3. **`event:` 필드를 쓰지 않고 `data` JSON의 `type`으로 구분**

## 결정

3번. 모든 이벤트는 기본 `message` 이벤트로 오고, zod `discriminatedUnion('type')`으로 검증한다.

## 트레이드오프

- 이벤트 종류를 알려면 JSON을 파싱해야 한다. 어차피 모든 이벤트에 JSON 본문이 있으므로 추가 비용은 없다.
- fetch 어댑터(M4)와 EventSource 어댑터가 같은 해석 코드(`parseStreamEvent`)를 공유한다.
