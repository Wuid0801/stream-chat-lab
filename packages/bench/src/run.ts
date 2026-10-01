/**
 * 렌더 비용 측정 러너. `yarn bench` 한 번으로 빌드부터 docs/results.md 생성까지 한다.
 *
 *   yarn bench                         # 공식 측정: 버전 0~3 × 10회 → docs/results.md
 *   yarn bench --runs 1 --variants 0,3 # 빠른 확인: 결과를 출력만 하고 파일은 쓰지 않는다
 *
 * 측정 방법과 한계: docs/decisions/010-benchmark-method.md
 */
import { chromium, type Browser } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { renderReport, type Conditions, type VariantResult } from './report'
import { summarizeRun, type RawRun, type RunSummary } from './stats'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
// yarn을 거치지 않고 바이너리를 직접 실행한다. (docs/decisions/001)
const VITE = path.join(ROOT, 'node_modules/vite/bin/vite.js')
const TSX = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs')

const OFFICIAL_RUNS = 10
const ALL_VARIANTS = [0, 1, 2, 3]
const MOCK_PORT = 8787
const PREVIEW_PORT = 4173
const CONDITIONS = {
  historyMessages: 200,
  replyTokens: 1500,
  tokensPerSecond: 40,
  seed: 11,
  cpuThrottle: 4,
  viewport: { width: 1280, height: 720 },
  /** 스트리밍 중 입력 간격 (INP 측정용) */
  typeEveryMs: 1000,
}

const { values: args } = parseArgs({
  options: {
    runs: { type: 'string', default: String(OFFICIAL_RUNS) },
    variants: { type: 'string', default: ALL_VARIANTS.join(',') },
  },
})
const runs = Number(args.runs)
const variants = args.variants.split(',').map(Number)
const official = runs === OFFICIAL_RUNS && ALL_VARIANTS.every((v) => variants.includes(v))

function start(scriptArgs: string[], env: Record<string, string> = {}): ChildProcess {
  const child = spawn(process.execPath, scriptArgs, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  return child
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  const exited = once(child, 'exit')
  child.kill()
  await exited
}

async function isUp(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok
  } catch {
    return false
  }
}

async function waitFor(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await isUp(url))) {
    if (Date.now() > deadline) throw new Error(`${url} 이(가) 뜨지 않았다`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

function isRawRun(value: unknown): value is RawRun & { sentAt: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'sentAt' in value &&
    typeof value.sentAt === 'number' &&
    'commits' in value &&
    Array.isArray(value.commits)
  )
}

async function runOnce(browser: Browser, version: number): Promise<RawRun> {
  // 이전 실행의 응답이 히스토리에 섞이지 않도록 실행마다 목 서버를 새로 띄운다.
  const server = start([TSX, 'apps/mock-server/src/index.ts'], {
    PORT: String(MOCK_PORT),
    SEED_MESSAGES: String(CONDITIONS.historyMessages),
  })
  const context = await browser.newContext({ viewport: CONDITIONS.viewport })
  try {
    await waitFor(`http://localhost:${MOCK_PORT}/health`)
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CONDITIONS.cpuThrottle })

    const query = new URLSearchParams({
      bench: '1',
      v: String(version),
      scenario: 'normal',
      seed: String(CONDITIONS.seed),
      history: String(CONDITIONS.historyMessages),
      tokens: String(CONDITIONS.replyTokens),
      rate: String(CONDITIONS.tokensPerSecond),
    })
    await page.goto(`http://localhost:${PREVIEW_PORT}/?${query.toString()}`)
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-testid="message"]').length >= n,
      CONDITIONS.historyMessages,
      { timeout: 120_000 },
    )
    await page.waitForTimeout(1000)

    const input = page.getByLabel('메시지 입력')
    await input.fill('측정용 질문입니다')
    await input.press('Enter')
    await page.locator('[data-status="streaming"]').waitFor({ timeout: 60_000 })

    // 스트리밍이 끝날 때까지 일정 간격으로 입력한다. (INP)
    const inProgress = page.locator('[data-status="streaming"], [data-status="pending"]')
    const deadline = Date.now() + 180_000
    while ((await inProgress.count()) > 0) {
      if (Date.now() > deadline) throw new Error('응답이 끝나지 않았다')
      await page.waitForTimeout(CONDITIONS.typeEveryMs)
      await page.keyboard.type('a')
    }
    if ((await page.locator('[data-status="failed"]').count()) > 0) {
      throw new Error('턴이 실패했다')
    }
    await page.waitForTimeout(500)

    const raw: unknown = await page.evaluate(
      () => (window as unknown as { __bench?: unknown }).__bench,
    )
    if (!isRawRun(raw)) throw new Error('window.__bench를 읽지 못했다')
    return raw
  } finally {
    await context.close()
    await stop(server)
  }
}

