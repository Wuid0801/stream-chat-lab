import { describe, expect, it } from 'vitest'
import { shouldSubmit } from './keys'

const key = (overrides: Partial<Parameters<typeof shouldSubmit>[0]> = {}) => ({
  key: 'Enter',
  shiftKey: false,
  isComposing: false,
  keyCode: 13,
  ...overrides,
})

describe('shouldSubmit', () => {
  it('Enter를 누르면 보낸다', () => {
    expect(shouldSubmit(key())).toBe(true)
  })

  it('Shift+Enter는 줄바꿈이다', () => {
    expect(shouldSubmit(key({ shiftKey: true }))).toBe(false)
  })

  it('IME 조합 중의 Enter는 무시한다 (마지막 글자가 잘리고 전송되는 문제)', () => {
    expect(shouldSubmit(key({ isComposing: true }))).toBe(false)
  })

  it('isComposing이 false여도 keyCode 229면 조합 중으로 본다 (일부 브라우저)', () => {
    expect(shouldSubmit(key({ keyCode: 229 }))).toBe(false)
  })

  it('Enter가 아닌 키는 보내지 않는다', () => {
    expect(shouldSubmit(key({ key: 'a', keyCode: 65 }))).toBe(false)
  })
})
