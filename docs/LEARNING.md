# SSE 스트리밍 AI 채팅을 만들며 배운 것

> 실무에서 SSE로 AI 응답을 토큰 단위로 받아 그리는 채팅을 만들고 1년 넘게 고쳐 오며 겪은 문제를 정리했다.
> 코드 예시는 개념을 보여 주려고 새로 쓴 일반 코드다.

---

## 1. 전송 방식 고르기: EventSource, 폴리필, fetch 스트림

### 문제

AI 응답은 서버 → 클라이언트 한 방향 스트림이다. 그런데 요청에는 인증 토큰을 헤더로 실어야 했다.

### 개념

| 방식 | 커스텀 헤더 | POST/body | 자동 재연결 | 파싱 | 취소 |
|---|---|---|---|---|---|
| 네이티브 `EventSource` | ✗ | ✗ | ✓ | 브라우저 | `close()` |
| EventSource 폴리필 | ✓ | ✗ (GET만) | ✓ | 라이브러리 | `close()` |
| `fetch` + `ReadableStream` | ✓ | ✓ | 직접 구현 | 직접 구현 | `AbortController` |

- 네이티브 `EventSource`는 GET만 되고 헤더를 못 넣는다. 쿠키(`withCredentials`)만 보낼 수 있다.
- 대신 자동 재연결과 `Last-Event-ID`를 공짜로 준다.

### 해결

- 실무에서는 **헤더를 넣을 수 있는 EventSource 폴리필**을 썼다. 요청은 GET 그대로다.
- 다만 GET만 되므로 요청 데이터를 보내는 방법이 제한된다. "메시지를 보내는 요청"과 "응답을 받는 스트림"이 한 요청에 묶이는 구조가 된다.
- 다시 만든다면 **POST로 "턴"을 만들고, 받은 id로 스트림을 구독**하는 두 단계 구조나, fetch 스트림 POST를 고르겠다.

### 확인할 실험

- [ ] 세 방식으로 같은 채팅을 구현해 코드 양과 기능 비교
- [ ] GET 한 번에 "보내기 + 받기"를 묶은 구조와 "POST로 턴 생성 → GET 구독" 구조의 재시도·취소 동작 비교

---

## 2. 청크는 이벤트 단위로 오지 않는다 (fetch 스트림을 직접 구현할 때)

### 문제

fetch 스트림으로 직접 파싱하면 이벤트가 중간에서 잘리고, 한글이 깨진다.

### 개념

- **청크 경계 ≠ 이벤트 경계.** 버퍼에 이어 붙이다가 빈 줄을 만나면 이벤트 하나로 꺼낸다.
- **UTF-8 멀티바이트 문자도 잘린다.** `TextDecoder.decode(chunk, { stream: true })`로 미완성 바이트를 이월한다. 끝나면 `decode()`로 한 번 더 비운다.
- **SSE 규칙**
  - 줄바꿈은 `\n`, `\r\n`, `\r`이 모두 유효하다.
  - 여러 줄의 `data:`는 `\n`으로 합친다.
  - 콜론 뒤 공백은 한 칸만 버린다.
  - `:`로 시작하는 줄은 주석(하트비트)이다.
  - 스트림 맨 앞의 BOM(`﻿`)은 제거한다.
  - `data:` 줄이 하나도 없는 이벤트는 dispatch하지 않는다.

### 해결

처음에는 `split(/\r\n\r\n|\n\n|\r\r/)`처럼 빈 줄 패턴을 나열해서 잘랐다. 하지만 이 방식은 **줄바꿈이 섞이면** 경계를 놓친다.

- 예: `data: a\r\n\r` 다음에 새 이벤트가 오면, 줄 끝은 `\r\n`이고 빈 줄은 `\r`이다. 어느 패턴에도 맞지 않아 두 이벤트가 하나로 합쳐진다.
- `\n\r\n`, `\r\n\n`도 같은 문제가 있다.

