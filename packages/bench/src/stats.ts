/** 브라우저의 window.__bench에서 읽어 온 한 번의 실행 기록 (apps/web/src/bench/probe.ts) */
export interface RawRun {
  sentAt: number
  mountsAtSend: number
  mounts: number
  commits: { actualDuration: number; commitTime: number }[]
  longTasks: { startTime: number; duration: number }[]
  events: { name: string; interactionId: number; startTime: number; duration: number }[]
}

export interface RunSummary {
  /** 전송 이후 MessageList 하위의 React 커밋 수 */
  commits: number
  /** Profiler actualDuration 평균/최대 */
  meanRenderMs: number
  maxRenderMs: number
  longTaskTotalMs: number
  /** 기록된 상호작용이 없으면(모두 16ms 미만) null */
  inpMs: number | null
  /** 전송 이후 마운트 수 − 새로 생긴 메시지 수(사용자 메시지, 응답 = 2) */
  remounts: number
}

/** 한 턴에 새로 생기는 메시지: 사용자 메시지 1 + 응답 1 */
const NEW_MESSAGES_PER_TURN = 2

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] ?? NaN
  return ((sorted[mid - 1] ?? NaN) + (sorted[mid] ?? NaN)) / 2
}

/** nearest-rank 방식 */
export function p90(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * 0.9) - 1] ?? NaN
}

/**
 * INP 계산. 상호작용(interactionId)마다 가장 긴 이벤트 시간을 그 상호작용의 시간으로 본다.
 * 상호작용 50개마다 가장 나쁜 값 하나를 빼고 남은 최댓값을 쓴다(50개 미만이면 최댓값).
 */
export function inp(events: { interactionId: number; duration: number }[]): number | null {
  const byInteraction = new Map<number, number>()
  for (const e of events) {
    if (e.interactionId === 0) continue
    byInteraction.set(
      e.interactionId,
      Math.max(byInteraction.get(e.interactionId) ?? 0, e.duration),
    )
  }
  const worstFirst = [...byInteraction.values()].sort((a, b) => b - a)
  return worstFirst[Math.floor(worstFirst.length / 50)] ?? null
}

/** 전송 이후의 기록만으로 한 번의 실행을 요약한다. */
export function summarizeRun(raw: RawRun): RunSummary {
  const commits = raw.commits.filter((c) => c.commitTime >= raw.sentAt).map((c) => c.actualDuration)
  return {
    commits: commits.length,
    meanRenderMs: commits.length ? sum(commits) / commits.length : 0,
    maxRenderMs: commits.length ? Math.max(...commits) : 0,
    longTaskTotalMs: sum(
      raw.longTasks.filter((t) => t.startTime >= raw.sentAt).map((t) => t.duration),
    ),
    inpMs: inp(raw.events.filter((e) => e.startTime >= raw.sentAt)),
    remounts: raw.mounts - raw.mountsAtSend - NEW_MESSAGES_PER_TURN,
  }
}
