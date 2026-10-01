/**
 * 렌더 비용 비교 버전. 버전이 오를 때마다 기법을 하나씩 더한다. (DEMO_SPEC 6장, docs/decisions/009)
 *
 * - v0: 토큰마다 dispatch, 모든 메시지 마크다운, memo 없음
 * - v1: + 지난 메시지 memo
 * - v2: + rAF 배칭
 * - v3: + 스트리밍 중 평문, final에 마크다운
 */
export interface RenderVariant {
  version: 0 | 1 | 2 | 3
  memoPast: boolean
  rafBatch: boolean
  plainWhileStreaming: boolean
}

const VARIANTS: readonly RenderVariant[] = [
  { version: 0, memoPast: false, rafBatch: false, plainWhileStreaming: false },
  { version: 1, memoPast: true, rafBatch: false, plainWhileStreaming: false },
  { version: 2, memoPast: true, rafBatch: true, plainWhileStreaming: false },
  { version: 3, memoPast: true, rafBatch: true, plainWhileStreaming: true },
]

const LATEST = VARIANTS[VARIANTS.length - 1] as RenderVariant

/** `?v=` 값을 해석한다. 없거나 잘못되면 최신 버전을 쓴다. */
export function parseVariant(param: string | null): RenderVariant {
  if (param === null || !/^\d+$/.test(param)) return LATEST
  return VARIANTS[Number(param)] ?? LATEST
}
