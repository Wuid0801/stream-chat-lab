import { pick, seededRandom } from './random'

const SENTENCES = [
  '좋은 질문이에요.',
  '먼저 전체 흐름을 짧게 정리해 볼게요.',
  '핵심은 데이터를 어디에서 한 번만 바꾸느냐입니다.',
  '예를 들어 목록을 불러온 뒤 화면에 그리기 전에 정렬해 두면 됩니다.',
  '이 방법은 간단하지만 항목이 많아지면 비용이 커질 수 있어요.',
  '그럴 때는 필요한 부분만 다시 계산하도록 나누는 편이 낫습니다.',
  '테스트를 먼저 작성해 두면 바꾼 뒤에도 동작을 확인하기 쉽습니다.',
  'Here is a short example in plain English as well.',
  '- 첫째, 입력을 검증합니다.\n- 둘째, 결과를 저장합니다.\n- 셋째, 화면을 갱신합니다.',
  '`const total = items.reduce((sum, item) => sum + item.price, 0)`',
  '**정리하면**, 한 번에 하나씩 바꾸고 결과를 확인하는 것이 가장 안전합니다.',
] as const

export interface Reply {
  tokens: string[]
  /** 토큰 사이 간격 */
  intervalMs: number
}

export interface ReplyOptions {
  /** 응답 토큰 수. 없으면 seed로 3~6문장을 고른다. */
  tokens?: number
  /** 초당 토큰 수. 없으면 seed로 20~60 사이에서 정한다. */
  tokensPerSecond?: number
}

/** 실제 모델처럼 단어 조각 단위로 자른다. 이어 붙이면 원문과 같다. */
const toTokens = (text: string) => text.match(/\s*\S{1,3}/g) ?? []

/** seed가 같으면 같은 응답(토큰 분할과 속도 포함)을 만든다. */
export function generateReply(seed: number, options: ReplyOptions = {}): Reply {
  const random = seededRandom(seed)
  let tokens: string[]
  if (options.tokens === undefined) {
    const count = 3 + Math.floor(random() * 4)
    tokens = toTokens(Array.from({ length: count }, () => pick(random, SENTENCES)).join(' '))
  } else {
    // 측정용: 정해진 토큰 수가 될 때까지 문장을 이어 붙인 뒤 자른다.
    const text: string[] = []
    tokens = []
    while (tokens.length < options.tokens) {
      text.push(pick(random, SENTENCES))
      tokens = toTokens(text.join(' '))
    }
    tokens = tokens.slice(0, options.tokens)
  }
  const tokensPerSecond = options.tokensPerSecond ?? 20 + random() * 40
  return { tokens, intervalMs: 1000 / tokensPerSecond }
}

/** 시작 시 채워 둘 지난 대화 */
export function seedConversation(
  seed: number,
  count: number,
): { role: 'user' | 'assistant'; text: string }[] {
  const random = seededRandom(seed)
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: i % 2 === 0 ? `질문 ${i / 2 + 1}: ${pick(random, SENTENCES)}` : pick(random, SENTENCES),
  }))
}
