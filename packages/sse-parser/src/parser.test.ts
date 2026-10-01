import { describe, expect, it } from 'vitest'
import { createSseParser, type SseEvent } from './index'

const encoder = new TextEncoder()

/** 청크(문자열 또는 바이트)를 순서대로 넣고, 스트림을 끝낸 뒤 나온 이벤트를 모은다. */
function parse(chunks: readonly (string | Uint8Array)[]): SseEvent[] {
  const events: SseEvent[] = []
  const parser = createSseParser((event) => events.push(event))
  for (const chunk of chunks) {
    parser.push(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
  }
  parser.end()
  return events
}

/** 기본값을 채운 기대 이벤트 */
function ev(data: string, overrides: Partial<SseEvent> = {}): SseEvent {
  return { event: 'message', data, id: '', retry: undefined, ...overrides }
}

/** 결과를 재현할 수 있도록 seed를 받는 PRNG (mulberry32) */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 바이트 배열을 무작위 위치에서 잘라 청크 목록으로 만든다. 빈 청크도 나올 수 있다. */
function splitRandomly(bytes: Uint8Array, random: () => number): Uint8Array[] {
  const cuts = new Set<number>()
  const count = Math.floor(random() * 12)
  for (let i = 0; i < count; i++) cuts.add(Math.floor(random() * (bytes.length + 1)))
  const sorted = [0, ...[...cuts].sort((a, b) => a - b), bytes.length]
  const chunks: Uint8Array[] = []
  for (let i = 0; i < sorted.length - 1; i++) chunks.push(bytes.slice(sorted[i], sorted[i + 1]))
  return chunks
}

describe('이벤트 경계', () => {
  it('한 이벤트가 여러 청크로 나뉘어 와도 하나로 합친다', () => {
    expect(parse(['da', 'ta: hel', 'lo\n', '\n'])).toEqual([ev('hello')])
  })

  it('한 청크에 여러 이벤트가 있으면 모두 꺼낸다', () => {
    expect(parse(['data: a\n\ndata: b\n\ndata: c\n\n'])).toEqual([ev('a'), ev('b'), ev('c')])
  })

  it('빈 줄로 끝나지 않은 마지막 이벤트는 버린다', () => {
    expect(parse(['data: a\n\ndata: b\n'])).toEqual([ev('a')])
  })

  it('빈 줄이 여러 개 이어져도 빈 이벤트를 만들지 않는다', () => {
    expect(parse(['data: a\n\n\n\ndata: b\n\n'])).toEqual([ev('a'), ev('b')])
  })
})

describe('필드 규칙', () => {
  it('여러 줄의 data는 \\n으로 합친다', () => {
    expect(parse(['data: line1\ndata: line2\ndata: line3\n\n'])).toEqual([
      ev('line1\nline2\nline3'),
    ])
  })

  it('콜론 뒤 공백은 한 칸만 제거한다', () => {
    expect(parse(['data:no-space\n\ndata:  two-spaces\n\n'])).toEqual([
      ev('no-space'),
      ev(' two-spaces'),
    ])
  })

  it('콜론이 없는 data 줄은 빈 문자열 data로 처리한다', () => {
    expect(parse(['data\n\n'])).toEqual([ev('')])
  })

  it('콜론으로 시작하는 주석 줄은 무시한다', () => {
    expect(parse([': ping\n\n', ': keep-alive\ndata: a\n: 중간 주석\n\n'])).toEqual([ev('a')])
  })

  it('event 필드로 이벤트 이름을 정하고, 없으면 message로 둔다', () => {
    expect(parse(['event: token\ndata: a\n\ndata: b\n\n'])).toEqual([
      ev('a', { event: 'token' }),
      ev('b'),
    ])
  })

  it('data 줄이 없는 이벤트는 내보내지 않는다', () => {
    expect(parse(['event: done\n\ndata: a\n\n'])).toEqual([ev('a')])
  })

  it('알 수 없는 필드는 무시한다', () => {
    expect(parse(['foo: bar\ndata: a\n\n'])).toEqual([ev('a')])
  })
})

describe('id 필드', () => {
  it('마지막으로 받은 id를 이후 이벤트에도 유지한다', () => {
    expect(parse(['id: 1\ndata: a\n\ndata: b\n\nid: 2\ndata: c\n\n'])).toEqual([
      ev('a', { id: '1' }),
      ev('b', { id: '1' }),
      ev('c', { id: '2' }),
    ])
  })

  it('data 없는 이벤트의 id도 다음 이벤트에 반영한다', () => {
    expect(parse(['id: 7\n\ndata: a\n\n'])).toEqual([ev('a', { id: '7' })])
  })

  it('값이 빈 id는 id를 초기화한다', () => {
    expect(parse(['id: 1\ndata: a\n\nid\ndata: b\n\n'])).toEqual([
      ev('a', { id: '1' }),
      ev('b', { id: '' }),
    ])
  })

  it('NULL 문자가 들어 있는 id는 무시한다', () => {
    expect(parse(['id: 1\ndata: a\n\nid: 2\u00003\ndata: b\n\n'])).toEqual([
      ev('a', { id: '1' }),
      ev('b', { id: '1' }),
    ])
  })
})

describe('retry 필드', () => {
  it('숫자로만 된 retry 값을 이후 이벤트에도 유지한다', () => {
    expect(parse(['retry: 3000\n\ndata: a\n\nretry: 500\ndata: b\n\n'])).toEqual([
      ev('a', { retry: 3000 }),
      ev('b', { retry: 500 }),
    ])
  })

  it('숫자가 아닌 retry 값은 무시한다', () => {
    expect(parse(['retry: 1000\n\nretry: 10s\ndata: a\n\nretry: -1\ndata: b\n\n'])).toEqual([
      ev('a', { retry: 1000 }),
      ev('b', { retry: 1000 }),
    ])
  })
})

describe('줄바꿈', () => {
  it('\\r\\n과 \\r도 줄바꿈으로 처리한다', () => {
    expect(parse(['data: a\r\n\r\ndata: b\r\rdata: c\n\n'])).toEqual([ev('a'), ev('b'), ev('c')])
  })

  it('청크 끝의 \\r과 다음 청크의 \\n은 줄바꿈 하나(\\r\\n)로 처리한다', () => {
    // \r을 바로 \n으로 바꾸면 빈 줄이 하나 더 생겨 이벤트가 둘로 쪼개진다.
    expect(parse(['data: a\r', '\ndata: b\r\n\r\n'])).toEqual([ev('a\nb')])
  })

  it('청크 끝의 \\r 다음 청크가 \\n이 아니면 \\r 하나를 줄바꿈으로 처리한다', () => {
    expect(parse(['data: a\r', '\rdata: b\n\n'])).toEqual([ev('a'), ev('b')])
  })

  it('줄 끝 \\r\\n + 빈 줄 \\r 조합(\\r\\n\\r)을 이벤트 경계로 처리한다', () => {
    expect(parse(['data: a\r\n\rdata: b\n\n'])).toEqual([ev('a'), ev('b')])
  })

  it('줄 끝 \\n + 빈 줄 \\r\\n 조합(\\n\\r\\n)을 이벤트 경계로 처리한다', () => {
    expect(parse(['data: a\n\r\ndata: b\n\n'])).toEqual([ev('a'), ev('b')])
  })

  it('줄 끝 \\r\\n + 빈 줄 \\n 조합(\\r\\n\\n)을 이벤트 경계로 처리한다', () => {
    expect(parse(['data: a\r\n\ndata: b\n\n'])).toEqual([ev('a'), ev('b')])
  })

  it('스트림이 \\r\\r로 끝나면 마지막 이벤트를 내보낸다', () => {
    // 끝의 \r을 다음 청크용으로 남겨 두므로, end()에서 한 번 더 처리해야 한다.
    expect(parse(['data: a\r\r'])).toEqual([ev('a')])
  })
})

describe('인코딩', () => {
  it('한글 UTF-8 바이트가 청크 경계에서 잘려도 깨지지 않는다', () => {
    const bytes = encoder.encode('data: 안녕하세요\n\n')
    for (let cut = 1; cut < bytes.length; cut++) {
      expect(parse([bytes.slice(0, cut), bytes.slice(cut)])).toEqual([ev('안녕하세요')])
    }
  })

  it('스트림 맨 앞의 BOM을 제거한다', () => {
    expect(parse(['﻿data: a\n\n'])).toEqual([ev('a')])
  })

  it('BOM이 바이트 단위로 쪼개져 와도 제거한다', () => {
    const bytes = encoder.encode('﻿data: a\n\n')
    expect(parse([bytes.slice(0, 1), bytes.slice(1, 2), bytes.slice(2)])).toEqual([ev('a')])
  })
})

describe('무작위 분할', () => {
  // 줄바꿈 혼용, 한글, 이모지(4바이트), 주석, id/retry, BOM이 모두 들어 있는 입력
  const input =
    '﻿retry: 2000\r\n' +
    ': 하트비트\n' +
    'id: 1\r\nevent: token\r\ndata: 안녕\r\n\r\n' +
    'data: 여러\rdata: 줄 데이터\r\r' +
    'id: 2\ndata: emoji 😀 끝\n\r\n' +
    'event: done\r\n\r' +
    'data:  공백 둘\r\n\n' +
    'event: final\ndata: {"text":"확정 응답"}\n\n' +
    'data: 미완성 이벤트\n'

  const expected: SseEvent[] = [
    ev('안녕', { event: 'token', id: '1', retry: 2000 }),
    ev('여러\n줄 데이터', { id: '1', retry: 2000 }),
    ev('emoji 😀 끝', { id: '2', retry: 2000 }),
    ev(' 공백 둘', { id: '2', retry: 2000 }),
    ev('{"text":"확정 응답"}', { event: 'final', id: '2', retry: 2000 }),
  ]

  it('한 번에 넣으면 기대한 이벤트가 나온다', () => {
    expect(parse([input])).toEqual(expected)
  })

  it('무작위 바이트 위치에서 잘라 넣어도 결과가 같다 (seed 고정, 500회)', () => {
    const bytes = encoder.encode(input)
    const random = seededRandom(20261001)
    for (let i = 0; i < 500; i++) {
      const chunks = splitRandomly(bytes, random)
      expect(parse(chunks), `반복 ${i}`).toEqual(expected)
    }
  })

  it('1바이트씩 넣어도 결과가 같다', () => {
    const bytes = encoder.encode(input)
    const chunks = Array.from(bytes, (_, i) => bytes.slice(i, i + 1))
    expect(parse(chunks)).toEqual(expected)
  })
})
