/**
 * 측정 모드(`?bench=1`)에서만 동작하는 수집기. packages/bench가 window.__bench를 읽는다.
 * 측정 모드가 아니면 bench는 null이고 아무것도 기록하지 않는다.
 */
export interface BenchData {
  /** Profiler onRender 기록 (MessageList 하위) */
  commits: { actualDuration: number; commitTime: number }[]
  /** MessageItem 마운트 횟수 */
  mounts: number
  longTasks: { startTime: number; duration: number }[]
  /** Event Timing 항목. interactionId가 0이면 상호작용이 아니다. */
  events: { name: string; interactionId: number; startTime: number; duration: number }[]
  /** 전송 시각(performance.now) */
  sentAt: number | null
}

declare global {
  interface Window {
    __bench?: BenchData
  }
  // Event Timing 표준 옵션이지만 TypeScript 6.0의 lib.dom에 아직 없다.
  interface PerformanceObserverInit {
    durationThreshold?: number
  }
}

function create(): BenchData | null {
  if (typeof window === 'undefined') return null
  if (!new URLSearchParams(window.location.search).has('bench')) return null
  const data: BenchData = { commits: [], mounts: 0, longTasks: [], events: [], sentAt: null }
  window.__bench = data

  new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      data.longTasks.push({ startTime: e.startTime, duration: e.duration })
  }).observe({ type: 'longtask', buffered: true })

  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as PerformanceEventTiming[]) {
      data.events.push({
        name: e.name,
        interactionId: e.interactionId,
        startTime: e.startTime,
        duration: e.duration,
      })
    }
    // Event Timing이 기록하는 최소값이 16ms다. 그보다 짧은 상호작용은 기록되지 않는다.
  }).observe({ type: 'event', durationThreshold: 16, buffered: true })

  return data
}

export const bench = create()

export function recordCommit(
  _id: string,
  _phase: string,
  actualDuration: number,
  _baseDuration: number,
  _startTime: number,
  commitTime: number,
): void {
  bench?.commits.push({ actualDuration, commitTime })
}
