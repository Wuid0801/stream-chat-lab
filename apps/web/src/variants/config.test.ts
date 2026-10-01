import { describe, expect, it } from 'vitest'
import { parseVariant } from './config'

describe('parseVariant', () => {
  it('v0은 기법 없음', () => {
    expect(parseVariant('0')).toEqual({
      version: 0,
      memoPast: false,
      rafBatch: false,
      plainWhileStreaming: false,
      stableKey: false,
      layoutScrollCorrection: false,
    })
  })

  it('버전이 오를 때마다 기법이 하나씩 더해진다', () => {
    expect(parseVariant('1')).toMatchObject({ memoPast: true, rafBatch: false })
    expect(parseVariant('2')).toMatchObject({
      memoPast: true,
      rafBatch: true,
      plainWhileStreaming: false,
    })
    expect(parseVariant('3')).toMatchObject({
      memoPast: true,
      rafBatch: true,
      plainWhileStreaming: true,
      stableKey: false,
    })
    expect(parseVariant('4')).toMatchObject({
      plainWhileStreaming: true,
      stableKey: true,
      layoutScrollCorrection: false,
    })
    expect(parseVariant('5')).toMatchObject({ stableKey: true, layoutScrollCorrection: true })
  })

  it('값이 없거나 잘못되면 최신 버전(v5)을 쓴다', () => {
    expect(parseVariant(null).version).toBe(5)
    expect(parseVariant('9').version).toBe(5)
    expect(parseVariant('abc').version).toBe(5)
  })
})