function gitCommit(): string {
  const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT })
    .toString()
    .trim()
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT }).toString().trim()
  return dirty ? `${hash}-dirty` : hash
}

async function main(): Promise<void> {
  if (await isUp(`http://localhost:${MOCK_PORT}/health`)) {
    throw new Error(`포트 ${MOCK_PORT}에 이미 서버가 떠 있다. yarn dev를 끄고 다시 실행한다.`)
  }

  console.log('빌드: vite build --mode bench')
  const build = start([VITE, 'build', 'apps/web', '--mode', 'bench'])
  const [code] = (await once(build, 'exit')) as [number | null]
  if (code !== 0) throw new Error(`빌드 실패 (exit ${code})`)

  const preview = start([
    VITE,
    'preview',
    'apps/web',
    '--port',
    String(PREVIEW_PORT),
    '--strictPort',
  ])
  const browser = await chromium.launch()
  const results = new Map<number, RunSummary[]>(variants.map((v) => [v, []]))
  try {
    await waitFor(`http://localhost:${PREVIEW_PORT}`)
    // 시간에 따른 기기 상태 변화가 한 버전에 몰리지 않도록 버전을 번갈아 실행한다.
    for (let i = 0; i < runs; i++) {
      for (const version of variants) {
        const summary = summarizeRun(await runOnce(browser, version))
        results.get(version)?.push(summary)
        console.log(`[${i + 1}/${runs}] v${version}`, JSON.stringify(summary))
      }
    }

    const playwrightVersion = (
      JSON.parse(
        readFileSync(path.join(ROOT, 'node_modules/@playwright/test/package.json'), 'utf8'),
      ) as { version: string }
    ).version
    const cpus = os.cpus()
    const conditions: Conditions = {
      date: new Date().toISOString().slice(0, 10),
      commit: gitCommit(),
      cpu: `${cpus[0]?.model.trim() ?? 'unknown'} (논리 코어 ${cpus.length}개)`,
      memoryGb: Math.round(os.totalmem() / 2 ** 30),
      os: `${os.version()} (${os.release()})`,
      browser: `Chromium ${browser.version()}`,
      playwright: playwrightVersion,
      cpuThrottle: CONDITIONS.cpuThrottle,
      runsPerVariant: runs,
      historyMessages: CONDITIONS.historyMessages,
      replyTokens: CONDITIONS.replyTokens,
      tokensPerSecond: CONDITIONS.tokensPerSecond,
      seed: CONDITIONS.seed,
      viewport: `${CONDITIONS.viewport.width}x${CONDITIONS.viewport.height}`,
      build: 'vite build --mode bench',
    }
    const variantResults: VariantResult[] = variants.map((version) => ({
      version,
      runs: results.get(version) ?? [],
    }))
    const report = renderReport(conditions, variantResults)

    if (official) {
      writeFileSync(path.join(ROOT, 'docs/results.md'), report)
      writeFileSync(
        path.join(ROOT, 'docs/results-raw.json'),
        JSON.stringify({ conditions, results: variantResults }, null, 2) + '\n',
      )
      console.log('docs/results.md, docs/results-raw.json을 썼다')
    } else {
      // 공식 조건이 아니면 파일을 쓰지 않는다. 측정하지 않은 조건의 값이 결과 문서에 섞이지 않게 하기 위해서다.
      console.log(report)
      console.log(
        `(공식 조건이 아니라 파일은 쓰지 않았다: runs=${runs}, variants=${variants.join(',')})`,
      )
    }
  } finally {
    await browser.close()
    await stop(preview)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
