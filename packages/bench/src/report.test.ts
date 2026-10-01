import { describe, expect, it } from 'vitest'
import { renderReport, type Conditions } from './report'
import type { RunSummary } from './stats'

const conditions: Conditions = {
  date: '2026-10-01',
  commit: 'abc1234',
  cpu: 'Test CPU x8',
  memoryGb: 16,
  os: 'TestOS 1.0',
  browser: 'Chromium 1.0',
  playwright: '1.0.0',
  cpuThrottle: 4,
  runsPerVariant: 2,
  historyMessages: 200,
  replyTokens: 1500,
  tokensPerSecond: 40,
  seed: 11,
  viewport: '1280x720',
  build: 'vite build --mode bench',
}

const run = (overrides: Partial<RunSummary> = {}): RunSummary => ({
  commits: 10,
  meanRenderMs: 1,
  maxRenderMs: 2,
  longTaskTotalMs: 100,
  inpMs: 40,
  remounts: 2,
  ...overrides,
})

describe('renderReport', () => {
  const md = renderReport(conditions, [
    { version: 0, runs: [run({ commits: 10 }), run({ commits: 20 })] },
    { version: 3, runs: [run({ inpMs: null }), run({ inpMs: null })] },
  ])

  it('측정 조건을 적는다', () => {
    expect(md).toContain('Test CPU x8')
    expect(md).toContain('Chromium 1.0')
    expect(md).toContain('CPU 4×')
    expect(md).toContain('abc1234')
  })

  it('버전마다 중앙값과 p90을 적는다', () => {
    expect(md).toMatch(/\| v0 \| 15 \/ 20 \|/)
  })

  it('INP가 기록되지 않았으면(16ms 미만) 숫자를 지어내지 않고 <16으로 적는다', () => {
    expect(md).toMatch(/\| v3 \|.*\| <16 \/ <16 \|/)
  })

  it('측정하지 않은 위치 오차 칸은 비워 둔다', () => {
    expect(md).toMatch(/\| v0 \|.*\| — \|$/m)
  })
})
