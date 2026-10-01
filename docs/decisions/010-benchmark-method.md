# 010. 측정 방법: profiling 빌드 + Playwright + CPU 4배 느리게

## 상황

렌더 비교 버전 v0~v3의 비용을 같은 조건에서 여러 번 재고, `yarn bench` 한 번으로 다시 잴 수 있어야 한다(DEMO_SPEC 6장). 두 가지 제약이 있었다.

- React 19의 일반 프로덕션 빌드에서는 `<Profiler onRender>`가 측정값을 주지 않는다.
- 개발 빌드는 StrictMode와 개발용 검사 때문에 실제 비용과 다르다.

## 검토한 대안

| 항목      | 대안                                            | 판단                                                               |
| --------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| 빌드      | 개발 서버                                       | 실제 비용과 다르다                                                 |
|           | **프로덕션 빌드 + `react-dom/profiling` alias** | Profiler 측정값을 주면서 나머지는 프로덕션과 같다                  |
| 수집      | React DevTools Profiler 수동 기록               | 반복과 재현이 어렵다                                               |
|           | **앱 안의 수집기(`?bench=1`) + Playwright**     | 자동 반복이 된다. 측정 모드가 아니면 수집기는 아무것도 하지 않는다 |
| 서버 상태 | 한 서버로 계속 측정                             | 이전 실행의 1,500토큰 응답이 히스토리 200개에 섞여 조건이 바뀐다   |
|           | **실행마다 목 서버를 새로 띄움**                | 매번 같은 히스토리로 시작한다                                      |
| 실행 순서 | 버전별로 몰아서 실행                            | 시간에 따른 발열·백그라운드 작업 변화가 한 버전에 몰린다           |
|           | **버전을 번갈아 실행**                          | 변화가 버전들에 고르게 퍼진다                                      |

## 결정

- `vite build --mode bench`가 `react-dom/client`를 `react-dom/profiling`으로 바꾼다.
- `apps/web/src/bench/probe.ts`가 다음을 `window.__bench`에 모은다.
  - Profiler `onRender`
  - `MessageItem` 마운트 수
  - `longtask`
  - Event Timing(`event`, `durationThreshold: 16`)
- `packages/bench`가 한 번의 실행마다 다음을 한다.
  1. 목 서버 기동 (`SEED_MESSAGES=200`)
  2. 새 브라우저 컨텍스트
  3. CDP로 CPU 4배 느리게 (`Emulation.setCPUThrottlingRate`)
  4. 메시지 200개 로드
  5. 전송
  6. 스트리밍 중 1초마다 한 글자 입력
  7. 완료 후 수집
- 집계는 전송 이후의 기록만 쓴다. 버전마다 10회 실행해서 중앙값과 p90을 적는다.
- 공식 조건(10회, 버전 4개 모두)일 때만 `docs/results.md`와 `docs/results-raw.json`을 쓴다. 빠른 확인 실행의 값이 결과 문서에 섞이지 않게 하기 위해서다.

## 한계

- **headless Chromium 한 종류, 한 기기**에서만 쟀다. 다른 브라우저나 실제 저사양 기기의 값이 아니다. CPU 스로틀링은 저사양 기기를 흉내 낼 뿐이다.
- `actualDuration`은 렌더(컴포넌트 함수 실행) 시간이다. DOM 반영, 레이아웃, 페인트 비용은 포함하지 않는다. 그 비용은 Long task와 INP에 간접적으로 드러난다.
- INP는 Playwright가 만든 합성 입력으로 쟀다. 실제 사용자 입력과 시점 분포가 다르다.
- Event Timing은 16ms 미만을 기록하지 않는다. 그래서 그보다 짧은 상호작용은 `<16`으로만 적는다.
- 측정 중에 같은 PC에서 다른 작업이 돌았다면 값이 흔들린다. p90을 함께 적어 흔들림을 드러낸다.
