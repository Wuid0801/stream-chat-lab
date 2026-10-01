import { describe, expect, it } from 'vitest'
import { isTerminalEvent, parseStreamEvent } from './index'

const message = (id: string, role: 'user' | 'assistant') => ({
  id,
  clientId: 'c-1',
  role,
  text: 'hi',
  createdAt: '2026-01-01T00:00:00.000Z',
})

describe('parseStreamEvent', () => {
  it('token 이벤트를 파싱한다', () => {
    expect(parseStreamEvent('{"type":"token","turnId":"t1","seq":0,"text":"안녕"}')).toEqual({
      ok: true,
      event: { type: 'token', turnId: 't1', seq: 0, text: '안녕' },
    })
  })

  it('final 이벤트는 확정된 사용자·응답 메시지를 담는다', () => {
    const raw = JSON.stringify({
      type: 'final',
      turnId: 't1',
      userMessage: message('m1', 'user'),
      assistantMessage: message('m2', 'assistant'),
    })
    const result = parseStreamEvent(raw)
    expect(result.ok && result.event.type).toBe('final')
  })

  it('JSON이 아니면 실패로 돌려준다', () => {
    expect(parseStreamEvent('not json').ok).toBe(false)
  })

  it('알 수 없는 type은 실패로 돌려준다', () => {
    expect(parseStreamEvent('{"type":"tool","turnId":"t1"}').ok).toBe(false)
  })

  it('필드가 빠지면 실패로 돌려준다', () => {
    expect(parseStreamEvent('{"type":"token","turnId":"t1"}').ok).toBe(false)
  })
})

describe('isTerminalEvent', () => {
  it('final과 error만 종료 이벤트이고 done은 아니다', () => {
    expect(isTerminalEvent({ type: 'done', turnId: 't1' })).toBe(false)
    expect(isTerminalEvent({ type: 'token', turnId: 't1', seq: 0, text: '' })).toBe(false)
    expect(isTerminalEvent({ type: 'error', turnId: 't1', code: 'x', message: 'x' })).toBe(true)
  })
})
