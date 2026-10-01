import { expect, test, type Page } from '@playwright/test'
import { expectCompleted, openChat, send, streaming, uniqueText, userMessage } from './helpers'

/** 화면에 있는 메시지의 clientId가 모두 다른지 (중복 표시 없음) */
async function expectNoDuplicates(page: Page) {
  const ids = await page
    .getByTestId('message')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-client-id')))
  expect(new Set(ids).size).toBe(ids.length)
}

test('위로 스크롤하면 과거 메시지를 불러오고, 보이던 첫 메시지의 위치가 ±1px 이내로 유지된다 (v5)', async ({
  page,
}) => {
  await openChat(page, 'v=5')
  const list = page.getByTestId('message-list')
  const countBefore = await page.getByTestId('message').count()

  // 맨 위로 올린 순간, 화면 맨 위에 보이던 메시지와 그 위치를 기록한다.
  const before = await list.evaluate((el) => {
    el.scrollTop = 0
    const first = el.querySelector<HTMLElement>('[data-testid="message"]')
    return {
      key: first?.dataset.key ?? '',
      top: (first?.getBoundingClientRect().top ?? 0) - el.getBoundingClientRect().top,
    }
  })
  await expect.poll(() => page.getByTestId('message').count()).toBeGreaterThan(countBefore)
  // 보정이 끝난 다음 프레임까지 기다린다.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  )

  const after = await list.evaluate((el, key) => {
    const same = el.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
    return (same?.getBoundingClientRect().top ?? NaN) - el.getBoundingClientRect().top
  }, before.key)
  expect(Math.abs(after - before.top)).toBeLessThanOrEqual(1)
  await expectNoDuplicates(page)
})

for (const [label, delay] of [
  ['확정보다 늦게', 5000],
  ['확정보다 먼저', 1000],
] as const) {
  test(`out-of-order-history: 히스토리가 ${label} 도착해도 중복·누락이 없다`, async ({ page }) => {
    // 히스토리를 기다리지 않고 바로 보낸다.
    await page.goto(`/?seed=11&historyDelay=${delay}`)
    const text = uniqueText('out-of-order')
    await send(page, text)

    await expectCompleted(page, text)
    // 히스토리가 도착해 지난 메시지가 그려질 때까지 기다린다.
    await expect
      .poll(() => page.getByTestId('message').count(), { timeout: 10_000 })
      .toBeGreaterThan(2)
    await expect(userMessage(page, text)).toHaveCount(1)
    await expect(streaming(page)).toHaveCount(0)
    await expectNoDuplicates(page)
  })
}

test('duplicate-text: 같은 문장을 연속으로 보내면 둘 다 표시한다', async ({ page }) => {
  await openChat(page, 'seed=11')
  const text = uniqueText('같은 문장')
  await send(page, text)
  await expectCompleted(page, text)
  await send(page, text)
  await expect(userMessage(page, text)).toHaveCount(2)
  await expect(userMessage(page, text).last()).toHaveAttribute('data-status', 'sent', {
    timeout: 20_000,
  })
  await expectNoDuplicates(page)
})
