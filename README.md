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
yarn lint        # ESLint + Prettier 검사
yarn typecheck   # tsc -b
yarn test        # Vitest
```

`yarn dev`, `?scenario=`, `?v=` 사용법은 작성 예정.

## 구조

```
apps/web               React 19 + Vite 채팅 클라이언트 (M2)
apps/mock-server       Hono 목 서버, 장애 시나리오 (M2)
packages/sse-parser    프레임워크와 무관한 SSE 스트리밍 파서
packages/chat-protocol 이벤트 타입과 스키마 (M2)
```
