import { describe, expect, it } from 'vitest'
import { inp, median, p90, summarizeRun, type RawRun } from './stats'

describe('median / p90', () => {
  it('홀수 개의 중앙값', () => {
    expect(median([5, 1, 3])).toBe(3)
  })

  it('짝수 개의 중앙값은 가운데 두 값의 평균', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })

  it('p90은 nearest-rank 방식', () => {
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9)
    expect(p90([7])).toBe(7)
  })
})

describe('inp', () => {
  it('interactionId별로 가장 긴 이벤트를 상호작용 시간으로 보고, 그중 최댓값을 쓴다 (50개 미만)', () => {
    expect(
      inp([
        { interactionId: 1, duration: 24 },
        { interactionId: 1, duration: 40 },
        { interactionId: 2, duration: 32 },
      ]),
    ).toBe(40)
  })

  it('상호작용이 50개 이상이면 50개마다 가장 나쁜 값 하나를 뺀다', () => {
    const events = Array.from({ length: 100 }, (_, i) => ({
      interactionId: i + 1,
      duration: i + 1,
    }))
    expect(inp(events)).toBe(98)
  })

  it('interactionId가 0인 이벤트(상호작용 아님)는 무시한다', () => {
    expect(inp([{ interactionId: 0, duration: 500 }])).toBeNull()
  })
})

describe('summarizeRun', () => {
  const raw: RawRun = {
    sentAt: 1000,
    mountsAtSend: 200,
    mounts: 204,
    commits: [
      { actualDuration: 50, commitTime: 900 },
      { actualDuration: 2, commitTime: 1100 },
      { actualDuration: 6, commitTime: 1200 },
    ],
    longTasks: [
      { startTime: 800, duration: 300 },
      { startTime: 1300, duration: 70 },
      { startTime: 1500, duration: 60 },
    ],
    events: [
      { name: 'keydown', interactionId: 0, startTime: 500, duration: 999 },
      { name: 'keydown', interactionId: 5, startTime: 1400, duration: 48 },
    ],
  }

  it('전송 이후의 기록만 센다', () => {
    expect(summarizeRun(raw)).toEqual({
      commits: 2,
      meanRenderMs: 4,
      maxRenderMs: 6,
      longTaskTotalMs: 130,
      inpMs: 48,
      remounts: 2,
    })
  })
})
