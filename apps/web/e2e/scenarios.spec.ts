import { expect, test } from '@playwright/test'
import {
  collectConsole,
  expectCompleted,
  failed,
  openChat,
  send,
  streaming,
  uniqueText,
  userMessage,
} from './helpers'

test('normal: 보낸 즉시 표시되고, 토큰이 흘러온 뒤 확정된다', async ({ page }) => {
  const logs = collectConsole(page)
  await openChat(page, 'scenario=normal&seed=11')
  const text = uniqueText('normal')
  await send(page, text)

  // 낙관적 메시지: 서버 응답 전에 바로 보인다.
  await expect(userMessage(page, text)).toHaveAttribute('data-status', 'pending')
  await expect(streaming(page)).toBeVisible()
  await expectCompleted(page, text)
  expect(logs.errors).toEqual([])
})

test('done-only: final 없이 닫혀도 계약 위반을 경고하고 서버 상태로 복구한다', async ({ page }) => {
  const logs = collectConsole(page)
  await openChat(page, 'scenario=done-only&seed=11')
  const text = uniqueText('done-only')
  await send(page, text)

  await expectCompleted(page, text)
  expect(logs.warnings.some((w) => w.includes('계약 위반'))).toBe(true)
})

test('close-after-final: final 직후 서버가 닫아도 오류가 없다', async ({ page }) => {
  const logs = collectConsole(page)
  await openChat(page, 'scenario=close-after-final&seed=11')
  const text = uniqueText('close-after-final')
  await send(page, text)

  await expectCompleted(page, text)
  // 닫힘으로 생기는 onerror가 늦게 와도 실패로 바뀌지 않는지 잠시 더 지켜본다.
  await page.waitForTimeout(500)
  await expect(failed(page)).toHaveCount(0)
  expect(logs.errors).toEqual([])
  expect(logs.warnings).toEqual([])
})

test('drop-after-saved: 저장 직후 연결이 끊겨도 오탐 오류 없이 성공으로 복구한다', async ({
  page,
}) => {
  await openChat(page, 'scenario=drop-after-saved&seed=11')
  const text = uniqueText('drop-after-saved')
  await send(page, text)

  await expectCompleted(page, text)
})
