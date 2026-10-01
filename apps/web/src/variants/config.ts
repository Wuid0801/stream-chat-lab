/**
 * 렌더 비용 비교 버전. 버전이 오를 때마다 기법을 하나씩 더한다. (DEMO_SPEC 6장, docs/decisions/009)
 *
 * - v0: 토큰마다 dispatch, 모든 메시지 마크다운, memo 없음, key = 서버 id
 * - v1: + 지난 메시지 memo
 * - v2: + rAF 배칭
 * - v3: + 스트리밍 중 평문, final에 마크다운
 * - v4: + 렌더 key를 clientId로 유지 (docs/decisions/014)
 * - v5: + 위로 불러오기의 스크롤 보정을 useLayoutEffect로 (docs/decisions/015)
 */
export interface RenderVariant {
  version: 0 | 1 | 2 | 3 | 4 | 5
  memoPast: boolean
  rafBatch: boolean
  plainWhileStreaming: boolean
  stableKey: boolean
  layoutScrollCorrection: boolean
}

const NONE = {
  memoPast: false,
  rafBatch: false,
  plainWhileStreaming: false,
  stableKey: false,
  layoutScrollCorrection: false,
}

const VARIANTS: readonly RenderVariant[] = [
  { version: 0, ...NONE },
  { version: 1, ...NONE, memoPast: true },
  { version: 2, ...NONE, memoPast: true, rafBatch: true },
  { version: 3, ...NONE, memoPast: true, rafBatch: true, plainWhileStreaming: true },
  {
    version: 4,
    ...NONE,
    memoPast: true,
    rafBatch: true,
    plainWhileStreaming: true,
    stableKey: true,
  },
  {
    version: 5,
    memoPast: true,
    rafBatch: true,
    plainWhileStreaming: true,
    stableKey: true,
    layoutScrollCorrection: true,
  },
]

const LATEST = VARIANTS[VARIANTS.length - 1] as RenderVariant

/** `?v=` 값을 해석한다. 없거나 잘못되면 최신 버전을 쓴다. */
export function parseVariant(param: string | null): RenderVariant {
  if (param === null || !/^\d+$/.test(param)) return LATEST
  return VARIANTS[Number(param)] ?? LATEST
}
