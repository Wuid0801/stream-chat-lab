import { describe, expect, it } from 'vitest'
import { createStreamTokenStore } from './stream-tokens'

function setup() {
  let now = 0
  const store = createStreamTokenStore({ ttlMs: 60_000, now: () => now })
  return { store, advance: (ms: number) => (now += ms) }
}

describe('streamToken', () => {
  it('발급한 토큰은 해당 턴에 한 번 쓸 수 있다', () => {
    const { store } = setup()
    const token = store.issue('t1')
    expect(store.consume(token, 't1')).toBe('ok')
  })

  it('한 번 쓴 토큰은 다시 쓸 수 없다', () => {
    const { store } = setup()
    const token = store.issue('t1')
    store.consume(token, 't1')
    expect(store.consume(token, 't1')).toBe('invalid')
  })

  it('다른 턴의 토큰은 거부한다', () => {
    const { store } = setup()
    const token = store.issue('t1')
    expect(store.consume(token, 't2')).toBe('invalid')
  })

  it('만료된 토큰은 거부한다', () => {
    const { store, advance } = setup()
    const token = store.issue('t1')
    advance(60_001)
    expect(store.consume(token, 't1')).toBe('expired')
  })

  it('모르는 토큰은 거부한다', () => {
    const { store } = setup()
    expect(store.consume('nope', 't1')).toBe('invalid')
  })
})
