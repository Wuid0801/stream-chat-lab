import { expect, type Page } from '@playwright/test'

/** 서버 상태가 테스트 사이에 남으므로, 매번 다른 문장을 보내 이전 실행과 섞이지 않게 한다. */
export function uniqueText(label: string): string {
  return `${label} ${crypto.randomUUID().slice(0, 8)}`
}

export async function openChat(page: Page, query: string): Promise<void> {
  await page.goto(`/?${query}`)
  // 지난 대화가 그려질 때까지 기다린다.
  await expect(page.getByTestId('message').first()).toBeVisible()
}

export async function send(page: Page, text: string): Promise<void> {
  const input = page.getByLabel('메시지 입력')
  await input.fill(text)
  await input.press('Enter')
}

export function collectConsole(page: Page) {
  const errors: string[] = []
  const warnings: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
    if (m.type() === 'warning') warnings.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(e.message))
  return { errors, warnings }
}

export const userMessage = (page: Page, text: string) =>
  page.locator('[data-role="user"]').filter({ hasText: text })

export const streaming = (page: Page) => page.locator('[data-status="streaming"]')
export const failed = (page: Page) => page.locator('[data-status="failed"]')

/** 응답이 확정될 때까지 기다리고, 마지막 메시지가 확정된 응답인지 확인한다. */
export async function expectCompleted(page: Page, text: string): Promise<void> {
  await expect(streaming(page)).toHaveCount(0, { timeout: 15_000 })
  await expect(userMessage(page, text)).toHaveAttribute('data-status', 'sent')
  const last = page.getByTestId('message').last()
  await expect(last).toHaveAttribute('data-role', 'assistant')
  await expect(last).toHaveAttribute('data-status', 'sent')
  await expect(failed(page)).toHaveCount(0)
}
