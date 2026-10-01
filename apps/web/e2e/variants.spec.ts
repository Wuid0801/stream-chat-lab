import { expect, test } from '@playwright/test'
import { expectCompleted, openChat, send, streaming, uniqueText } from './helpers'

for (const v of [0, 1, 2, 3]) {
  test(`v${v}: 스트리밍부터 확정까지 동작한다`, async ({ page }) => {
    await openChat(page, `scenario=normal&seed=11&v=${v}`)
    await expect(page.getByTestId('scenario')).toContainText(`v${v}`)
    const text = uniqueText(`v${v}`)
    await send(page, text)

    await expect(streaming(page)).toBeVisible()
    // v3만 스트리밍 중에 평문으로 그린다.
    await expect(streaming(page).locator('.bubble--markdown')).toHaveCount(v === 3 ? 0 : 1)

    await expectCompleted(page, text)
    await expect(page.getByTestId('message').last().locator('.bubble--markdown')).toHaveCount(1)
  })
}
