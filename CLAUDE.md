# stream-chat-lab — 작업 규칙

SSE 토큰 스트리밍 채팅의 문제(종료 계약, 재연결, 낙관적 메시지 매칭, 턴 격리, 렌더 비용, 스크롤)를
처음부터 다시 구현하고, 장애 시나리오와 측정으로 증명하는 **공개 포트폴리오 저장소**다.

## 기준 문서

- `docs/DEMO_SPEC.md`: 구조, 기능, 장애 시나리오, 테스트, 측정 계획
- `docs/LEARNING.md`: 각 장의 "개념"과 "다시 만든다면"이 구현 기준이다
- 아래 "확정된 결정"이 DEMO_SPEC과 다르면 **아래를 따른다.**

## 확정된 결정 (DEMO_SPEC보다 우선)

1. web: **React 19 + Vite + TypeScript**. Next.js는 쓰지 않는다.
2. mock-server: **Hono (Node)**.
3. 스트림 구독 인증
   - `POST /turns`: `Authorization: Bearer <demo-token>` → `{ turnId, streamToken }`
   - `streamToken`: 짧게 만료(예: 60초)되는 1회용 토큰
   - `GET /turns/:id/stream?token=<streamToken>`으로 구독 (네이티브 EventSource는 헤더를 못 넣음)
   - fetch 스트림 어댑터는 같은 엔드포인트를 헤더 인증으로도 받는다
   - 결정과 트레이드오프(URL에 토큰 노출, 대신 짧은 만료 + 1회용)는 `docs/protocol.md`에 적는다
4. IME 검증은 E2E가 아니라 **키 핸들러 단위 테스트 + `docs/manual-checklist.md` 수동 체크**로 한다.
5. **마일스톤(M1~M4) 순서대로** 만든다. 마일스톤이 끝나면 멈추고 보고한다. 다음 마일스톤은 승인 후 시작한다.

## 절대 규칙

- **공개 저장소다.** 특정 회사·서비스·제품 이름이나 도메인 용어를 쓰지 않는다. 예시 데이터는 일반적인 내용으로 만든다.
- **측정하지 않은 수치를 쓰지 않는다.** `docs/results.md`의 칸은 실제 측정 후에만 채운다.
- TypeScript `strict: true`. `any` 금지. 꼭 필요하면 이유를 주석으로 남긴다.
- **테스트 먼저.** 특히 파서, 턴 생명주기, 메시지 매칭은 테스트를 먼저 쓰고 구현한다.
- 커밋은 작게, Conventional Commits(`feat:`, `test:`, `docs:`, `chore:`, `ci:`). Co-Authored-By 등 Claude trailer는 넣지 않는다.
- 새 설계 판단은 `docs/decisions/NNN-제목.md`에 남긴다. 형식: 상황 / 검토한 대안 / 결정 / 트레이드오프.
- 문서와 주석은 한국어, 코드 식별자는 영어.
- 확실하지 않은 라이브러리 API는 추측하지 말고 **설치된 버전의 타입 정의나 문서를 확인**한다.

## 구현 기준 요약 (LEARNING.md에서)

- 파서(2장): 줄바꿈을 `\n`으로 통일, 청크 끝의 `\r`은 남겨 둠, 스트림 끝에 남은 내용을 한 번 더 처리,
  BOM 제거, data 없는 이벤트는 dispatch하지 않음, 빈 줄로 끝나지 않은 마지막 조각은 버림.
- 종료 계약(3장): **`final`만 종료 신호.** `final` 이후의 `onerror`는 무시.
- 재연결(4장): 요청-응답형 스트림에서 재연결 = 재전송이 되지 않게 한다. 토큰을 받은 뒤 끊기면 서버 상태를 확인해 오탐을 복구한다.
- 턴 격리(6장): 동기 예약 + 세대 번호 + 턴 전용 상태. **실패 경로에서도 예약을 반드시 푼다.**
- 렌더(7장): rAF 배칭(final에서 즉시 flush, 언마운트 시 정리), 스트리밍 중 평문 → final에 마크다운, 렌더 key는 clientId.
- 스크롤(8장): 바닥 근처일 때만 따라감, 위로 불러오기 보정은 `useLayoutEffect`.

## 명령

- `pnpm lint && pnpm typecheck && pnpm test` — 마일스톤 완료 기준의 기본
