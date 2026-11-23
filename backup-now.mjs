// 手动备份入口：双击桌面「立即备份」时跑这一份。
// 复用 lib/host.js 里的「跑一轮」，跟每日定时走的是同一套逻辑。
//
// ⚠ 想留一份能用的 **Cookies**，必须在 DSH 关着的时候跑这个 ——
//   Chromium 的 cookie 库带独占锁，DSH 一开着就抄不动（EBUSY，非管理员无解）。
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { 跑一轮 } from './lib/host.js'

const 这里 = dirname(fileURLToPath(import.meta.url))
const 配置 = JSON.parse(await readFile(join(这里, 'backup-config.json'), 'utf8'))

console.log('开始手动备份…')
const 结果 = await 跑一轮(配置, '手动')
console.log(结果.话)

// 把「被独占没抄下来」的东西单独念一遍：不然又是一轮看着成功、其实少了东西
const 清单 = Array.isArray(结果.清单) ? 结果.清单 : []
const 没抄到 = 清单.filter((条) => typeof 条.校验 === 'string' && 条.校验.startsWith('skipped'))
if (没抄到.length > 0) {
  console.log('')
  console.log('下面这些没抄下来（不是路径写错，是文件被别的进程独占）：')
  for (const 条 of 没抄到) console.log('  · ' + 条.文件 + ' → ' + 条.校验)
  const 有Cookies = 没抄到.some((条) => /Cookies/i.test(String(条.文件)))
  if (有Cookies) {
    console.log('')
    console.log('要一份能用的 Cookies，请**先退出 DSH**，再双击一次「立即备份」。')
    console.log('DSH 跑着的时候那个文件是独占锁的，谁都读不了（实测 copyFile / robocopy / .NET 全 EBUSY）。')
  }
}

process.exit(结果.成功 ? 0 : 1)