그래서 **줄바꿈을 먼저 `\n`으로 통일한 뒤** 빈 줄로 자른다. 단, 청크 끝의 `\r`은 다음 청크의 `\n`과 짝(`\r\n`)일 수 있다. 그대로 통일하면 빈 줄이 하나 더 생기므로 남겨 둔다.

```ts
const decoder = new TextDecoder()
let buffer = ''
for (;;) {
  const { value, done } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })

  // 끝의 \r은 다음 청크의 \n과 짝일 수 있으니 남겨 둔다
  const cut = buffer.endsWith('\r') ? buffer.length - 1 : buffer.length
  const parts = buffer.slice(0, cut).replace(/\r\n?/g, '\n').split('\n\n')
  buffer = (parts.pop() ?? '') + buffer.slice(cut) // 마지막 조각은 미완성일 수 있다
  for (const raw of parts) onEvent(parseEvent(raw))
}
// 스트림 끝: 디코더에 남은 바이트를 비우고, 남겨 둔 \r까지 포함해 한 번 더 자른다.
// (스트림이 정확히 "\r\r"로 끝나면 위 루프에서는 마지막 이벤트가 대기 상태로 남는다)
buffer += decoder.decode()
const rest = buffer.replace(/\r\n?/g, '\n').split('\n\n')
rest.pop() // 빈 줄로 끝나지 않은 마지막 조각은 표준상 버린다
for (const raw of rest) onEvent(parseEvent(raw))
```

### 확인할 실험

- [ ] 이벤트를 무작위 바이트 위치에서 자르는 목 서버
- [ ] 파서 단위 테스트: 분할, 한 청크에 여러 이벤트, 여러 줄 data, 한글 경계, `\r` 하나가 청크 끝에 걸린 경우, 줄바꿈 혼용(`\r\n\r`, `\n\r\n`), BOM, data 없는 이벤트

---

## 3. "끝났다"는 신호를 정하는 것이 가장 어려웠다

### 문제

- 응답이 정상으로 끝났는데도 오류 토스트가 떴다.
- 반대로 어떤 환경에서는 마지막 이벤트를 잃었다.

### 개념

- **EventSource의 `onerror`는 실패만 뜻하지 않는다.** 서버가 연결을 정상적으로 닫아도 발생한다.
- 그래서 **"의미 있는 종료 이벤트를 받았는가"를 따로 추적**해야 한다.
- 서버는 종료를 알리는 이벤트를 여러 개 보낼 수 있다. 예를 들어 "생성 끝" 다음에 "확정 데이터"가 온다.
  - 이때 앞의 이벤트에서 연결을 닫으면 뒤의 이벤트를 잃는다.

### 해결

실제로 겪은 순서:

1. 개발 환경에서 "확정 데이터" 이벤트가 오지 않는 것을 보고 "생성 끝"도 종료로 처리했다.
2. 운영 서버는 두 이벤트를 **순서대로 모두** 보내고 있었다. 1번 때문에 확정 데이터가 유실됐다.
3. **마지막 확정 이벤트만 종료 신호로** 되돌렸다. 그 이벤트를 받은 뒤의 `onerror`는 무시한다.

```ts
let gotFinal = false
source.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.type === 'final') { gotFinal = true; onFinal(msg.payload); close() }
}
source.onerror = (e) => {
  close()
  if (gotFinal) return            // 정상 종료 뒤의 onerror
  onError(buildContext(e))        // 어디까지 받았는지 함께 넘긴다
}
```

**배운 것: 종료 계약은 문서나 개발 환경이 아니라, 운영 서버가 실제로 보내는 이벤트 순서로 확인해야 한다.**

### 확인할 실험

- [ ] 목 서버에 "생성 끝 → 확정", "생성 끝만", "확정 없이 닫기" 세 시나리오를 만들어 각각의 UI 결과 확인

---

## 4. 재연결은 켜는 것보다 끄는 것이 맞을 때가 있다

### 문제

폴리필의 자동 재연결이 켜져 있으면, 끊긴 뒤 같은 요청이 다시 나갈 수 있다.

### 개념

