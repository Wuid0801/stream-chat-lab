import { expect, test } from '@playwright/test'
import {
  collectConsole,
  collectTurnRequests,
  expectCompleted,
  failed,
  openChat,
  send,
  streaming,
  TRANSPORTS,
  uniqueText,
  userMessage,
} from './helpers'

const contractWarnings = (warnings: string[]) => warnings.filter((w) => w.includes('계약 위반'))

for (const transport of TRANSPORTS) {
  const open = (page: Parameters<typeof openChat>[0], query: string) =>
    openChat(page, `${query}&seed=11&transport=${transport}`)

  test.describe(`${transport}`, () => {
    test('normal: 보낸 즉시 표시되고, 토큰이 흘러온 뒤 확정된다', async ({ page }) => {
      const logs = collectConsole(page)
      await open(page, 'scenario=normal')
      const text = uniqueText('normal')
      await send(page, text)

      // 낙관적 메시지: 서버 응답 전에 바로 보인다.
      await expect(userMessage(page, text)).toHaveAttribute('data-status', 'pending')
      await expect(streaming(page)).toBeVisible()
      await expectCompleted(page, text)
      expect(logs.errors).toEqual([])
    })

    test('done-only: final 없이 닫혀도 계약 위반을 경고하고 서버 상태로 복구한다', async ({
      page,
    }) => {
      const logs = collectConsole(page)
      await open(page, 'scenario=done-only')
      const text = uniqueText('done-only')
      await send(page, text)

      await expectCompleted(page, text)
      expect(contractWarnings(logs.warnings)).toHaveLength(1)
    })

    test('close-after-final: final 직후 서버가 닫아도 오류가 없다', async ({ page }) => {
      const logs = collectConsole(page)
      await open(page, 'scenario=close-after-final')
      const text = uniqueText('close-after-final')
      await send(page, text)

      await expectCompleted(page, text)
      // 닫힘으로 생기는 오류 알림이 늦게 와도 실패로 바뀌지 않는지 잠시 더 지켜본다.
      await page.waitForTimeout(500)
      await expect(failed(page)).toHaveCount(0)
      expect(logs.errors).toEqual([])
      expect(logs.warnings).toEqual([])
    })

    test('drop-after-saved: 저장 직후 끊겨도 이어 받아 오탐 오류 없이 완료한다', async ({
      page,
    }) => {
      const requests = collectTurnRequests(page)
      await open(page, 'scenario=drop-after-saved')
      const text = uniqueText('drop-after-saved')
      await send(page, text)

      await expectCompleted(page, text)
      expect(requests.creates).toHaveLength(1)
    })

    test('drop-mid-stream: 중간에 끊기면 같은 턴을 이어 받는다 (재전송하지 않는다)', async ({
      page,
    }) => {
      const logs = collectConsole(page)
      const requests = collectTurnRequests(page)
      await open(page, 'scenario=drop-mid-stream')
      const text = uniqueText('drop-mid-stream')
      await send(page, text)

      await expectCompleted(page, text)
      expect(requests.creates).toHaveLength(1)
      expect(requests.streams.length).toBeGreaterThanOrEqual(2)
      expect(requests.streams[0]?.lastEventId).toBeNull()
      expect(Number(requests.streams[1]?.lastEventId)).toBeGreaterThan(0)
      // 이어 받은 텍스트가 확정 텍스트와 같다 (중복·누락 없음).
      expect(contractWarnings(logs.warnings)).toEqual([])
    })

    test('slow-first-token: 첫 토큰을 기다리는 동안 대기 표시를 유지하고 타임아웃하지 않는다', async ({
      page,
    }) => {
      const requests = collectTurnRequests(page)
      await open(page, 'scenario=slow-first-token&firstTokenDelay=3000&idleTimeout=10000')
      const text = uniqueText('slow-first-token')
      await send(page, text)

      await expect(page.getByTestId('waiting')).toBeVisible()
      await expect(streaming(page)).toBeVisible({ timeout: 10_000 })
      await expect(page.getByTestId('waiting')).toHaveCount(0)
      await expectCompleted(page, text)
      expect(requests.streams).toHaveLength(1)
    })

    test('long-silence + 하트비트: 침묵 중에도 연결을 유지한다', async ({ page }) => {
      const requests = collectTurnRequests(page)
      await open(page, 'scenario=long-silence&silence=4000&heartbeatMs=500&idleTimeout=2000')
      const text = uniqueText('long-silence-heartbeat')
      await send(page, text)

      await expectCompleted(page, text)
      expect(requests.streams).toHaveLength(1)
    })

    test('long-silence, 하트비트 없음: 어댑터마다 타임아웃 규칙대로 동작한다', async ({ page }) => {
      const logs = collectConsole(page)
      const requests = collectTurnRequests(page)
      await open(page, 'scenario=long-silence&silence=4000&heartbeat=off&idleTimeout=2000')
      const text = uniqueText('long-silence-no-heartbeat')
      await send(page, text)

      await expectCompleted(page, text)
      if (transport === 'fetch') {
        // idle 타임아웃으로 끊고 이어 받는다.
        expect(requests.streams.length).toBeGreaterThanOrEqual(2)
      } else {
        // EventSource는 주석을 볼 수 없어 idle 타임아웃이 없다. 연결은 브라우저가 유지한다.
        expect(requests.streams).toHaveLength(1)
      }
      expect(requests.creates).toHaveLength(1)
      expect(contractWarnings(logs.warnings)).toEqual([])
    })

    for (const [scenario, fetchText] of [
      ['http-401', '인증이 만료되었습니다'],
      ['http-5xx', '서버 오류'],
    ] as const) {
      test(`${scenario}: 실패 안내 후 재시도하면 같은 턴으로 성공한다`, async ({ page }) => {
        const requests = collectTurnRequests(page)
        await open(page, `scenario=${scenario}`)
        const text = uniqueText(scenario)
        await send(page, text)

        await expect(userMessage(page, text)).toHaveAttribute('data-status', 'failed')
        // 상태 코드는 fetch 어댑터만 알 수 있다. EventSource는 일반 실패로 안내한다.
        await expect(failed(page)).toContainText(
          transport === 'fetch' ? fetchText : '전송하지 못했습니다',
        )

        await failed(page).getByRole('button', { name: '재시도' }).click()
        await expectCompleted(page, text)
        await expect(userMessage(page, text)).toHaveCount(1)
        expect(requests.creates).toHaveLength(2)
      })
    }

    for (const scenario of ['chunk-chaos', 'proxy-buffering'] as const) {
      test(`${scenario}: 내용이 깨지지 않고 확정 텍스트와 같다`, async ({ page }) => {
        const logs = collectConsole(page)
        await open(page, `scenario=${scenario}`)
        const text = uniqueText(scenario)
        await send(page, text)

        await expectCompleted(page, text)
        expect(contractWarnings(logs.warnings)).toEqual([])
      })
    }
  })
}
