import { expect, test } from '@playwright/test'
import { expectCompleted, openChat, send, streaming, uniqueText, userMessage } from './helpers'

for (const v of [0, 1, 2, 3, 4, 5]) {
  test(`v${v}: 스트리밍부터 확정까지 동작한다`, async ({ page }) => {
    await openChat(page, `scenario=normal&seed=11&v=${v}`)
    await expect(page.getByTestId('scenario')).toContainText(`v${v}`)
    const text = uniqueText(`v${v}`)
    await send(page, text)

    await expect(streaming(page)).toBeVisible()
    // v3부터 스트리밍 중에 평문으로 그린다.
    await expect(streaming(page).locator('.bubble--markdown')).toHaveCount(v >= 3 ? 0 : 1)

    await expectCompleted(page, text)
    await expect(page.getByTestId('message').last().locator('.bubble--markdown')).toHaveCount(1)
  })
}

for (const [v, remounts] of [
  [3, true],
  [4, false],
] as const) {
  test(`v${v}: 확정될 때 사용자 메시지를 ${remounts ? '다시 만든다 (key가 바뀜)' : '같은 DOM 노드로 유지한다 (key 승계)'}`, async ({
    page,
  }) => {
    await openChat(page, `seed=11&v=${v}`)
    const text = uniqueText(`key-v${v}`)
    await send(page, text)
    const pending = await userMessage(page, text).elementHandle()
    await expectCompleted(page, text)
    expect(await pending?.evaluate((el) => el.isConnected)).toBe(!remounts)
  })
}