- 자동 재연결은 **구독형 스트림**(알림, 시세)에 맞는 기능이다.
- **요청-응답형 스트림**(메시지 하나를 보내고 답을 받음)에서 재연결은 "같은 메시지를 다시 보내는 것"과 같다.
  - 응답이 두 번 생성될 수 있다.

**긴 침묵:** 오래 걸리는 작업(수십 초 이상 아무것도 오지 않는 턴)이 있으면, 하트비트 타임아웃 때문에 정상 연결도 죽은 것으로 처리된다.

### 해결

- **`onerror`에서 즉시 닫아서 재연결을 막는다.** 대신 오류 컨텍스트를 상위로 넘긴다.
  - 컨텍스트에는 "토큰을 받았는가", "확정을 받았는가", 경과 시간, HTTP 상태가 들어간다.
- 상위에서는 **"토큰을 받은 적이 있다면, 서버에 이미 저장됐는지 한 번 확인"**한다. 저장됐으면 오류가 아니라 성공으로 복구한다.
  - 이것으로 네트워크가 끝에서만 끊긴 경우의 **오탐 오류**를 없앴다.
- 하트비트 타임아웃은 **가장 오래 걸리는 턴을 기준으로** 늘렸다.
  - 대가로 진짜 죽은 연결을 늦게 발견한다.
  - 정석은 서버가 주기적으로 주석 하트비트를 보내고, 타임아웃을 짧게 두는 것이다.

### 확인할 실험

- [ ] 재연결을 켠 상태에서 연결을 끊으면 서버에 같은 요청이 다시 도착하는지 확인
- [ ] 토큰을 받는 도중 오프라인 → 서버에는 저장된 상태에서 UI가 성공으로 복구되는지 확인

---

## 5. 낙관적 메시지와 식별자: 텍스트 → 시각 → id

### 문제

사용자 메시지를 바로 그려 두면, 서버 데이터가 들어올 때 **같은 메시지가 두 번 보이거나** 임시 말풍선이 남았다.

### 개념

메시지 하나의 상태 변화:

```
pending ──▶ streaming ──▶ done
   │            │
   └──▶ error ◀─┤
                └──▶ aborted
```

임시 메시지와 서버 행을 **무엇으로 연결하느냐**가 핵심이다.

### 해결

같은 문제를 네 번 다르게 고쳤다.

| 시도 | 기준 | 깨진 경우 |
|---|---|---|
| 1 | 텍스트가 같으면 같은 메시지 | 같은 말을 두 번 보내면 하나가 사라짐, 서버가 공백을 다듬으면 중복 |
| 2 | 클라이언트 id + 텍스트 폴백 | 폴백 경로에서 1과 같은 문제 |
| 3 | 1초 이내 시각 | 네트워크 지연, 시계 차 |
| 4 | **클라이언트 id + "보낸 시점 이후의 서버 행"을 순서대로 하나씩 매칭** | (현재) |

- 4번은 서버가 클라이언트 id를 돌려주지 않아도 동작한다. 원리는 다음과 같다.
  - 보낼 때 "지금까지 본 가장 큰 서버 id"를 기록해 둔다.
  - 그보다 큰 서버 사용자 행을 FIFO로 하나씩 소비한다.
- **"id를 도입하는 것"과 "id만 믿는 것" 사이에 몇 달이 걸렸다.** 폴백이 남아 있는 한 이전 버그도 함께 남는다.

### 확인할 실험

- [ ] 같은 문장 연속 전송, 느린 네트워크, 시계를 틀어 놓은 상태에서 4가지 매칭 방식 비교

---

## 6. 이전 턴의 늦은 이벤트를 막기

### 문제

빠르게 연속 전송하거나, 대화방을 바꾸거나, 취소한 직후에 **이전 스트림의 이벤트가 새 턴의 상태를 덮어썼다**.

### 개념

- 컴포넌트 수준의 ref는 **모든 턴이 공유**한다.
  - 이전 턴의 늦은 `onerror`가 새 턴의 플래그를 읽는다.
