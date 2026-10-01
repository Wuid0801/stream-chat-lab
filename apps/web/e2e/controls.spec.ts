import { expect, test } from '@playwright/test'
import { openChat, send, streaming, uniqueText, userMessage } from './helpers'

// 응답이 약 10초 걸리도록 길고 느리게 만든다. 중간에 누를 시간이 필요하다.
const LONG_REPLY = 'seed=11&tokens=200&rate=20'

test('중지: 스트리밍 중에 누르면 거기까지의 응답이 "중지됨"으로 확정되고 더 늘어나지 않는다', async ({
  page,
}) => {
  await openChat(page, LONG_REPLY)
  const text = uniqueText('stop')
  await send(page, text)
  await expect(streaming(page)).toBeVisible()
  await expect
    .poll(async () => (await streaming(page).textContent())?.length ?? 0)
    .toBeGreaterThan(10)

  await page.getByRole('button', { name: '중지' }).click()

  const reply = page.getByTestId('message').last()
  await expect(reply).toHaveAttribute('data-status', 'sent')
  await expect(reply).toContainText('중지됨')
  await expect(userMessage(page, text)).toHaveAttribute('data-status', 'sent')
  const length = (await reply.textContent())?.length ?? 0
  await page.waitForTimeout(1000)
  expect((await reply.textContent())?.length).toBe(length)
  // 다시 보낼 수 있다.
  await expect(page.getByRole('button', { name: '보내기' })).toBeVisible()
})

test('중지: 첫 토큰 전에 눌러도 턴이 정리되고 다시 보낼 수 있다', async ({ page }) => {
  await openChat(page, 'scenario=slow-first-token&firstTokenDelay=5000&seed=11')
  const text = uniqueText('stop-waiting')
  await send(page, text)
  await expect(page.getByTestId('waiting')).toBeVisible()

  await page.getByRole('button', { name: '중지' }).click()

  await expect(page.getByTestId('waiting')).toHaveCount(0)
  await expect(page.getByTestId('message').last()).toContainText('중지됨')
  await expect(page.getByRole('button', { name: '보내기' })).toBeVisible()
})

test('새 메시지 버튼: 위로 올려 둔 동안 응답이 늘어나면 보이고, 누르면 바닥으로 내려간다', async ({
  page,
}) => {
  await openChat(page, LONG_REPLY)
  const button = page.getByTestId('new-messages')
  await expect(button).toBeHidden()

  await send(page, uniqueText('new-messages'))
  await expect(streaming(page)).toBeVisible()
  const list = page.getByTestId('message-list')
  await list.evaluate((el) => el.scrollBy({ top: -600 }))

  await expect(button).toBeVisible()
  await button.click()
  await expect
    .poll(() => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThanOrEqual(48)
  await expect(button).toBeHidden()
})
