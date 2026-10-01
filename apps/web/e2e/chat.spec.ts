import { expect, test } from '@playwright/test'
import {
  expectCompleted,
  failed,
  openChat,
  send,
  streaming,
  uniqueText,
  userMessage,
} from './helpers'

test('전송이 실패하면 입력 내용이 failed 메시지로 남고, 재시도하면 한 번만 전송된다', async ({
  page,
}) => {
  await openChat(page, 'scenario=normal&seed=11')
  let blocked = true
  await page.route('**/turns', (route) =>
    blocked && route.request().method() === 'POST' ? route.abort() : route.continue(),
  )

  const text = uniqueText('retry')
  await send(page, text)
  await expect(userMessage(page, text)).toHaveAttribute('data-status', 'failed')
  await expect(failed(page).getByRole('button', { name: '복사' })).toBeVisible()

  blocked = false
  await failed(page).getByRole('button', { name: '재시도' }).click()
  await expectCompleted(page, text)
  await expect(userMessage(page, text)).toHaveCount(1)
})

test('스트리밍 중 위로 스크롤하면 아래로 끌려 내려가지 않는다', async ({ page }) => {
  await openChat(page, 'scenario=normal&seed=11')
  const text = uniqueText('scroll')
  await send(page, text)
  await expect(streaming(page)).toBeVisible()

  const list = page.getByTestId('message-list')
  const lastMessage = page.getByTestId('message').last()
  // 맨 위로 올리면 과거 페이지를 불러오며 위치 보정으로 scrollTop이 바뀐다. 그래서 바닥과의 거리로 확인한다.
  const distanceFromBottom = () =>
    list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
  await list.evaluate((el) => el.scrollTo({ top: 0 }))
  const lengthAtScroll = (await lastMessage.textContent())?.length ?? 0

  // 위로 올린 뒤에도 응답이 계속 길어졌는지 확인해야 이 테스트가 의미가 있다.
  await expect
    .poll(async () => (await lastMessage.textContent())?.length ?? 0)
    .toBeGreaterThan(lengthAtScroll)
  expect(await distanceFromBottom()).toBeGreaterThan(200)

  await expectCompleted(page, text)
  expect(await distanceFromBottom()).toBeGreaterThan(200)
})