- 비동기 준비 단계(토큰 조회 등) 사이에 두 번째 전송이 끼어들 수 있다.
  - "연결 중" 상태를 따로 두지 않으면 막을 수 없다.

### 해결

세 가지를 함께 썼다.

1. **동기 예약**: 첫 `await` 전에 "전송 중" 플래그를 잡는다.
2. **세대 번호**: 닫을 때마다 세대를 1 올린다. 콜백은 자기가 만들어진 세대가 현재 세대일 때만 동작한다.
3. **턴마다 독립 상태**: 플래그를 ref가 아니라 전송 함수 안의 지역 객체로 만들고 클로저로 붙잡는다.

```ts
let generation = 0
let reserving = false
let source: EventSource | null = null

function close() {
  generation++
  reserving = false
  if (source) { source.onmessage = source.onerror = null; source.close() }
  source = null
}

async function send(input: string) {
  if (reserving || source) throw new Error('busy')
  reserving = true                       // await 전에 예약
  const my = ++generation
  const turn = { gotDelta: false, gotFinal: false }   // 턴 전용 상태
  try {
    const headers = await getAuthHeaders()
    if (my !== generation) throw new DOMException('cancelled', 'AbortError')
    const s = new EventSourceWithHeaders(url(input), { headers })
    source = s
    const isCurrent = () => my === generation && source === s
    s.onmessage = (e) => { if (!isCurrent()) return; /* turn 갱신 */ }
    s.onerror = () => { if (!isCurrent()) return; /* ... */ }
  } finally {
    // 토큰 조회가 실패해도 예약을 반드시 푼다.
    // 이미 취소됐다면(세대가 바뀜) close()가 풀었으니 건드리지 않는다.
    if (my === generation) reserving = false
  }
}
```

- **`finally`가 없으면** 토큰 조회가 실패했을 때 `reserving`이 `true`로 남는다. 그러면 이후 모든 전송이 'busy'로 막힌다.
  - 아래의 소켓 시절 문제(실패한 연결 Promise가 비워지지 않음)와 같은 모양이다. "진행 중" 상태를 만들었다면 **실패 경로에서도 반드시 해제**해야 한다.

- 이 경험은 이전에 WebSocket을 쓰던 시절에도 똑같이 있었다.
  - 그때는 "연결됨"만 확인해서 연결 중인 소켓이 있는데도 **소켓을 또 만들었다**.
  - 진행 중인 연결 Promise를 공유하는 single-flight로 고쳤다.
- 문제의 모양은 같다. **"진행 중" 상태를 모델링하지 않으면 중복이 생긴다.**

### 확인할 실험

- [ ] 단위 테스트: 토큰 조회 중 두 번째 send 거부, 취소된 준비 단계가 새 연결을 만들지 못함, 이전 연결에 큐잉된 이벤트 무시, 확정 → 오류 순서일 때 오류 무시, **토큰 조회 실패 후 다음 send가 정상 동작**

---

## 7. 토큰마다 렌더링하면 느려진다

### 문제

delta 하나마다 상태를 바꾸면 초당 수십 번 렌더링된다. 마크다운으로 그리면 매번 전체 텍스트를 다시 파싱한다.

### 개념

- React 18은 업데이트를 바로 렌더링하지 않고 스케줄러에 예약한다. 그래서 delta가 몰려 들어오면 일부는 한 번에 묶일 수도 있다.
  - 하지만 스트림 이벤트는 각각 별도 task로 들어오므로 **묶인다는 보장이 없다.** 최악의 경우 delta마다 렌더링된다.
  - 실제로 몇 번 렌더링되는지는 Profiler로 확인해야 한다.
- **지난 메시지는 `memo`로 막는다.** 다만 모든 행에 공통 prop(예: 오류 여부)을 넘기면, 그 값이 바뀔 때 memo가 무력화된다.
- **key가 바뀌면 리마운트된다.**
  - 임시 id에서 서버 id로 바뀌는 순간 말풍선이 새로 마운트된다.
  - 이미지가 다시 로드되고 애니메이션이 다시 재생된다.

