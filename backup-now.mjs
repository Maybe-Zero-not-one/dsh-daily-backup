// 手动备份入口：**在 DSH 关着的时候**跑这一份。
//
// 为什么强调"关着"：`Network\Cookies` 是 Chromium 的 SQLite，DSH 跑着的时候
// 带独占锁 —— `copyFile` / `CopyFileEx` / `robocopy` / `.NET FileStream`
// 连 Share.ReadWrite 强开都失败（2026-11-23 又实测一遍，非管理员没有
// SeBackupPrivilege / VSS 那条路）。所以 cookie 只能在 DSH 停下来之后抄。
//
// 配置从哪来（按优先级）：
//   1) 命令行 `--config <路径>`
//   2) 同目录 `backup-config.json`（本机那份就在这）
//   3) 都没有 → 用空对象，走 lib/host.js 里的默认值
//      ⚠ 2026-11-23 修：以前这里是硬读 backup-config.json，
//        而那个文件**没打进 npm 包**（它在 .gitignore 边上，`files` 里也没有），
//        别人装了插件双击就 ENOENT 崩。发布出去的包里不能假设它在。
//
// 环境变量（可选，给"同一台机器多个 DSH"用）：
//   DSH_BACKUP_TARGET   覆盖 目标目录
//   DSH_HOME            DSH 的家目录（默认 ~/.dsh）
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { 跑一轮, 列出备份 } from './lib/host.js'

const 这里 = dirname(fileURLToPath(import.meta.url))

/** 从命令行里取 `--config <路径>` / `--config=<路径>`。 */
function 取参数(名) {
  const 参 = process.argv.slice(2)
  for (let i = 0; i < 参.length; i += 1) {
    if (参[i] === '--' + 名) return 参[i + 1]
    if (参[i].startsWith('--' + 名 + '=')) return 参[i].slice(名.length + 3)
  }
  return undefined
}

/** 配置：命令行 → 同目录 json → 空（走默认）。读坏了要说清楚，别默默用默认值。 */
async function 读配置() {
  const 指定 = 取参数('config')
  const 候选 = 指定 !== undefined ? [resolve(指定)] : [join(这里, 'backup-config.json')]
  for (const 路径 of 候选) {
    try {
      const 原文 = await readFile(路径, 'utf8')
      const 体 = JSON.parse(原文)
      if (体 !== null && typeof 体 === 'object' && !Array.isArray(体)) {
        return { 配置: 体, 来源: 路径 }
      }
      throw new Error('不是一个 JSON 对象')
    } catch (错误) {
      if (错误 && 错误.code === 'ENOENT') continue // 没有就试下一个
      // 有文件但读坏了：这不能当"没有"处理，否则会拿默认值偷偷跑偏
      console.error('配置读不了：' + 路径)
      console.error('  ' + String((错误 && 错误.message) || 错误))
      process.exit(2)
    }
  }
  if (指定 !== undefined) {
    console.error('指定的配置文件不存在：' + resolve(指定))
    process.exit(2)
  }
  return { 配置: {}, 来源: null }
}

const { 配置, 来源 } = await 读配置()

// 环境变量的覆盖放在最外层，方便同一个插件管多份备份
if (process.env.DSH_BACKUP_TARGET) 配置.目标目录 = process.env.DSH_BACKUP_TARGET

if (来源 === null) {
  console.log('没找到 backup-config.json，按插件默认设置备份。')
  console.log('  （要固定路径就写一份 json 放同目录，或用 --config 指定）')
}

console.log('开始手动备份…')
const 结果 = await 跑一轮(配置, '手动')

// 打完这一轮，把「目标目录」和「cookie 到底备上没有」如实念出来
const 概况 = await 列出备份(配置)
console.log('备份根：' + 概况.配置.目标目录)
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
    console.log('⚠ 里面有 Cookies —— 说明 DSH 还开着。')
    console.log('  Chromium 的 cookie 库在 DSH 运行时是独占锁，谁都读不了。')
    console.log('  要一份能用的：先完全退出 DSH（不是只关窗口），再跑一次这个脚本。')
    console.log('  嫌麻烦就用插件的「安装手动备份脚本」：它会在关 DSH 后自动补一份，然后再帮你打开。')
  }
}

process.exit(结果.成功 ? 0 : 1)
