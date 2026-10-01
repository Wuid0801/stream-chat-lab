# stream-chat-lab

> An SSE streaming chat rebuilt from production lessons: explicit stream-end contract, resumable streams, ID-stable optimistic messages, and render batching, verified with fault-injection scenarios and step-by-step benchmarks.

실무에서 SSE 토큰 스트리밍 채팅을 고치며 겪은 문제를 처음부터 다시 풀고, **장애를 주입하는 목 서버**와 **기법을 하나씩 더하는 측정**으로 확인한 저장소다.

## 데모

`docs/media/normal.gif` · `docs/media/resume.gif` · `docs/media/retry.gif` · `docs/media/scroll.gif`

## 문제와 해결

| 문제                                   | 해결                                                   | 확인                                           |
| -------------------------------------- | ------------------------------------------------------ | ---------------------------------------------- |
| 청크가 이벤트·한글 중간에서 잘린다     | 줄바꿈을 통일하는 스트리밍 파서                        | 무작위 바이트 분할 500회 테스트, `chunk-chaos` |
| "끝났다"는 신호가 모호하다             | `final`만 종료 신호, `done`에서 닫지 않음              | `done-only`, `close-after-final`               |
| 재연결이 재전송이 된다                 | 생성과 연결을 분리하고 `Last-Event-ID`로 이어 받기     | `drop-mid-stream`: 턴 생성 요청 1번            |
| 끝에서 끊기면 성공인데 오류가 뜬다     | 서버 상태를 확인해 성공으로 복구                       | `drop-after-saved`                             |
| 낙관적 메시지가 중복되거나 사라진다    | clientId로만 매칭, 확정 후에도 key 유지                | `duplicate-text`, `out-of-order-history`       |
| 이전 턴의 늦은 이벤트가 새 턴을 덮는다 | 턴 객체 하나가 수명 전체를 소유 (동기 예약, 세대 번호) | 컨트롤러 단위 테스트                           |
| 토큰마다 렌더가 무겁다                 | 지난 메시지 memo, 스트리밍 중 평문                     | 평균 렌더 57.0ms → 0.5ms                       |
| 과거 메시지를 불러오면 화면이 튄다     | `useLayoutEffect`에서 위치 보정                        | 튄 실행 50/50 → 0/10                           |

장애 시나리오 13개를 E2E로 확인하고, 서버 쪽 시나리오는 EventSource와 fetch 어댑터 양쪽에서 돌린다. 판단마다 기각한 대안은 [`docs/decisions/`](docs/decisions/)에 있다.

## 결과

CPU 4배 느리게, 메시지 200개, 응답 1,500토큰, 버전마다 10회의 중앙값이다. 전체 표와 조건은 [`docs/results.md`](docs/results.md)에 있다.

| 버전 | 추가한 기법              | 평균 렌더 | Long task 총 | 리마운트 |
| ---- | ------------------------ | --------- | ------------ | -------- |
| v0   | 기준 (토큰마다 렌더)     | 57.0ms    | 36,852ms     | 2        |
| v1   | + 지난 메시지 memo       | 4.1ms     | 191ms        | 2        |
| v2   | + rAF 배칭               | 4.4ms     | 162.5ms      | 2        |
| v3   | + 스트리밍 중 평문       | 0.5ms     | 125.5ms      | 2        |
| v4   | + key를 clientId로 유지  | 0.5ms     | 134.5ms      | 0        |
| v5   | + `useLayoutEffect` 보정 | 0.5ms     | 137ms        | 0        |

- **스크롤 보정**: rAF 방식(v0~v4)은 50회 모두 한 프레임 이상 튀었고, 그중 6회는 보정이 실패했다. `useLayoutEffect`(v5)는 10회 모두 튀지 않았다.
- **rAF 배칭은 효과가 측정되지 않았다.** 토큰이 몰려 오는 조건([`results-proxy-buffering.md`](docs/results-proxy-buffering.md))에서도 마찬가지였다.
- 측정 기기는 한 대다. 방법과 한계는 [decisions/010](docs/decisions/010-benchmark-method.md)에 있다.

## 실행

Node 22.12+, Yarn 1.22.22

```bash
yarn install
yarn dev     # mock-server :8787 + web :5173
yarn test    # 단위 테스트
yarn e2e     # E2E (처음에는 yarn playwright install chromium)
yarn bench   # 측정 → docs/results.md (약 50분)
```

URL로 시나리오, 전송 방식, 비교 버전을 고른다. 쓸 수 있는 값은 [`docs/protocol.md`](docs/protocol.md)에 있다.

```
http://localhost:5173/?scenario=drop-mid-stream&seed=11&transport=fetch
http://localhost:5173/?scenario=http-5xx&seed=11
http://localhost:5173/?v=0
```

## 구조

```
apps/web               React 19 채팅 클라이언트 (Turn 컨트롤러, 어댑터 2종, 비교 버전 v0~v5)
apps/mock-server       Hono 목 서버 (장애 시나리오, 이벤트 버퍼, 1회용 스트림 토큰)
packages/sse-parser    프레임워크와 무관한 SSE 파서
packages/chat-protocol 클라이언트·서버 공유 zod 스키마
packages/bench         Playwright 측정 러너
```

문서: [프로토콜](docs/protocol.md) · [설계 판단](docs/decisions/) · [측정 결과](docs/results.md) · [수동 확인](docs/manual-checklist.md) · [실무에서 배운 것](docs/LEARNING.md)