### 해결

실무에서 한 것:

- 스트리밍 중인 말풍선은 별도 필드로 두고, 지난 메시지는 `memo`로 막았다.
  - 다만 같은 상태 저장소 안의 필드라서, delta마다 상위 컴포넌트는 다시 렌더링된다. memo가 나머지 행을 막아 주는 구조다.

남은 과제(회고 참고):

- delta를 rAF로 모으기
- 스트리밍 중에는 평문으로 그리고 확정 후에 마크다운으로 바꾸기
- 임시 id를 렌더 key로 승계하기

```ts
const buf = { text: '', raf: 0 }
function onDelta(t: string) {
  buf.text += t
  if (!buf.raf) buf.raf = requestAnimationFrame(flush)
}
function flush() {
  buf.raf = 0
  const t = buf.text; buf.text = ''
  setStreaming((s) => s + t)
}
function onFinal() {
  cancelAnimationFrame(buf.raf)
  flush()   // 백그라운드 탭에서는 rAF가 멈추니 즉시 flush
}
function onUnmount() {
  cancelAnimationFrame(buf.raf)   // 언마운트 뒤 setState 방지
  buf.raf = 0
  buf.text = ''
}
```

### 확인할 실험

- [ ] React Profiler: 매 토큰 dispatch vs rAF 배칭 vs + 평문 렌더 (렌더 횟수, 커밋 시간)
- [ ] key 승계 전후 "Highlight updates"로 리마운트 확인

---

## 8. 스크롤: 위로 불러오기와 맨 아래 따라가기

### 문제

- 과거 메시지를 위에 붙이면 화면이 튄다.
- 스트리밍 중에 위로 올려 읽고 있는데 아래로 끌려 내려간다.

### 개념

**위로 불러오기**

- 불러오기 전의 `scrollHeight`를 기억해 둔다.
- DOM이 반영된 직후 `scrollTop += 새 높이 − 이전 높이`로 보정한다.
- 보정 시점은 페인트 전인 `useLayoutEffect`가 가장 안전하다.
- 대안으로 `overflow-anchor`와 `column-reverse`가 있다. 브라우저마다 다르게 동작하므로 실험이 필요하다.

**맨 아래 따라가기**

- "언제 내릴지"보다 **"언제 내리지 말지"**가 핵심이다. 바닥 근처에 있을 때만 따라간다.
- 새 메시지가 추가될 때는 smooth로 내린다.
- 같은 메시지가 길어지는 중(delta)에는 즉시 점프한다. delta마다 smooth로 스크롤하면 애니메이션이 계속 처음부터 다시 시작된다.

### 해결

자동 스크롤은 세 번 바뀌었다.

1. 메시지가 바뀔 때마다 무조건 내렸다.
2. key 리마운트 트릭으로 바꿨다. 여전히 무조건 내렸다.
3. **바닥과의 거리를 추적해서, 가까울 때만 내린다.**

이미지가 늦게 로드되며 높이가 늘어나는 경우는 로드 완료 시점에 한 번 더 따라가도록 처리했다.

위로 불러오기는 "promise 완료 → rAF에서 보정"으로 구현했다. 나중에 이 방식의 문제를 알았다(회고 참고).

- 데이터 요청의 promise가 resolve된 시점에, React가 **아직 새 메시지를 DOM에 커밋하지 않았을 수 있다.**
  - 그러면 rAF 안에서 읽는 `scrollHeight`가 **업데이트 전의 높이**라서 보정 값 자체가 틀린다.
  - 커밋이 끝났더라도, 보정 전에 페인트가 한 번 끼면 한 프레임 튀는 게 보인다.
- `useLayoutEffect`는 **DOM 커밋 후, 페인트 전**에 실행된다. 그래서 "새 높이를 정확히 읽는 것"과 "튀기 전에 보정하는 것"을 모두 보장한다.

