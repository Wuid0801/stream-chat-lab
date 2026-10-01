# stream-chat-lab

SSE 토큰 스트리밍 채팅에서 끊김, 오탐, 중복, 렌더 비용을 다루는 실험 저장소.

> 작성 예정: 프로필 README에서 연결할 한 줄 소개

## 데모

작성 예정 — 정상 / 연결 끊김 후 이어 받기 / 실패 → 재시도 / 스크롤 유지

## 문제

작성 예정 — 종료 계약, 재연결 = 재전송, 낙관적 메시지 중복, 이전 턴 오염, 토큰마다 렌더, 스크롤 튐

## 설계 판단

작성 예정 — 각 판단과 기각한 대안은 [`docs/decisions/`](docs/decisions/)에 기록한다.

## 결과

작성 예정 — 측정값은 `docs/results.md`에 기록한 실제 값만 옮긴다.

## 실행 방법

요구 사항: Node 22.12+, Yarn 1.22.22

```bash
yarn install
yarn dev         # mock-server(8787) + web(5173)
yarn lint        # ESLint + Prettier 검사
yarn typecheck   # tsc -b
yarn test        # Vitest 단위 테스트
yarn e2e         # Playwright E2E (mock-server와 web을 함께 띄운다)
yarn bench       # 렌더 비용 측정 → docs/results.md (약 30~40분)
```

E2E를 처음 실행할 때는 브라우저를 설치한다: `yarn playwright install chromium`

장애 시나리오는 URL로 고른다. 같은 `seed`는 같은 응답을 만든다.

```
http://localhost:5173/?scenario=normal&seed=11
http://localhost:5173/?scenario=done-only&seed=11
http://localhost:5173/?scenario=close-after-final&seed=11
http://localhost:5173/?scenario=drop-after-saved&seed=11
```

시나리오별 서버 동작과 기대 결과는 [`docs/protocol.md`](docs/protocol.md)에 있다.

렌더 비교 버전은 `?v=0`~`?v=3`으로 고른다. 기본값은 v3다. 버전별 기법은 [`docs/decisions/009`](docs/decisions/009-render-variants.md), 측정 방법은 [`docs/decisions/010`](docs/decisions/010-benchmark-method.md)에 있다. 빠르게 확인할 때는 `yarn bench --runs 1 --variants 0,3`을 쓴다. 이때는 결과를 출력만 하고 파일은 쓰지 않는다.

## 구조

```
apps/web               React 19 + Vite 채팅 클라이언트
apps/mock-server       Hono 목 서버, 장애 시나리오
packages/sse-parser    프레임워크와 무관한 SSE 스트리밍 파서
packages/chat-protocol 이벤트 타입과 zod 스키마 (클라이언트·서버 공유)
```
