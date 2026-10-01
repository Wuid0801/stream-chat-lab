# 001. 모노레포 도구 선택

## 상황

DEMO_SPEC은 pnpm 모노레포를 전제로 했다. 앱 2개(web, mock-server)와 패키지 2개(sse-parser, chat-protocol)를 한 저장소에서 관리하고, 로컬과 CI에서 같은 명령으로 lint / typecheck / test를 돌려야 한다.

## 검토한 대안

| 항목          | 대안                     | 판단                                                                                                                |
| ------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 패키지 매니저 | pnpm 10                  | 선언하지 않은 의존성을 import하면 실패하므로 패키지 경계를 도구가 강제한다. 실무 환경과 다르다.                     |
|               | **Yarn 1.22.22**         | 실무에서 쓰는 도구와 버전이 같다. 1.22.22는 Yarn classic의 마지막 릴리스다. hoisting 때문에 경계를 강제하지 못한다. |
|               | Yarn 4 (Berry)           | PnP로 경계를 강제하지만 실무 도구와 사실상 다르고, Vite·Vitest·에디터용 SDK 설정이 늘어난다.                        |
| TypeScript    | 7.0 (최신)               | typescript-eslint 8.71의 peer 범위(`>=4.8.4 <6.1.0`) 밖이다.                                                        |
|               | **6.0.x**                | typescript-eslint와 호환된다.                                                                                       |
| 패키지 참조   | 빌드 산출물(`dist`) 참조 | 패키지마다 빌드 단계가 생긴다.                                                                                      |
|               | **소스 직접 참조**       | `exports`가 `src/index.ts`를 가리키고, 소비하는 쪽(Vite, tsx, Vitest)이 TS를 그대로 처리한다.                       |

## 결정

- 패키지 매니저는 **Yarn 1.22.22** (`packageManager` 필드에 고정). 이유는 실무 환경과의 일치다.
- TypeScript는 **6.0.x**. 루트 `tsconfig.json`은 각 패키지를 `references`로 묶는 solution 파일이고, 각 프로젝트는 `noEmit`으로 타입 검사만 한다(`tsc -b`).
- 내부 패키지는 빌드 없이 소스를 직접 참조한다.
- Vitest 설정은 루트 하나로 시작한다. 브라우저 환경(jsdom)이 필요한 web 테스트가 생기는 M2에서 projects로 나눈다.

## 트레이드오프

- Yarn 1은 hoisting 때문에 **선언하지 않은 의존성을 import해도 동작한다.** 경계가 깨져도 로컬에서는 드러나지 않는다. 문제가 실제로 생기면 ESLint `no-extraneous-dependencies` 규칙을 추가한다.
- Yarn 1은 `workspace:*` 프로토콜이 없다. 내부 패키지는 `"*"` 버전 범위로 참조한다.
- Yarn 1은 유지보수만 되는 상태다. 새 프로젝트에 classic을 쓴 이유를 설명해야 할 수 있다.