```ts
const prevHeightRef = useRef<number | null>(null)

async function loadOlder() {
  prevHeightRef.current = el.scrollHeight   // 요청 전 높이 기록
  await fetchOlder()
}

useLayoutEffect(() => {
  if (prevHeightRef.current == null) return
  el.scrollTop += el.scrollHeight - prevHeightRef.current
  prevHeightRef.current = null
}, [messages])   // 메시지가 실제로 반영된 렌더에서 보정
```

### 확인할 실험

- [ ] 보정 시점 비교: promise → rAF vs `useLayoutEffect` (CPU 스로틀링 + Performance 패널)
- [ ] 보정 / `overflow-anchor` / `column-reverse`의 iOS Safari 동작 비교

---

## 9. 작지만 꼭 필요했던 것들

**한글 IME**

- 조합 중에 Enter를 처리하면 마지막 글자가 잘리고 전송된다.
- `e.nativeEvent.isComposing`을 확인한다. 브라우저에 따라 `keyCode === 229`도 함께 확인한다.

**무한 쿼리 동기화 비용**

- 스트림이 끝날 때마다 "전체 다시 불러오기"를 하면 불러온 페이지 수만큼 요청이 한꺼번에 나간다.
- 새 메시지는 항상 첫 페이지에만 생기므로, **첫 페이지만 받아 캐시에 병합**한다.
- 리마운트, 포커스 때의 자동 refetch와 자동 재시도도 꺼서 요청이 몰리지 않게 했다.

**타이머로 순서 문제 덮지 않기**

- "이벤트가 DB 반영보다 먼저 와서" refetch 뒤 몇백 ms 후에 한 번 더 refetch하는 코드가 있었다.
- 결국 "서버에 실제로 반영됐는지 확인하는 reconcile"로 바꿨다.

---

## 10. 회고

### 아직 남은 문제

- **실패하면 사용자가 쓴 글이 사라진다.**
  - 실패 시 임시 메시지를 지우는 롤백 방식이고, 재시도 버튼이 없다.
  - 스트림 오류 때는 임시 메시지가 전부 지워진다.
- **확정될 때 key가 바뀌어 말풍선이 다시 마운트된다.**
- **delta 배칭과 마크다운 재파싱 비용**을 측정하지 않았다.
- **위로 불러오기 보정 시점**이 DOM 커밋 이후라고 보장되지 않는다. 업데이트 전의 높이를 읽을 수 있다.
- **보내기와 받기가 한 요청에 묶여 있다.** 그래서 재시도와 이어 받기를 설계하기 어렵다.
- **세대 번호가 여러 층(전송, 턴, 연결)에 흩어져 있다.**
- 테스트는 있지만 **CI에서 자동으로 돌지 않는다.**
- 이전 방식을 지원하려고 남긴 **폴백 코드**와 **쓰이지 않는 상태 액션**이 있다.

### 다시 만든다면

1. **전송 구조:** POST로 턴 생성 → 턴 id로 스트림 구독. 또는 fetch 스트림 POST + `AbortController`.
2. **종료 계약:** 서버와 이벤트 계약(이벤트 종류, 순서, 종료 신호, 하트비트)을 문서로 먼저 정하고, 목 서버로 그 계약을 테스트한다.
3. **턴 객체 하나:** `{ id, clientId, status, abort }`가 수명 전체(준비 → 스트림 → reconcile)를 소유하게 한다.
4. **식별자:** 서버가 클라이언트 id를 echo하게 한다. 렌더 key는 클라이언트 id로 끝까지 유지한다.
5. **실패 UX:** 메시지에 `failed` 상태를 두고 재시도와 복사를 제공한다.
6. **렌더링:** rAF 배칭, 스트리밍 중 평문 렌더, 확정 후 마크다운.
7. **스크롤:** sentinel + `IntersectionObserver`로 트리거하고, `useLayoutEffect`에서 보정한다.
8. **측정과 테스트:** 기법을 하나씩 추가하며 Profiler로 측정한다. 파서와 생명주기 단위 테스트, 장애 시나리오 E2E를 CI에서 돌린다.
