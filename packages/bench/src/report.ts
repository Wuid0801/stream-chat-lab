import { median, p90, type RunSummary, type ScrollSummary } from './stats'

export interface Conditions {
  date: string
  commit: string
  cpu: string
  memoryGb: number
  os: string
  browser: string
  playwright: string
  cpuThrottle: number
  runsPerVariant: number
  historyMessages: number
  replyTokens: number
  tokensPerSecond: number
  seed: number
  viewport: string
  build: string
}

export interface VariantResult {
  version: number
  runs: (RunSummary & ScrollSummary)[]
}

const VARIANT_LABELS: Record<number, string> = {
  0: '토큰마다 dispatch, 모든 메시지 마크다운, memo 없음',
  1: '+ 지난 메시지 memo',
  2: '+ rAF 배칭',
  3: '+ 스트리밍 중 평문, final에 마크다운',
  4: '+ 렌더 key를 clientId로 유지',
  5: '+ 위로 불러오기 보정을 useLayoutEffect로 (v0~v4는 요청 완료 후 rAF에서 보정)',
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

function cell(values: number[]): string {
  return `${fmt(median(values))} / ${fmt(p90(values))}`
}

/** INP가 기록되지 않은 실행은 0으로 두고, 16ms 미만은 숫자 대신 <16으로 적는다. */
function inpCell(values: (number | null)[]): string {
  const nums = values.map((v) => v ?? 0)
  const show = (n: number) => (n < 16 ? '<16' : fmt(n))
  return `${show(median(nums))} / ${show(p90(nums))}`
}

export function renderReport(conditions: Conditions, results: VariantResult[]): string {
  const rows = results.map(({ version, runs }) =>
    [
      `v${version}`,
      cell(runs.map((r) => r.commits)),
      cell(runs.map((r) => r.meanRenderMs)),
      cell(runs.map((r) => r.maxRenderMs)),
      cell(runs.map((r) => r.longTaskTotalMs)),
      inpCell(runs.map((r) => r.inpMs)),
      cell(runs.map((r) => r.remounts)),
      cell(runs.map((r) => r.positionErrorPx)),
      cell(runs.map((r) => r.jumpedFrames)),
    ].join(' | '),
  )

  return `# 측정 결과

> 이 파일은 \`yarn bench\`가 생성한다. 손으로 고치지 않는다.

## 결과

각 칸은 **중앙값 / p90** (버전마다 ${conditions.runsPerVariant}회 실행).

| 버전 | 커밋 수/턴 | 평균 렌더(ms) | 최대 렌더(ms) | Long task 총(ms) | INP(ms) | 리마운트 | 위치 오차(px) | 튄 프레임 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.map((r) => `| ${r} |`).join('\n')}

${results.map(({ version }) => `- v${version}: ${VARIANT_LABELS[version] ?? ''}`).join('\n')}

### 지표 정의

- **커밋 수/턴**: 전송 이후 \`<Profiler id="messages">\`(MessageList 하위)의 \`onRender\` 호출 수. 입력창 타이핑은 MessageList를 렌더하지 않아 포함되지 않는다.
- **평균·최대 렌더**: 같은 \`onRender\`의 \`actualDuration\`. DOM 반영(commit) 시간은 포함하지 않는다.
- **Long task 총**: 전송 이후 시작한 \`longtask\` 항목의 duration 합.
- **INP**: 스트리밍 중 1초마다 입력창에 한 글자를 입력한다. Event Timing 항목을 \`interactionId\`로 묶어 상호작용마다 가장 긴 값을 쓰고, 50개마다 가장 나쁜 값 하나를 뺀 최댓값을 적는다. Event Timing은 16ms 미만을 기록하지 않으므로 그보다 짧으면 \`<16\`으로 적는다.
- **리마운트**: 전송 이후 \`MessageItem\` 마운트 수 − 새로 생긴 메시지 수(2). key가 바뀌어 다시 마운트된 횟수다.
- **위치 오차**: 턴이 끝난 뒤 맨 위로 올려 과거 메시지 50개를 불러온다. 올린 순간 화면 맨 위에 보이던 메시지의 위치(목록 위쪽 기준)와, 불러오기와 보정이 끝난 뒤 같은 메시지의 위치 차이.
- **튄 프레임**: 불러오기 중과 반영 후 10프레임 동안 매 프레임(rAF) 같은 메시지의 위치를 샘플링해, 처음 위치에서 1px 넘게 벗어난 프레임 수. 보정 전에 화면에 그려진 프레임이다.
- 브라우저의 스크롤 앵커링은 끈다(\`overflow-anchor: none\`). 보정 방식만 비교하기 위해서다.

## 측정 조건

| 항목 | 값 |
| --- | --- |
| 날짜 | ${conditions.date} |
| 커밋 | \`${conditions.commit}\` |
| CPU | ${conditions.cpu} |
| 메모리 | ${conditions.memoryGb}GB |
| OS | ${conditions.os} |
| 브라우저 | ${conditions.browser} (Playwright ${conditions.playwright}, headless) |
| 스로틀링 | CPU ${conditions.cpuThrottle}× (CDP \`Emulation.setCPUThrottlingRate\`) |
| 빌드 | \`${conditions.build}\` (profiling 빌드의 react-dom) |
| 뷰포트 | ${conditions.viewport} |
| 대화 | 지난 메시지 ${conditions.historyMessages}개 |
| 응답 | ${conditions.replyTokens} 토큰, ${conditions.tokensPerSecond} tokens/s, \`normal\` 시나리오, seed ${conditions.seed} |
| 반복 | 버전마다 ${conditions.runsPerVariant}회, 버전을 번갈아 실행, 실행마다 목 서버를 새로 띄움 |
`
}
