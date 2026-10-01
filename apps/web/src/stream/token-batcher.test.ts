import { describe, expect, it, vi } from 'vitest'
import { createTokenBatcher } from './token-batcher'

function setup() {
  const frames = new Map<number, () => void>()
  let nextId = 1
  const raf = vi.fn((cb: () => void) => {
    const id = nextId++
    frames.set(id, cb)
    return id
  })
  const caf = vi.fn((id: number) => {
    frames.delete(id)
  })
  const onFlush = vi.fn<(clientId: string, text: string) => void>()
  const batcher = createTokenBatcher({ onFlush, requestFrame: raf, cancelFrame: caf })
  const runFrame = () => {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach((cb) => cb())
  }
  return { batcher, onFlush, raf, caf, runFrame, frames }
}

describe('createTokenBatcher', () => {
  it('한 프레임 안의 토큰을 모아 한 번에 내보낸다', () => {
    const t = setup()
    t.batcher.push('c1', '안')
    t.batcher.push('c1', '녕')
    t.batcher.push('c1', '하세요')
    expect(t.onFlush).not.toHaveBeenCalled()
    expect(t.raf).toHaveBeenCalledTimes(1)
    t.runFrame()
    expect(t.onFlush.mock.calls).toEqual([['c1', '안녕하세요']])
  })

  it('다음 프레임의 토큰은 따로 내보낸다', () => {
    const t = setup()
    t.batcher.push('c1', 'a')
    t.runFrame()
    t.batcher.push('c1', 'b')
    t.runFrame()
    expect(t.onFlush.mock.calls).toEqual([
      ['c1', 'a'],
      ['c1', 'b'],
    ])
  })

  it('다른 턴의 토큰이 들어오면 앞 턴의 토큰을 먼저 내보낸다', () => {
    const t = setup()
    t.batcher.push('c1', 'a')
    t.batcher.push('c2', 'b')
    t.runFrame()
    expect(t.onFlush.mock.calls).toEqual([
      ['c1', 'a'],
      ['c2', 'b'],
    ])
  })

  it('flush는 프레임을 기다리지 않고 즉시 내보내고 예약을 취소한다 (final 직전, 백그라운드 탭)', () => {
    const t = setup()
    t.batcher.push('c1', 'a')
    t.batcher.flush()
    expect(t.onFlush.mock.calls).toEqual([['c1', 'a']])
    expect(t.caf).toHaveBeenCalledTimes(1)
    t.runFrame()
    expect(t.onFlush).toHaveBeenCalledTimes(1)
  })

  it('비어 있을 때 flush하면 아무것도 내보내지 않는다', () => {
    const t = setup()
    t.batcher.flush()
    expect(t.onFlush).not.toHaveBeenCalled()
  })

  it('dispose하면 예약된 프레임을 취소하고 남은 토큰을 버린다 (언마운트 뒤 setState 방지)', () => {
    const t = setup()
    t.batcher.push('c1', 'a')
    t.batcher.dispose()
    t.runFrame()
    t.batcher.flush()
    expect(t.onFlush).not.toHaveBeenCalled()
    expect(t.frames.size).toBe(0)
  })
})
