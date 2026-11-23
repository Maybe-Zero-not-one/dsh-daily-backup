// DSH「会话每日备份」· 宿主半边
//
// 干一件事：**每天到点，把 QQ 会话日志拷一份到工作区，保留最近 N 天。**
//
// 为什么需要它：
//   QQ 那边一旦换了 mediaDir / session id，插件的映射文件就跟着换地方，
//   旧会话本体（storages/session_projcache/sessions/onebot-*.json）虽然还在盘上，
//   但没人引用它 —— 手一抖删掉就没得救了。会话本体是几十天的聊天记录，
//   体积几 MB，备份成本几乎为零，所以每天留一版最省心。
//
// 设计上的三个取舍：
//   1) 用 60 秒一次的 tick 比「定一个几小时的 setTimeout」可靠：机器休眠/唤醒、
//      系统时间被改，长定时器都可能错过或提前；tick 每次重新看墙钟，错过也能补。
//   2) 拷贝用 copyFile 后**核对字节数**，大小不一致就记成 size-mismatch ——
//      备份最怕的是"看起来有文件，其实是半截"。
//   3) 启动后补一次。四个小时后才到点的活儿，如果机器早关机了，就永远等不到；
//      启动时先拍一版，等于给"今天"兜底。
//
// ⚠ 不 import @deepseek-ai/schemastery：profile 的 node_modules 里没有它，
//    import 失败会让整个插件加载不了。配置就走 cordis.patch.yml 的 config。

import { mkdir, readdir, copyFile, stat, writeFile, appendFile, rm, rename, readFile, cp, chmod } from 'node:fs/promises'
// 同步版只给「进程退出时」用：那时事件循环要停了，await 不会再有结果
import { statSync, copyFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, basename, dirname, resolve, sep } from 'node:path'
import { homedir, platform } from 'node:os'
import { fileURLToPath } from 'node:url'

/** 文件内容指纹：大小一致但内容坏掉的极端情况靠它查出来。 */
async function 算MD5(路径) {
  try {
    const 数据 = await readFile(路径)
    return createHash('md5').update(数据).digest('hex')
  } catch {
    return null
  }
}

/**
 * ⭐ 2026-11-05（DSH 升到 0.2.2-rc.1 时补的）：会话本体文件名带版本号
 *   （现在是 `session.v4.jsonl.zstd`）。以前这里写死 v4 —— DSH 哪天把它改成
 *   v5，备份会**静默一个都不备**，这是备份插件最不能犯的错。
 *   所以改成现找 `session.v<N>.jsonl.zstd`，有多个就取版本号最大的那个。
 */
async function 找本体文件(会话目录) {
  let 名单 = []
  try {
    名单 = await readdir(会话目录)
  } catch {
    return null
  }
  const 命中 = 名单
    .filter((f) => /^session\.v\d+\.jsonl\.zstd$/.test(f))
    .sort((a, b) => Number(a.match(/v(\d+)/)[1]) - Number(b.match(/v(\d+)/)[1]))
  return 命中.length ? join(会话目录, 命中[命中.length - 1]) : null
}

/** 插件对外名字（日志前缀、source 标记）。 */
export const name = 'session-backup'

/** 只需要 timer；拿不到就什么都不做（不会让插件加载失败）。 */
export const inject = ['timer']

const 默认配置 = {
  enabled: true,
  // 留空 = <DSH_HOME>/storages/session_projcache/sessions
  源目录: '',
  // 备份落到哪儿。结构：
  //   <目标目录>\索引\<日期>\*.json        投影缓存（所有工作区放一起）
  //   <目标目录>\会话\<工作区名>\<日期>\*.zstd   会话本体（按工作区分开）
  //
  // ⚠ 2026-11-23：默认值原来是作者本机的一个写死路径，现在改成「空 = 自动算」。
  //   原因很实在：插件发到 npm 了，别人装上去不该默认往作者的盘符写。
  //   空的时候落 <用户主目录>\dsh-session-backup。
  目标目录: '',
  索引子目录: '索引',
  会话子目录: '会话',
  // 匹配规则（支持 * 和 ?）。默认吃所有 QQ 会话，这样换了 session id 也照样备到
  会话文件: ['onebot-*.json'],
  // 每天几点拍（24 小时制，本地时间）
  每天几点: '04:30',
  // 保留最近几天，更早的日期目录整个删掉
  保留天数: 14,
  // 启动后补拍一次
  启动后立刻备份: true,
  启动延迟秒: 60,
  // ⚠ 归置收到的图 2026-11-13 搬到 dsh-reply-jitter 了（那边的 归置收到的图 /
  //   媒体目录 / 归置最小年龄分钟）。这三个键这里**故意不再定义** ——
  //   留着会让人以为备份插件还管这事，而且两处都配会打架。
  // 会话本体（sessions/<工作区>/<会话ID>/session.v4.jsonl.zstd）也一起备
  备份本体: true,
  // 留空 = <DSH_HOME>/sessions
  本体目录: '',
  // 应用状态（网页端的 Cookies、Local Storage 等）：满了/坏了会导致网页端登不上或打不开，
  // 留一份备份总比临时手忙脚乱强。落 <目标目录>\应用状态\<日期>\
  备份应用状态: true,
  // 留空 = %APPDATA%\@deepseek-ai\dsh-desktop
  应用状态目录: '',
  // 相对上面目录要备的文件/目录；不存在的自动跳过。
  // ⚠ Network\Cookies 在 DSH 跑着的时候是**独占锁**的，正常备份抄不到，
  //   只能靠退出时补抄（见 退出补抄）。journal 挨着它一起列上，别只备主库。
  //   2026-11-07 之前一直用 ['Network\\Cookies', ...]：cookie 从来没备上过。
  应用状态项: [
    'Network\\Cookies',
    'Network\\Cookies-journal',
    'Local Storage',
    'Preferences',
    'Local State',
    'logs',
  ],
  // 人设卡（soul-md 的 cards/active 都存在 profile 的 cordis.patch.yml 里）
  备份人设: true,
  // 留空 = <DSH_HOME>/profiles/desktop/cordis.patch.yml
  人设配置: '',
  // 长期记忆：soul-md 的 memory 目录 + fish-memory（remember 工具写的）
  备份记忆: true,
  // 留空 = [<DSH_HOME>/soul-md/memory, <DSH_HOME>/fish-memory]
  记忆目录: [],

  // ---- 网盘推送（2026-11-11 加）----
  // 每天备份完，把当天的备份原样推到网盘，多一份异地保险。
  //
  // 协议选 `openlist`（本机 5244 的 OpenList，alist 系）还是 `webdav`：
  //   ⚠ 实测 OpenList 的 /dav 是**只读**的（Allow 里没有 PUT/MKCOL，PUT 一律 404），
  //     上传只能走它的 HTTP API：POST /api/fs/mkdir + PUT /api/fs/put（File-Path 头）。
  //     webdav 协议留给支持 PUT/MKCOL 的服务器（坚果云 dav.jianguoyun.com 等）。
  推送网盘: false,
  网盘协议: 'openlist', // 'openlist' | 'webdav'
  网盘地址: 'http://127.0.0.1:5244',
  // openlist 用静态 Token（设置里生成，绕开 2FA）；webdav 用 用户名/密码
  网盘令牌: '',
  网盘用户名: '',
  网盘密码: '',
  // 挂在 OpenList 下、要推进去的存储名（比如 百度网盘 / 夸克网盘）。
  // webdav 协议时这个是远端根目录名。
  网盘根目录: '百度网盘',
  // 在网盘里再套一层目录（可选）
  网盘子目录: 'DSH备份',
  // 远端保留天数；0 = 不删（主人定的：远端全留）
  网盘保留天数: 0,
  // 单个请求的超时（秒）
  网盘超时秒: 30,
}

const tick毫秒 = 60_000

// ---------------------------------------------------------------- 小工具

/** 极简通配符匹配：只认 * 和 ?，不用引正则依赖。 */
function 匹配(名称, 模式) {
  let 转义 = ''
  for (const 字 of 模式) {
    if (字 === '*') 转义 += '.*'
    else if (字 === '?') 转义 += '.'
    else 转义 += 字.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + 转义 + '$').test(名称)
}

function 本地日期(现在 = new Date()) {
  const 补 = (n) => String(n).padStart(2, '0')
  return `${现在.getFullYear()}-${补(现在.getMonth() + 1)}-${补(现在.getDate())}`
}

/** '04:30' → { 时: 4, 分: 30 }；写坏了就返回 null（宁可不算，也不乱拍）。 */
function 解析时刻(文本) {
  const 命中 = /^(\d{1,2})\s*[:：]\s*(\d{1,2})$/.exec(String(文本 || '').trim())
  if (命中 === null) return null
  const 时 = Number(命中[1])
  const 分 = Number(命中[2])
  if (!Number.isInteger(时) || !Number.isInteger(分)) return null
  if (时 < 0 || 时 > 23 || 分 < 0 || 分 > 59) return null
  return { 时, 分 }
}

/**
 * 备份根目录：配置写了就用配置；留空就落到 <用户主目录>\dsh-session-backup。
 *
 * ⚠ 所有用到 `配置.目标目录` 的地方都必须经过这里，不能再直接拼 —— 否则
 *   「留空自动算」就只在一个地方生效，别处会拼出 undefined 路径。
 */
function 目标目录Of(配置) {
  if (typeof 配置.目标目录 === 'string' && 配置.目标目录.trim() !== '') return 配置.目标目录
  return join(homedir(), 'dsh-session-backup')
}

/** 生效后的配置（目标目录一定是个真路径）。凡是要落盘/算路径的地方都先过这一手。 */
function 归一配置(半份配置) {
  const 合 = { ...默认配置, ...(半份配置 && typeof 半份配置 === 'object' ? 半份配置 : {}) }
  合.目标目录 = 目标目录Of(合)
  return 合
}

function 源目录Of(配置) {
  if (typeof 配置.源目录 === 'string' && 配置.源目录.trim() !== '') return 配置.源目录
  const 家 = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(家, 'storages', 'session_projcache', 'sessions')
}

function 本体目录Of(配置) {
  if (typeof 配置.本体目录 === 'string' && 配置.本体目录.trim() !== '') return 配置.本体目录
  const 家 = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(家, 'sessions')
}

/** 索引（投影缓存）落在 <目标目录>\索引 */
function 索引目录Of(配置) {
  const 子 = typeof 配置.索引子目录 === 'string' && 配置.索引子目录.trim() !== '' ? 配置.索引子目录 : 默认配置.索引子目录
  return join(配置.目标目录, 子)
}

/** 应用状态（Cookies / Local Storage）落在 <目标目录>\应用状态 */
function 应用状态目录Of(配置) {
  if (typeof 配置.应用状态目录 === 'string' && 配置.应用状态目录.trim() !== '') return 配置.应用状态目录
  const 基 = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return join(基, '@deepseek-ai', 'dsh-desktop')
}

/**
 * 备份网页端的应用状态（Cookies、Local Storage 等）。
 * 这些文件在 DSH 跑着的时候是打开的，复制可能失败——失败就跳过，不拦着整轮备份。
 */
/**
 * 抄一个文件，专治「别人正开着」。
 *
 * ⚠ `Network\Cookies` 是 Chromium 的 SQLite，带**独占锁**：DSH 跑着的时候，
 *   `copyFile` / `CopyFileEx` / `robocopy` / `.NET FileStream` 全都会 EBUSY，
 *   连 `open(..., 'r')` 都打不开（2026-11-07 实测：6 秒内 40 次尝试 0 次成功，
 *   非管理员也没法走 SeBackupPrivilege / VSS）。这就是 cookie 一直备不上的真原因——
 *   不是路径写错，是**那个文件在这段时间里物理上读不了**。
 *
 *   能做的只有重试几把：万一正好撞上一个不持锁的瞬间就赚了。
 *   捞不到就如实记成「被占用」，别假装没事，也别拦着整轮备份。
 */
async function 抄一个文件(从, 到) {
  let 上次错误 = null
  for (let 次 = 0; 次 < 4; 次 += 1) {
    try {
      await copyFile(从, 到)
      return
    } catch (错误) {
      上次错误 = 错误
      const 码 = 错误 && 错误.code
      if (码 !== 'EBUSY' && 码 !== 'EPERM' && 码 !== 'EACCES') throw 错误
      // 被别的进程开着：歇一下再来，顺手给对方的写事务让路
      await new Promise((继续) => setTimeout(继续, 120 * (次 + 1)))
    }
  }
  throw 上次错误
}

/**
 * 备份网页端的应用状态（Cookies、Local Storage 等）。
 * 被独占的文件抄不动就记成 `skipped: 原因`，既不拦着整轮备份，也不假装备上了。
 */
async function 备份应用状态(配置, 目标根, 日期, 清单, 计数) {
  if (配置.备份应用状态 === false) return
  const 源 = 应用状态目录Of(配置)
  const 项们 = Array.isArray(配置.应用状态项) && 配置.应用状态项.length > 0 ? 配置.应用状态项 : 默认配置.应用状态项
  const 到根 = join(目标根, 日期)
  if (!Array.isArray(计数.被占用)) 计数.被占用 = []

  /** 记一条「没抄成」。以前这里只悄悄 跳过 += 1，主人都不知道 cookie 一直没备上。 */
  const 记没抄成 = (相对路径, 错误) => {
    const 码 = String((错误 && (错误.code || 错误.message)) || 错误)
    计数.跳过 += 1
    计数.被占用.push({ 文件: 相对路径, 原因: 码 })
    清单.push({ 文件: '应用状态/' + 日期 + '/' + 相对路径, 类型: '应用状态', 校验: 'skipped: ' + 码 })
  }

  for (const 相对 of 项们) {
    const 从 = join(源, 相对)
    let 信息
    try {
      信息 = await stat(从)
    } catch {
      continue // 没有这项（比如没开过网页端）就跳过
    }

    if (信息.isDirectory()) {
      const 到目录 = join(到根, 相对)
      let 文件们 = []
      try {
        await mkdir(到目录, { recursive: true })
        文件们 = await readdir(从, { withFileTypes: true })
      } catch (错误) {
        记没抄成(相对, 错误)
        continue
      }
      for (const f of 文件们) {
        if (!f.isFile()) continue
        try {
          await 抄一个文件(join(从, f.name), join(到目录, f.name))
          计数.成功 += 1
        } catch (错误) {
          // leveldb 的 .log/.ldb 也常年被占着，正常；但得记下来
          记没抄成(相对 + '/' + f.name, 错误)
        }
      }
      continue
    }

    const 到 = join(到根, 相对)
    try {
      await mkdir(dirname(到), { recursive: true })
      await 抄一个文件(从, 到)
      const 后 = await stat(到)
      const 一致 = 信息.size === 后.size
      清单.push({
        文件: '应用状态/' + 日期 + '/' + 相对,
        类型: '应用状态',
        源字节: 信息.size,
        备份字节: 后.size,
        修改时间: 信息.mtime.toISOString(),
        校验: 一致 ? 'ok' : 'size-mismatch',
      })
      计数.成功 += 1
    } catch (错误) {
      记没抄成(相对, 错误)
    }
  }
}

/**
 * 退出前的最后一把：把「活着的时候读不了」的文件补抄一份。
 *
 * Cookies 只在 Chromium 关掉网络服务之后才可能被读到，那个时刻就在进程退出前后。
 * 所以挂 `process.on('exit')`，用**同步** API 抄（这时 await 已经不会有结果了）。
 * 抄到算赚的，抄不到什么都不影响；结果追加到 plugin.log，下次开机就能看见有没有成。
 *
 * ⚠ 这是尽力而为，不保证：Electron 退出时网络服务可能比这个钩子还晚松手。
 *   真要一份确定能用的 cookie，就关掉 DSH 再跑 `node backup-now.mjs`。
 */
function 退出补抄(配置) {
  try {
    const 源 = 应用状态目录Of(配置)
    const 项们 = Array.isArray(配置.应用状态项) && 配置.应用状态项.length > 0 ? 配置.应用状态项 : 默认配置.应用状态项
    const 日期 = 本地日期()
    const 到根 = join(配置.目标目录, '应用状态', 日期)
    const 结果 = []
    for (const 相对 of 项们) {
      const 从 = join(源, 相对)
      let 信息
      try {
        信息 = statSync(从)
      } catch {
        continue // 没有这项
      }
      if (!信息.isFile()) continue // 目录（Local Storage / logs）留到下一轮正常备份，退出时别展开
      try {
        const 到 = join(到根, 相对)
        mkdirSync(dirname(到), { recursive: true })
        copyFileSync(从, 到)
        结果.push('✔ ' + 相对 + ' ' + 信息.size + 'B')
      } catch (错误) {
        结果.push('✘ ' + 相对 + ' ' + String((错误 && (错误.code || 错误.message)) || 错误))
      }
    }
    if (结果.length === 0) return
    mkdirSync(配置.目标目录, { recursive: true })
    appendFileSync(join(配置.目标目录, 'plugin.log'), `[${new Date().toISOString()}] 退出补抄 ${结果.join(' · ')}\n`, 'utf8')
  } catch {
    // 退出钩子里绝不能抛：那会变成退出异常
  }
}

/** 会话本体落在 <目标目录>\会话 */
function 会话目录Of(配置) {
  const 子 = typeof 配置.会话子目录 === 'string' && 配置.会话子目录.trim() !== '' ? 配置.会话子目录 : 默认配置.会话子目录
  return join(配置.目标目录, 子)
}

/**
 * 目录名解码：`--D-my~0020project--` → `D:\my project`。
 * 备份目录名是 DSH 把工作区路径转义后的形态（空格变 ~0020，分隔符变 -）。
 */
function 解路径(目录名) {
  if (typeof 目录名 !== 'string' || !目录名.startsWith('--') || !目录名.endsWith('--')) return ''
  let 内 = 目录名.slice(2, -2)
  内 = 内.replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  内 = 内.replace(/-/g, '\\')
  if (内.length >= 2) 内 = 内[0] + ':' + 内.slice(1)
  return 内
}

/** 文件夹名净化：去掉 Windows 不认的字符，避免建目录失败。 */
function 净化名(名) {
  const 干净 = String(名 || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()
  return 干净 === '' ? '未命名工作区' : 干净
}

/** 读 workspace.json，拿到「路径 → 标题」，用来给备份目录起人能看懂的名字。 */
async function 读工作区表() {
  const 家 = process.env.DSH_HOME || join(homedir(), '.dsh')
  const 文件 = join(家, 'storages', 'workspace.json')
  const 表 = new Map()
  try {
    const 原文 = await readFile(文件, 'utf8')
    const json = JSON.parse(原文)
    const 们 = json && json.tables && json.tables.workspaces ? json.tables.workspaces : {}
    for (const id of Object.keys(们)) {
      const 项 = 们[id]
      if (!项 || !项.path) continue
      const 键 = String(项.path).replace(/[\\/]+$/, '')
      表.set(键.toLowerCase(), { 标题: 项.title || '', 路径: 键 })
    }
  } catch {
    // 读不到就用目录名当标题，不影响备份
  }
  return 表
}

// ---------------------------------------------------------------- 干活

/** 追加一行到 <目标目录>/backup.log；写不进去也不影响备份本身。 */
async function 记文件日志(配置, 文本) {
  try {
    await mkdir(配置.目标目录, { recursive: true })
    await appendFile(join(配置.目标目录, 'backup.log'), `[${new Date().toISOString()}] ${文本}\n`, 'utf8')
  } catch {
    // 日志写失败是小事，不往外抛
  }
}

/**
 * 诊断日志：`<目标目录>\plugin.log`。
 *
 * backup.log 记的是**流水**（这轮备了几个文件），这里记的是**原因**：
 * 加载了什么配置、面板接口挂上没有、哪个请求被拒了、网页那边报了什么错。
 * 只靠流水是查不出问题的 —— 2026-11-07 两次翻车（冷启动接口全 404、
 * 面板渲染抛错白屏）在 backup.log 里一个字都没有，最后是靠猜和翻代码找的。
 *
 * 只留一代：超过 2MB 就挪成 `plugin.log.1`，再超就覆盖。诊断日志看的是最近的，
 * 不需要考古，也不该让它在备份目录里悄悄长成几十兆。
 */
async function 记诊断(配置, 级别, 文本) {
  try {
    const 根 = 配置.目标目录
    await mkdir(根, { recursive: true })
    const 文件 = join(根, 'plugin.log')
    try {
      const 信息 = await stat(文件)
      if (信息.size > 2 * 1024 * 1024) await rename(文件, join(根, 'plugin.log.1'))
    } catch {
      // 还没有这个文件，或者滚不动：照样往下写
    }
    await appendFile(文件, `[${new Date().toISOString()}] ${级别} ${文本}\n`, 'utf8')
  } catch {
    // 诊断日志自己写不进去，绝不能连累备份和接口
  }
}

/** 在备份根目录写一份人能看懂的说明：哪个目录对应哪个工作区。 */
async function 写说明文件(配置, 映射) {
  const 根 = 配置.目标目录
  try {
    await mkdir(根, { recursive: true })
    const 行 = []
    行.push('# 会话备份 · 目录说明')
    行.push('')
    行.push('这里是 `dsh-session-backup` 插件写的备份，**不在任何工作区里面**，')
    行.push('所以清工作区、搬家、删临时文件都不会伤到它。')
    行.push('')
    行.push('## 结构')
    行.push('')
    行.push('```')
    行.push(根)
    行.push('├── 索引\\          投影缓存（所有工作区放一起，按日期分）')
    行.push('│   └── YYYY-MM-DD\\*.json')
    行.push('├── 会话\\          会话本体（按工作区分目录，按日期分）')
    行.push('│   └── <工作区名>\\YYYY-MM-DD\\<会话ID>.zstd')
    行.push('├── 应用状态\\      网页端 Cookies / Local Storage / logs（按日期分）')
    行.push('├── 人设\\          人设卡所在的 profile 配置（按日期分）')
    行.push('│   └── YYYY-MM-DD\\cordis.patch.yml')
    行.push('├── 记忆\\          长期记忆（按日期分）')
    行.push('│   └── YYYY-MM-DD\\memory\\       soul-md 的卡记忆')
    行.push('│   └── YYYY-MM-DD\\fish-memory\\  remember 工具写的记忆')
    行.push('├── 手动\\          手动快照（别的脚本写的，插件不碰）')
    行.push('├── 音频归档\\      语音成品归档（别的脚本写的，插件不碰）')
    行.push('├── 隔离-孤儿会话\\ 从会话目录摘出来的孤儿（别的脚本写的，插件不碰）')
    行.push('├── backup.log     每轮一行流水')
    行.push('└── README.md      这个文件')
    行.push('```')
    行.push('')
    行.push('**索引**是渲染对话用的消息视图，体积小；**会话本体**才是真正的聊天记录，')
    行.push('丢了只能靠它。两份分开存，是为了坏一份还有另一份能对。')
    行.push('')
    行.push('**人设**备份的是 profile 的 `cordis.patch.yml`，人设卡的名称、内容、')
    行.push('默认卡和会话映射都在里面；**记忆**是灵魂，会话能从备份重建，记忆丢了就真没了。')
    行.push('')
    行.push('## 当前对应关系')
    行.push('')
    行.push('| 备份目录 | 原名 | 会话数 |')
    行.push('| --- | --- | --- |')
    for (const 条 of 映射) {
      行.push(`| 会话\\${条.工作区} | ${条.路径 || '（读不到原名）'} | ${条.会话数} |`)
    }
    if (映射.length === 0) 行.push('| （这一轮没备到会话本体） | | |')
    行.push('')
    行.push(`最后更新：${new Date().toISOString()}（写入自 ${配置.目标目录}）`)
    await writeFile(join(根, 'README.md'), 行.join('\n') + '\n', 'utf8')
  } catch {
    // 说明写不进去不影响备份本身
  }
}

/** 拍一版。返回一句人能看的结果。 */
/**
 * 人设与长期记忆。
 *   人设卡存在 profile 的 cordis.patch.yml（soul-md 的 cards/active/sessions），
 *   记忆分两处：soul-md 的 memory 目录（每张卡一个 md）和 fish-memory（remember 工具）。
 * 落 <目标目录>\人设\<日期>\ 和 <目标目录>\记忆\<日期>\<目录名>\。
 */
async function 备份人设与记忆(配置, 目标根, 日期, 清单, 计数) {
  const 家 = process.env.DSH_HOME || join(homedir(), '.dsh')

  if (配置.备份人设 !== false) {
    const 源 =
      typeof 配置.人设配置 === 'string' && 配置.人设配置.trim() !== ''
        ? 配置.人设配置
        : join(家, 'profiles', 'desktop', 'cordis.patch.yml')
    const 名 = basename(源)
    const 到目录 = join(目标根, '人设', 日期)
    try {
      const 前 = await stat(源)
      await mkdir(到目录, { recursive: true })
      const 到 = join(到目录, 名)
      // ⚠ 整个 cordis.patch.yml 会被备份（还会被推到网盘），里面可能有敏感配置
      //   （网盘账号密码、API key、QQ accessToken 等）。这里做一道**脱敏**：
      //   把「= 一串东西」的密码类行替换成 ***，备份出去的是去掉秘密的版本。
      //   真身要恢复时，本地 _backups 那份也在，但网盘上的不会带着明文密码。
      const 原文 = await readFile(源, 'utf8')
      // ⚠ YAML 行前有缩进空格（4 格），正则必须 `^\s*` 开头，不然一行都匹配不上。
      //   2026-11-11 就栽过一次：写的时候没带 \s*，令牌原样漏进了备份。
      const 脱敏后 = 原文
        .replace(/^\s*(网盘密码|网盘令牌|密码|accessToken|apiKey|token|Token|secret|Secret|密钥):\s*.*$/gm, '$1: \'***（已脱敏）\'')
      // 有没有真的动过（脱敏 vs 没脱敏）：动过 = 备份里是去秘密的版本，大小不一样是**正常**的
      const 有脱敏 = 脱敏后 !== 原文
      await writeFile(到, 脱敏后, 'utf8')
      const 后 = await stat(到)
      清单.push({
        文件: '人设/' + 日期 + '/' + 名,
        类型: '人设',
        源: 源,
        源字节: 前.size,
        备份字节: 后.size,
        // 脱敏了就是成功（备份里确实去掉了秘密）；没脱敏才看大小一致
        校验: 有脱敏 ? 'ok（已脱敏，大小不同是正常的）' : (前.size === 后.size ? 'ok' : 'size-mismatch'),
        MD5: await 算MD5(到),
        脱敏: 有脱敏,
      })
      计数.人设 += 1
    } catch (错误) {
      清单.push({ 文件: '人设/' + 日期 + '/' + 名, 类型: '人设', 源: 源, 校验: 'error: ' + String((错误 && 错误.message) || 错误) })
    }
  }

  if (配置.备份记忆 !== false) {
    const 目录表 =
      Array.isArray(配置.记忆目录) && 配置.记忆目录.length > 0
        ? 配置.记忆目录
        : [join(家, 'soul-md', 'memory'), join(家, 'fish-memory')]
    for (const 源 of 目录表) {
      const 名 = basename(源)
      try {
        const 前 = await stat(源)
        if (!前.isDirectory()) continue
      } catch {
        continue // 没这个目录就跳过
      }
      const 到目录 = join(目标根, '记忆', 日期, 名)
      try {
        await mkdir(到目录, { recursive: true })
        await cp(源, 到目录, { recursive: true, force: true })
        let 数 = 0
        try {
          数 = (await readdir(到目录, { recursive: true })).length
        } catch {
          // 数不出来不影响备份本身
        }
        清单.push({ 文件: '记忆/' + 日期 + '/' + 名 + '/', 类型: '记忆', 源: 源, 文件数: 数, 校验: 'ok' })
        计数.记忆 += 1
      } catch (错误) {
        清单.push({
          文件: '记忆/' + 日期 + '/' + 名 + '/',
          类型: '记忆',
          源: 源,
          校验: 'error: ' + String((错误 && 错误.message) || 错误),
        })
      }
    }
  }
}

async function 备份一次(配置, 原因) {
  const 源 = 源目录Of(配置)
  const 日期 = 本地日期()
  const 索引根 = 索引目录Of(配置)
  const 会话根备份 = 会话目录Of(配置)
  const 目标 = join(索引根, 日期)

  let 条目
  try {
    条目 = await readdir(源, { withFileTypes: true })
  } catch (错误) {
    const 话 = `读不了源目录 ${源}：${String((错误 && 错误.message) || 错误)}`
    await 记文件日志(配置, '失败 ' + 话)
    return { 成功: false, 话 }
  }

  const 模式 = Array.isArray(配置.会话文件) && 配置.会话文件.length > 0 ? 配置.会话文件 : 默认配置.会话文件
  const 命中 = 条目
    .filter((项) => 项.isFile() && 模式.some((单个) => 匹配(项.name, 单个)))
    .map((项) => 项.name)
    .sort()

  if (命中.length === 0) {
    const 话 = `源目录里没有匹配 ${模式.join('、')} 的文件（${源}）`
    await 记文件日志(配置, '跳过 ' + 话)
    return { 成功: false, 话 }
  }

  await mkdir(目标, { recursive: true })

  const 清单 = []
  let 坏了 = 0
  for (const 名 of 命中) {
    const 从 = join(源, 名)
    const 到 = join(目标, 名)
    try {
      const 前 = await stat(从)
      await copyFile(从, 到)
      const 后 = await stat(到)
      const 一致 = 前.size === 后.size
      if (!一致) 坏了 += 1
      清单.push({
        文件: 名,
        源字节: 前.size,
        备份字节: 后.size,
        修改时间: 前.mtime.toISOString(),
        校验: 一致 ? 'ok' : 'size-mismatch',
        MD5: 一致 ? await 算MD5(到) : null,
      })
    } catch (错误) {
      坏了 += 1
      清单.push({ 文件: 名, 校验: 'error: ' + String((错误 && 错误.message) || 错误) })
    }
  }

  // 会话本体：<本体目录>/<工作区编码>/<会话ID>/session.v4.jsonl.zstd
  //            → <目标目录>/会话/<工作区名>/<日期>/<会话ID>.zstd
  // 按工作区分目录，这样一眼看出哪份会话属于哪个工作区
  const 工作区表 = await 读工作区表()
  const 映射 = []
  if (配置.备份本体 !== false) {
    const 本体根 = 本体目录Of(配置)
    try {
      const 工作区们 = await readdir(本体根, { withFileTypes: true })
      for (const 工作区 of 工作区们) {
        if (!工作区.isDirectory()) continue
        const 工作区路径 = join(本体根, 工作区.name)
        let 会话们 = []
        try {
          会话们 = await readdir(工作区路径, { withFileTypes: true })
        } catch {
          continue
        }
        const 真实路径 = 解路径(工作区.name)
        const 记录 = 工作区表.get(真实路径.toLowerCase())
        const 显示名 = 净化名((记录 && 记录.标题) || (真实路径 ? 真实路径.split('\\').pop() : 工作区.name))
        const 本区目录 = join(会话根备份, 显示名, 日期)
        let 本区数 = 0
        for (const 会话 of 会话们) {
          if (!会话.isDirectory()) continue
          // 现找本体（v4 / v5 …），找不到就跳过这间会话
          const 从 = await 找本体文件(join(工作区路径, 会话.name))
          if (!从) continue
          let 前
          try {
            前 = await stat(从)
          } catch {
            continue
          }
          try {
            await mkdir(本区目录, { recursive: true })
            const 到 = join(本区目录, 会话.name + '.zstd')
            await copyFile(从, 到)
            const 后 = await stat(到)
            const 一致 = 前.size === 后.size
            if (!一致) 坏了 += 1
            本区数 += 1
            清单.push({
              文件: 显示名 + '/' + 日期 + '/' + 会话.name + '.zstd',
              类型: '本体',
              工作区: 显示名,
              工作区路径: 真实路径,
              会话: 会话.name,
              本体文件: basename(从),
              源字节: 前.size,
              备份字节: 后.size,
              修改时间: 前.mtime.toISOString(),
              校验: 一致 ? 'ok' : 'size-mismatch',
              MD5: 一致 ? await 算MD5(到) : null,
            })
          } catch (错误) {
            坏了 += 1
            清单.push({
              文件: 显示名 + '/' + 日期 + '/' + 会话.name + '.zstd',
              类型: '本体',
              工作区: 显示名,
              工作区路径: 真实路径,
              校验: 'error: ' + String((错误 && 错误.message) || 错误),
            })
          }
        }
        if (本区数 > 0) 映射.push({ 工作区: 显示名, 路径: 真实路径, 会话数: 本区数, 目录: join(会话根备份, 显示名) })
      }
    } catch {
      // 本体目录不在就只备索引，不拦着
    }
  }

  // 应用状态（Cookies / Local Storage）：满了或坏了会让网页端登不上
  const 应用状态根 = join(配置.目标目录, '应用状态')
  const 应用计数 = { 成功: 0, 跳过: 0, 被占用: [] }
  await 备份应用状态(配置, 应用状态根, 日期, 清单, 应用计数)
  // 被独占的文件单独说一声：不然又是一轮「看着成功、其实少了东西」。
  // Chrome 的 cookie 库一年到头都锁着，所以这行基本每轮都会出现，属于正常噪音。
  if (应用计数.被占用.length > 0) {
    const 名们 = 应用计数.被占用.map((条) => 条.文件 + '（' + 条.原因 + '）').join('、')
    await 记诊断(配置, 'WARN', `应用状态 ${应用计数.被占用.length} 个文件被独占没备上：${名们}`)
  }

  // 人设与长期记忆：丢了比会话丢了更难补
  const 附加计数 = { 人设: 0, 记忆: 0 }
  await 备份人设与记忆(配置, 配置.目标目录, 日期, 清单, 附加计数)

  const 总字节 = 清单.reduce((和, 条) => 和 + (条.备份字节 || 0), 0)
  const 汇总 = {
    时间: new Date().toISOString(),
    原因,
    源目录: 源,
    索引目录: 目标,
    会话根目录: 会话根备份,
    文件数: 清单.length,
    总字节,
    有问题: 坏了,
    应用状态: 应用计数,
    附加备份: 附加计数,
    工作区映射: 映射,
    文件: 清单,
  }
  try {
    await writeFile(join(目标, 'manifest.json'), JSON.stringify(汇总, null, 2), 'utf8')
  } catch {
    // 清单写不进去不影响会话本体已经在目标目录里
  }
  await 写说明文件(配置, 映射)

  const 话 =
    坏了 === 0
      ? `备份 ${清单.length} 个文件 / ${(总字节 / 1024 / 1024).toFixed(2)} MB → ${目标}（${原因}）`
      : `备份 ${清单.length} 个文件，其中 ${坏了} 个有问题，详见 ${join(目标, 'manifest.json')}（${原因}）`
  await 记文件日志(配置, (坏了 === 0 ? '成功 ' : '异常 ') + 话)
  return { 成功: 坏了 === 0, 话, 清单 }
}

/** 保留最近 N 天，更早的日期目录整个删掉（索引和会话本体两边都清）。 */
async function 清理旧备份(配置) {
  const 保留 = Math.max(1, Math.floor(Number(配置.保留天数) || 默认配置.保留天数))
  const 索引根 = 索引目录Of(配置)
  let 条目
  try {
    条目 = await readdir(索引根, { withFileTypes: true })
  } catch {
    return [] // 索引目录还不存在 = 还没备份过，没什么可清
  }
  const 日期目录 = 条目
    .filter((项) => 项.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(项.name))
    .map((项) => 项.name)
    .sort()
  const 保留的 = 日期目录.slice(-保留)
  const 删掉 = []
  for (const 名 of 日期目录) {
    if (保留的.includes(名)) continue
    try {
      await rm(join(索引根, 名), { recursive: true, force: true })
      删掉.push(名)
    } catch {
      // 删不动就算了，下次再清
    }
  }

  // 会话本体那边的日期目录也要清：<目标目录>\会话\<工作区>\<日期>
  const 会话根 = 会话目录Of(配置)
  let 工作区们 = []
  try {
    工作区们 = await readdir(会话根, { withFileTypes: true })
  } catch {
    工作区们 = []
  }
  for (const 区 of 工作区们) {
    if (!区.isDirectory()) continue
    const 区路径 = join(会话根, 区.name)
    let 日子们 = []
    try {
      日子们 = (await readdir(区路径, { withFileTypes: true }))
        .filter((项) => 项.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(项.name))
        .map((项) => 项.name)
        .sort()
    } catch {
      continue
    }
    for (const 名 of 日子们) {
      if (保留的.includes(名)) continue
      try {
        await rm(join(区路径, 名), { recursive: true, force: true })
        删掉.push(`${区.name}/${名}`)
      } catch {
        // 同上
      }
    }
  }

  // 应用状态那边同样按日期清
  const 应用根 = join(配置.目标目录, '应用状态')
  let 应用日子 = []
  try {
    应用日子 = (await readdir(应用根, { withFileTypes: true }))
      .filter((项) => 项.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(项.name))
      .map((项) => 项.name)
      .sort()
  } catch {
    应用日子 = []
  }
  for (const 名 of 应用日子) {
    if (保留的.includes(名)) continue
    try {
      await rm(join(应用根, 名), { recursive: true, force: true })
      删掉.push('应用状态/' + 名)
    } catch {
      // 同上
    }
  }

  // 人设 / 记忆 也按日期清
  for (const 根名 of ['人设', '记忆']) {
    const 根 = join(配置.目标目录, 根名)
    let 日子 = []
    try {
      日子 = (await readdir(根, { withFileTypes: true }))
        .filter((项) => 项.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(项.name))
        .map((项) => 项.name)
        .sort()
    } catch {
      日子 = []
    }
    for (const 名 of 日子) {
      if (保留的.includes(名)) continue
      try {
        await rm(join(根, 名), { recursive: true, force: true })
        删掉.push(根名 + '/' + 名)
      } catch {
        // 同上
      }
    }
  }

  if (删掉.length > 0) await 记文件日志(配置, `清理旧备份：${删掉.join('、')}`)
  return 删掉
}

/**
 * 归置收到的媒体 —— **已搬走**。
 *
 * ⚠ 2026-11-13 起这块功能属于 dsh-reply-jitter（`归置收到的图` / `媒体目录` /
 *   `归置最小年龄分钟` 都在那边配）。这里只留一个空壳：
 *   旧配置里还写着 `归置收到的图: true` 时不会因为函数消失而报错。
 *
 * 为什么搬走：这两件事的对象不是一类。备份插件管「把 DSH 的状态存下来」，
 * 而 QQ 收到的图片是**消息链路**上的东西，跟 reply-jitter 管的出站节奏是同一批对象。
 */
async function 归置收到的媒体() {
  return []
}

// ---------------------------------------------------------------- 网盘推送

/**
 * 网盘推送的最近一次结果（面板读这份）。
 *
 * ⚠ 2026-11-23 修：原来只在内存里，进程一重启就变成「还没推过」——
 *   面板会**说假话**（明明刚推了 297 个文件，重载后显示没推过）。
 *   现在落一份 `<目标目录>\网盘推送状态.json`，进程起来时读回来。
 */
let 网盘推送状态 = { 时间: '', 结果: '', 话: '', 文件数: 0, 字节: 0 }

function 状态文件(配置) {
  return join(配置.目标目录, '网盘推送状态.json')
}

/** 从磁盘读回上次推送结果（进程启动时调一次；读不到就当没推过）。 */
let 读回中的那次 = null
async function 读回推送状态(配置) {
  if (读回中的那次 !== null) return 读回中的那次
  读回中的那次 = (async () => {
    try {
      const 体 = JSON.parse(await readFile(状态文件(配置), 'utf8'))
      if (体 && typeof 体 === 'object' && typeof 体.时间 === 'string') {
        网盘推送状态 = {
          时间: 体.时间,
          结果: String(体.结果 || ''),
          话: String(体.话 || ''),
          文件数: Number(体.文件数) || 0,
          字节: Number(体.字节) || 0,
        }
      }
    } catch {
      // 还没推过 / 文件坏了：保持空状态，不影响任何功能
    }
  })()
  return 读回中的那次
}

/** 记下这次推送结果：内存 + 磁盘各一份（磁盘那份是给重启后的面板看的）。 */
async function 记推送状态(配置, 状态) {
  网盘推送状态 = 状态
  try {
    await mkdir(配置.目标目录, { recursive: true })
    await writeFile(状态文件(配置), JSON.stringify(状态, null, 2), 'utf8')
  } catch {
    // 写不进去只影响「重启后还记不记得」，不影响推送本身
  }
}

/**
 * OpenList API 的完整地址：<地址>/api/<端点>。
 * 认证用静态令牌（Authorization 头），绕开 2FA —— 这是程序上传的唯一正路。
 */
function 网盘API(配置, 端点) {
  const 地址 = String(配置.网盘地址 || 'http://127.0.0.1:5244').replace(/\/+$/, '')
  return 地址 + '/api/' + 端点
}

/** OpenList 请求头：令牌 + JSON。没有令牌就空着，反正会 401，日志写清楚。 */
function 网盘头(配置, json = false) {
  const 头 = {}
  if (配置.网盘令牌) 头.Authorization = String(配置.网盘令牌)
  if (json) 头['content-type'] = 'application/json'
  return 头
}

/** 远端完整路径：/网盘根目录/网盘子目录/<相对路径>（OpenList 的路径是 /存储名/... 形式）。 */
function 远端路径(配置, 相对路径) {
  const 根 = String(配置.网盘根目录 || '百度网盘').replace(/^\/+/, '').replace(/\/+$/, '')
  const 子 = String(配置.网盘子目录 || '').replace(/^\/+/, '').replace(/\/+$/, '')
  const 相对 = String(相对路径 || '').replace(/^\/+/, '')
  return '/' + 根 + (子 ? '/' + 子 : '') + (相对 ? '/' + 相对 : '')
}

/**
 * 确保远端目录存在（OpenList：POST /api/fs/mkdir，逐级建）。
 * 已存在会回 code 500（"storage not found" 或冲突）——但我们逐级建，
 * 建到已存在的目录就当「有了」继续。
 */
async function 确保远端目录(配置, 相对目录) {
  const 段们 = String(相对目录 || '').split('/').filter(Boolean)
  let 累计 = ''
  for (const 段 of 段们) {
    累计 = 累计 === '' ? 段 : 累计 + '/' + 段
    const 响应 = await fetch(网盘API(配置, 'fs/mkdir'), {
      method: 'POST',
      headers: 网盘头(配置, true),
      body: JSON.stringify({ path: 远端路径(配置, 累计) }),
      signal: AbortSignal.timeout((配置.网盘超时秒 || 30) * 1000),
    })
    const 体 = await 响应.json().catch(() => null)
    if (体 && (体.code === 200 || 体.code === 0)) continue // 建好了
    // code 500 通常是「已存在 / 路径问题」，先不抛，下一层 mkdir 会告诉我们真实情况
    if (体 && (体.code === 500 || 体.code === 400)) continue
    throw new Error(`mkdir ${累计} → ${体 ? (体.code + ' ' + 体.message) : ('HTTP ' + 响应.status)}`)
  }
}

/** 上传一个文件到远端 <相对路径>。失败抛错，调用方决定怎么记。 */
async function 上传一个(配置, 相对路径, 本地路径) {
  const 内容 = await readFile(本地路径)
  // ⚠ 百度网盘（以及其他几个大网盘）的上传接口**不收 0 字节空文件**（errno 2）。
  //    Cookies-journal、Trust Tokens-journal 这些就是空的，直接跳过，
  //    别让一个空文件把整轮推送拖成「部分失败」。
  //    返回 -1 表示「空文件跳过」（不算成功也不算失败）。
  if (内容.length === 0) return -1
  const 完整 = 远端路径(配置, 相对路径)
  const 响应 = await fetch(网盘API(配置, 'fs/put'), {
    method: 'PUT',
    headers: {
      ...网盘头(配置),
      'File-Path': encodeURIComponent(完整),
      Overwrite: 'true',
      'content-type': 'application/octet-stream',
    },
    body: 内容,
    signal: AbortSignal.timeout((配置.网盘超时秒 || 30) * 1000),
  })
  const 体 = await 响应.json().catch(() => null)
  if (体 && (体.code === 200 || 体.code === 0)) return 内容.length
  throw new Error(`上传 ${相对路径} → ${体 ? (体.code + ' ' + 体.message) : ('HTTP ' + 响应.status)}`)
}

/** 递归收一个目录下的文件（带绝对路径），深度封顶 8。 */
async function 收文件(根, 相对前缀 = '', 深度 = 0) {
  const 结果 = []
  if (深度 > 8) return 结果
  let 条目
  try {
    条目 = await readdir(根, { withFileTypes: true })
  } catch {
    return 结果
  }
  for (const 项 of 条目) {
    const 相对 = 相对前缀 === '' ? 项.name : 相对前缀 + '/' + 项.name
    if (项.isDirectory()) {
      结果.push(...(await 收文件(join(根, 项.name), 相对, 深度 + 1)))
    } else if (项.isFile()) {
      结果.push({ 相对, 绝对: join(根, 项.name) })
    }
  }
  return 结果
}

/**
 * 把当天的备份推到网盘。
 *
 * 结构照本地：<网盘根>/<日期>/索引|会话|应用状态|人设|记忆/...
 * 会话层还多一层工作区名。失败的文件记下来，不中断整轮 ——
 * 网盘推送是「额外保险」，不能反过来把备份本身拖垮。
 * 推完把结果写进 plugin.log（成功/失败都要写，面板才有得看）。
 */
/** 把当天的备份推到网盘（测试脚本也走这条）。 */
export async function 推送当天备份(配置, 日期 = 本地日期()) {
  const 目标 = 配置.目标目录
  const 开始 = Date.now()
  let 文件数 = 0
  let 字节 = 0
  let 跳过空 = 0
  const 失败 = []

  // 五层一起推：索引 / 会话（按工作区分）/ 应用状态 / 人设 / 记忆
  const 层们 = ['索引', '会话', '应用状态', '人设', '记忆']
  for (const 层 of 层们) {
    const 本地层 = join(目标, 层)
    let 文件们 = []
    try {
      文件们 = await 收文件(本地层, '', 0)
    } catch {
      continue // 这层还没备过，跳过
    }
    for (const 文件 of 文件们) {
      // 只推今天的；会话层是 <工作区>/<日期>/，索引等是 <日期>/
      const 相对 = 文件.相对.replace(/\\/g, '/')
      const 段们 = 相对.split('/')
      // 找日期段：索引/应用状态/人设/记忆 的第一段就是日期；会话层是第二段
      const 日期段 = 层 === '会话' ? 段们[1] : 段们[0]
      if (日期段 !== 日期) continue
      // 远端路径：<日期>/<层>/<去掉日期段之后的相对路径>
      // 会话层结构是 <工作区>/<日期>/<文件>：日期是第二段，工作区第一段要保留
      const 远端相对 = 层 === '会话'
        ? 日期 + '/' + 层 + '/' + 段们[0] + '/' + 段们.slice(2).join('/')
        : 日期 + '/' + 层 + '/' + 段们.slice(1).join('/')
      try {
        await 确保远端目录(配置, 远端相对.replace(/\/[^/]+$/, ''))
        const 大小 = await 上传一个(配置, 远端相对, 文件.绝对)
        // -1 = 空文件跳过：不计入「成功文件数」，免得日志说 131 个其实只传了 130
        if (大小 === -1) {
          跳过空 += 1
        } else {
          文件数 += 1
          字节 += 大小
        }
      } catch (错误) {
        失败.push(远端相对 + '（' + String((错误 && 错误.message) || 错误) + '）')
      }
    }
  }

  const 耗时 = ((Date.now() - 开始) / 1000).toFixed(1)
  const 跳过说明 = 跳过空 > 0 ? `（另有 ${跳过空} 个空文件跳过）` : ''
  const 话 = 失败.length === 0
    ? `推送 ${文件数} 个文件 / ${(字节 / 1024 / 1024).toFixed(2)} MB → ${配置.网盘地址}${远端路径(配置, 日期)}${跳过说明}（${耗时}s）`
    : `推送 ${文件数} 个文件，失败 ${失败.length} 个：${失败.slice(0, 5).join('、')}${跳过说明}（${耗时}s）`
  await 记推送状态(配置, { 时间: new Date().toISOString(), 结果: 失败.length === 0 ? '成功' : '部分失败', 话, 文件数, 字节 })
  await 记诊断(配置, 失败.length === 0 ? 'INFO' : 'WARN', '网盘推送 ' + 话)
  return { 成功: 失败.length === 0, 话, 文件数, 字节, 失败 }
}

// ---------------------------------------------------------------- 离线备份脚本（装到本机）
//
// 要解决的那件事：`Network\Cookies` 是 Chromium 的 SQLite，DSH **跑着的时候
// 独占锁死**（2026-11-23 实测：copyFile / CopyFileEx / robocopy / .NET
// FileStream 连 Share.ReadWrite 强开都 EBUSY；非管理员没有 SeBackupPrivilege，
// 也没有 VSS）。所以不管插件多努力，cookie 都只能在 DSH 停下来之后才抄得到。
//
// 光靠 `process.on('exit')` 勾不住：13 天里只触发过 1 次（11-11），那次 cookie
// 还是 EBUSY。Electron 退出时会直接把进程收掉，JS 钩子经常来不及。
//
// 所以给一条**用户点得动**的路：装一个本地脚本，它做三件事 ——
//   1) 结束 DSH（等它真退干净，不是发个信号就走）
//   2) 在"没人占着"的状态下跑一轮完整备份（这时 Cookies 一定抄得到）
//   3) 再把 DSH 打开
// 用户只需要双击一下。
//
// 脚本是**自包含**的：把我们需要的逻辑（配置 + 抄文件的几个函数）内联进去，
// 不 import 插件包。理由很实在 —— 插件升级/搬家/被卸载之后，桌面那个双击
// 还得能用；靠 import 一条路径迟早因为包挪位而断。

/** 生成脚本时要用到的路径信息（全部来自当前这台机器，不写死别人的）。 */
function 本机路径(配置) {
  return {
    node: process.execPath,
    插件目录: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    目标目录: 目标目录Of(配置),
    应用状态目录: 应用状态目录Of(配置),
  }
}

/** 把配置里"这台机器的事实"取出来给脚本用（脚本不读 profile，避免版本差异）。 */
function 脚本用配置(配置) {
  const 项们 = Array.isArray(配置.应用状态项) && 配置.应用状态项.length > 0 ? 配置.应用状态项 : 默认配置.应用状态项
  return {
    目标目录: 目标目录Of(配置),
    源目录: 源目录Of(配置),
    本体目录: 本体目录Of(配置),
    应用状态目录: 应用状态目录Of(配置),
    应用状态项: 项们,
    会话文件: Array.isArray(配置.会话文件) && 配置.会话文件.length > 0 ? 配置.会话文件 : 默认配置.会话文件,
    保留天数: Math.max(1, Math.floor(Number(配置.保留天数) || 默认配置.保留天数)),
    备份本体: 配置.备份本体 !== false,
    备份应用状态: 配置.备份应用状态 !== false,
    备份人设: 配置.备份人设 !== false,
    备份记忆: 配置.备份记忆 !== false,
    人设配置:
      typeof 配置.人设配置 === 'string' && 配置.人设配置.trim() !== ''
        ? 配置.人设配置
        : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'desktop', 'cordis.patch.yml'),
    记忆目录:
      Array.isArray(配置.记忆目录) && 配置.记忆目录.length > 0
        ? 配置.记忆目录
        : [
            join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'soul-md', 'memory'),
            join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'fish-memory'),
          ],
    索引子目录: typeof 配置.索引子目录 === 'string' && 配置.索引子目录.trim() !== '' ? 配置.索引子目录 : 默认配置.索引子目录,
    会话子目录: typeof 配置.会话子目录 === 'string' && 配置.会话子目录.trim() !== '' ? 配置.会话子目录 : 默认配置.会话子目录,
  }
}

/**
 * 脚本正文。写成 `.mjs`，用 DSH 自带的 node 跑（那台机器上一定有）。
 *
 * ⚠ 这里内联了备份逻辑，是**故意的**：脚本要能在插件被卸载、被搬家、
 *   被升级之后照样工作。代价是两份代码，所以只内联"抄文件"这一层 ——
 *   它稳定（就是 readdir + copyFile + stat），不跟着面板/网盘那些改。
 */
function 生成离线脚本正文(资料) {
  const 配置JSON = JSON.stringify(资料.配置, null, 2)
  return `// DSH 离线备份 —— 由插件生成，别手改（要改就重新点「安装手动备份脚本」）。
//
// 为什么需要这个：DSH 跑着的时候 Network\\Cookies 是独占锁的，插件抄不到。
// 这个脚本会：结束 DSH → 等它真退干净 → 备份 → 再把 DSH 打开。
//
// 生成于 ${new Date().toISOString()}
import { readdir, copyFile, stat, mkdir, writeFile, appendFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const 跑 = promisify(execFile)

const 配置 = ${配置JSON}

const DSH_进程名 = ${JSON.stringify(资料.进程名)}
const DSH_可执行文件 = ${JSON.stringify(资料.可执行文件)}
const 等退出秒 = ${资料.等退出秒}

const 说 = (话) => { console.log(话) }
const 分隔 = () => 说('─'.repeat(52))

/** 本地日期 YYYY-MM-DD */
function 日期() {
  const d = new Date()
  const 补 = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + 补(d.getMonth() + 1) + '-' + 补(d.getDate())
}

/** DSH 还在跑吗（按进程名找，Windows 上进程名带空格是正常的）。 */
async function DSH在运行() {
  try {
    const { stdout } = await 跑('tasklist', ['/FI', 'IMAGENAME eq ' + DSH_进程名, '/NH', '/FO', 'CSV'])
    return stdout.includes(DSH_进程名)
  } catch {
    return false
  }
}

async function 等DSH退出(最多秒) {
  const 起 = Date.now()
  while (Date.now() - 起 < 最多秒 * 1000) {
    if (!(await DSH在运行())) return true
    await new Promise((继续) => setTimeout(继续, 700))
  }
  return !(await DSH在运行())
}

/** 抄一个文件，撞上独占就重试几把（DSH 刚关那会儿锁可能还没松）。 */
async function 抄(从, 到) {
  for (let 次 = 0; 次 < 8; 次 += 1) {
    try {
      await copyFile(从, 到)
      return true
    } catch (错误) {
      const 码 = 错误 && 错误.code
      if (码 !== 'EBUSY' && 码 !== 'EPERM' && 码 !== 'EACCES') throw 错误
      await new Promise((继续) => setTimeout(继续, 250 * (次 + 1)))
    }
  }
  return false
}

function 匹配(名称, 模式) {
  let 转义 = ''
  for (const 字 of 模式) {
    if (字 === '*') 转义 += '.*'
    else if (字 === '?') 转义 += '.'
    else 转义 += 字.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')
  }
  return new RegExp('^' + 转义 + '$').test(名称)
}

async function 找本体(会话目录) {
  let 名单 = []
  try { 名单 = await readdir(会话目录) } catch { return null }
  const 命中 = 名单
    .filter((f) => /^session\\.v\\d+\\.jsonl\\.zstd$/.test(f))
    .sort((a, b) => Number(a.match(/v(\\d+)/)[1]) - Number(b.match(/v(\\d+)/)[1]))
  return 命中.length ? join(会话目录, 命中[命中.length - 1]) : null
}

async function 备份() {
  const 日 = 日期()
  const 结果 = { 成功: 0, 跳过: [], 有问题: [] }

  // ---- 索引 ----
  const 索引到 = join(配置.目标目录, 配置.索引子目录, 日)
  try {
    const 条目 = await readdir(配置.源目录, { withFileTypes: true })
    const 命中 = 条目.filter((项) => 项.isFile() && 配置.会话文件.some((m) => 匹配(项.name, m))).map((项) => 项.name)
    await mkdir(索引到, { recursive: true })
    for (const 名 of 命中) {
      try {
        await copyFile(join(配置.源目录, 名), join(索引到, 名))
        结果.成功 += 1
      } catch (e) { 结果.有问题.push('索引/' + 名 + ' ' + (e.code || e.message)) }
    }
    说('  索引    ' + 命中.length + ' 个')
  } catch (e) { 说('  索引    跳过（' + (e.code || e.message) + '）') }

  // ---- 会话本体 ----
  if (配置.备份本体) {
    let 数 = 0
    try {
      for (const 区 of await readdir(配置.本体目录, { withFileTypes: true })) {
        if (!区.isDirectory()) continue
        const 区路径 = join(配置.本体目录, 区.name)
        for (const 会话 of await readdir(区路径, { withFileTypes: true })) {
          if (!会话.isDirectory()) continue
          const 从 = await 找本体(join(区路径, 会话.name))
          if (!从) continue
          const 到目录 = join(配置.目标目录, 配置.会话子目录, 区.name, 日)
          await mkdir(到目录, { recursive: true })
          try {
            await copyFile(从, join(到目录, 会话.name + '.zstd'))
            结果.成功 += 1
            数 += 1
          } catch (e) { 结果.有问题.push('会话/' + 会话.name + ' ' + (e.code || e.message)) }
        }
      }
      说('  会话本体 ' + 数 + ' 个')
    } catch { 说('  会话本体 跳过（读不到本体目录）') }
  }

  // ---- 应用状态（Cookie 就在这一步，DSH 已关，这次一定抄得到）----
  if (配置.备份应用状态) {
    const 到根 = join(配置.目标目录, '应用状态', 日)
    let 好 = 0
    for (const 相对 of 配置.应用状态项) {
      const 从 = join(配置.应用状态目录, 相对)
      let 信息
      try { 信息 = await stat(从) } catch { continue }
      if (信息.isDirectory()) {
        const 到目录 = join(到根, 相对)
        await mkdir(到目录, { recursive: true })
        for (const f of await readdir(从, { withFileTypes: true })) {
          if (!f.isFile()) continue
          if (await 抄(join(从, f.name), join(到目录, f.name))) { 结果.成功 += 1; 好 += 1 }
          else 结果.跳过.push(相对 + '/' + f.name)
        }
      } else {
        await mkdir(dirname(join(到根, 相对)), { recursive: true })
        if (await 抄(从, join(到根, 相对))) { 结果.成功 += 1; 好 += 1 }
        else 结果.跳过.push(相对)
      }
    }
    说('  应用状态 ' + 好 + ' 个' + (结果.跳过.length ? '（跳过 ' + 结果.跳过.length + '）' : ''))
  }

  // ---- 人设 ----
  if (配置.备份人设) {
    try {
      const 到目录 = join(配置.目标目录, '人设', 日)
      await mkdir(到目录, { recursive: true })
      const 原文 = await readFile(配置.人设配置, 'utf8')
      const 脱敏 = 原文.replace(/^\\s*(网盘密码|网盘令牌|密码|accessToken|apiKey|token|Token|secret|Secret|密钥):\\s*.*$/gm, "$1: '***（已脱敏）'")
      await writeFile(join(到目录, basename(配置.人设配置)), 脱敏, 'utf8')
      结果.成功 += 1
      说('  人设    1 个（已脱敏）')
    } catch (e) { 说('  人设    跳过（' + (e.code || e.message) + '）') }
  }

  // ---- 记忆 ----
  if (配置.备份记忆) {
    let 数 = 0
    for (const 源 of 配置.记忆目录) {
      if (!existsSync(源)) continue
      const 到目录 = join(配置.目标目录, '记忆', 日, basename(源))
      try {
        await mkdir(到目录, { recursive: true })
        for (const f of await readdir(源, { withFileTypes: true })) {
          if (!f.isFile()) continue
          if (await 抄(join(源, f.name), join(到目录, f.name))) { 结果.成功 += 1; 数 += 1 }
        }
      } catch { /* 这份记忆读不到就算了 */ }
    }
    说('  记忆    ' + 数 + ' 个')
  }

  return 结果
}

async function main() {
  分隔()
  说('DSH 离线备份')
  分隔()

  const 原本在跑 = await DSH在运行()

  if (原本在跑) {
    说('DSH 正在运行 —— 要先关掉它，cookie 才抄得到。')
    说('  正在结束 DSH…')
    try {
      await 跑('taskkill', ['/IM', DSH_进程名, '/T'])
    } catch {
      // taskkill 对"已经没了"会返回非 0，不是错
    }
    if (!(await 等DSH退出(等退出秒))) {
      说('')
      说('⚠ 等了 ' + 等退出秒 + ' 秒 DSH 还没退干净。')
      说('  强杀一次…')
      try { await 跑('taskkill', ['/IM', DSH_进程名, '/T', '/F']) } catch {}
      if (!(await 等DSH退出(20))) {
        说('')
        说('✘ DSH 还在。请在任务管理器里手动结束它，再跑一次这个脚本。')
        说('  （备份没做，什么都没动）')
        process.exit(1)
      }
    }
    说('  DSH 已退出。')
  } else {
    说('DSH 没在跑，直接开始备份。')
  }

  // 锁松手需要一点点时间；直接抄大概率撞 EBUSY
  await new Promise((继续) => setTimeout(继续, 1200))

  说('')
  说('开始备份…')
  const 结果 = await 备份()

  分隔()
  说('备份完成：' + 结果.成功 + ' 个文件')
  说('  落到 ' + join(配置.目标目录, '应用状态', 日期()))
  if (结果.跳过.length > 0) {
    说('')
    说('⚠ 还有 ' + 结果.跳过.length + ' 个没抄下来：')
    for (const 项 of 结果.跳过.slice(0, 8)) 说('  · ' + 项)
  } else if (配置.备份应用状态) {
    说('  Cookies 这次应该是拿到了（没有任何文件被跳过）。')
  }
  if (结果.有问题.length > 0) {
    说('')
    说('有 ' + 结果.有问题.length + ' 个出错：')
    for (const 项 of 结果.有问题.slice(0, 8)) 说('  · ' + 项)
  }

  // 收个尾：往插件日志里记一笔，面板和 plugin.log 都能看见
  try {
    await mkdir(配置.目标目录, { recursive: true })
    const 行 = '[' + new Date().toISOString() + '] 离线备份 ' + 结果.成功 + ' 个文件' +
      (结果.跳过.length ? '，跳过 ' + 结果.跳过.length : '') +
      (结果.有问题.length ? '，出错 ' + 结果.有问题.length : '') + '\\n'
    await appendFile(join(配置.目标目录, 'plugin.log'), 行, 'utf8')
    await appendFile(join(配置.目标目录, 'backup.log'), 行, 'utf8')
  } catch { /* 日志写不进去不影响备份 */ }

  // 把 DSH 开回来（本来是开着的才开；用户自己关的就不擅自开）
  if (原本在跑) {
    说('')
    说('把 DSH 打开…')
    try {
      const 子 = spawn(DSH_可执行文件, [], { detached: true, stdio: 'ignore' })
      子.unref()
      说('  已启动。')
    } catch (e) {
      说('  启动失败：' + (e.message || e))
      说('  手动双击桌面上的 DeepSeek Harness 就行。')
    }
  }

  分隔()
  说('按任意键关闭这个窗口…')
  process.stdin.resume()
  process.stdin.once('data', () => process.exit(结果.有问题.length === 0 ? 0 : 1))
  // 没人按键也别挂着：5 分钟后自己退
  setTimeout(() => process.exit(结果.有问题.length === 0 ? 0 : 1), 300_000)
}

main().catch((错误) => {
  console.error('')
  console.error('出错了：' + (错误 && 错误.stack ? 错误.stack : 错误))
  console.error('')
  console.error('备份可能没做完。DSH 要是没开，手动打开一下。')
  process.stdin.resume()
  process.stdin.once('data', () => process.exit(1))
  setTimeout(() => process.exit(1), 300_000)
})
`
}

/**
 * 找一台机器上「跑脚本用」的 node。
 *
 * ⚠ 这里不能直接用 `process.execPath`：DSH 桌面版是 Electron，插件跑在主进程里，
 *   `process.execPath` 指向 **`DeepSeek Harness.exe`**（不是 node），拿它跑 .mjs
 *   会变成"又开一个 DSH"。本机实测：`D:\Code\node.js\node.exe` 是 shell 里的，
 *   跟用户装没装 node 无关 —— 所以优先用 **DSH 自带**那份，那台机器上一定存在。
 */
function 找node() {
  const 候选 = []

  // 1) 最靠得住的一条：Electron 的 process.resourcesPath 直接就是 …\resources
  //    桌面版里它一定在，而且不管装在 C 盘还是 D 盘、装成便携版还是安装版都对。
  const 资源 = process.resourcesPath
  if (typeof 资源 === 'string' && 资源 !== '') {
    候选.push(join(资源, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'))
    候选.push(join(资源, 'runtime', 'bin', 'node.exe'))
  }

  // 2) 从 exe 往上走几层再拼 —— 兜住 resourcesPath 拿不到的场合
  const exe = process.execPath
  const 是DSH = exe.toLowerCase().endsWith('deepseek harness.exe')
  if (是DSH) {
    let 层 = dirname(exe)
    for (let i = 0; i < 4; i += 1) {
      候选.push(join(层, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'))
      候选.push(join(层, 'resources', 'runtime', 'bin', 'node.exe'))
      候选.push(join(层, 'AHa', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'))
      const 上 = dirname(层)
      if (上 === 层) break
      层 = 上
    }
  } else {
    // 3) 真是 node 在跑（脚本 / CI / 开发模式）就用它自己
    候选.push(exe)
  }

  for (const 试 of 候选) {
    if (existsSync(试)) return 试
  }
  // 4) 最后的兜底：PATH 里的 node（用户自己装过就有）
  return 'node'
}

/** 找 DSH 主程序（离线脚本备份完要把用户原来的 DSH 开回来）。 */
function 找DSH() {
  const exe = process.execPath
  if (exe.toLowerCase().endsWith('deepseek harness.exe')) return exe
  const 候选 = [
    'D:\\Deepseek Harness\\AHa\\DeepSeek Harness.exe',
    join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    join(process.env.PROGRAMFILES || '', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
  ]
  for (const 试 of 候选) if (试 !== '' && existsSync(试)) return 试
  return ''
}

/**
 * 装离线备份脚本，并（Windows）配一个双击就能跑的 .cmd。
 *
 * 装哪儿：`<目标目录>\离线备份\` —— 跟着备份根走，这样"备份在哪、脚本在哪"
 * 是一句话能说清的事；也不会因为插件升级而消失。
 */
export async function 安装离线脚本(配置) {
  const 目录 = join(目标目录Of(配置), '离线备份')
  await mkdir(目录, { recursive: true })

  const 资料 = {
    配置: 脚本用配置(配置),
    进程名: 'DeepSeek Harness.exe',
    可执行文件: 找DSH(),
    等退出秒: Math.max(10, Math.min(120, Math.floor(Number(配置.等退出秒) || 45))),
  }

  const 脚本 = join(目录, '离线备份.mjs')
  await writeFile(脚本, 生成离线脚本正文(资料), 'utf8')

  const node = 找node()
  const 结果 = { 目录, 脚本, 启动器: '', node, DSH: 资料.可执行文件 }
  if (platform() === 'win32') {
    const 启动器 = join(目录, '双击我-离线备份.cmd')
    const 正文 = [
      '@echo off',
      'chcp 65001 >nul',
      'title DSH 离线备份',
      `"${node}" "${脚本}"`,
      'if errorlevel 1 pause',
      '',
    ].join('\r\n')
    await writeFile(启动器, 正文, 'utf8')
    结果.启动器 = 启动器
  }

  return 结果
}

/** 已装的离线脚本信息（面板用来显示"装了没、在哪"）。 */
export async function 查离线脚本(配置) {
  const 目录 = join(目标目录Of(配置), '离线备份')
  const 脚本 = join(目录, '离线备份.mjs')
  const 启动器 = join(目录, '双击我-离线备份.cmd')
  let 时间 = ''
  try {
    时间 = (await stat(脚本)).mtime.toISOString()
  } catch {
    // 没装
  }
  return {
    已装: 时间 !== '',
    目录,
    脚本: 时间 !== '' ? 脚本 : '',
    启动器: existsSync(启动器) ? 启动器 : '',
    时间,
  }
}

// ---------------------------------------------------------------- 网盘设置的读写（网页表单用）
//
// 2026-11-23 加：以前改网盘必须手改 profile 的 cordis.patch.yml，写错一个缩进
// 就整插件不加载。现在插件页面里有一栏表单，存盘走的是宿主的 configEditor 服务
// —— 它是**唯一**正确的写入路径：会校验、会与别的 profile 改动串行、会走正常
// 的热重载，而不是自己拿正则去改用户的文件（那样会吃掉注释和 !!js 表达式）。

/** 表单能看到的当前值。令牌/密码**只报「配没配」和尾号**，绝不回明文。 */
export function 网盘配置视图(配置) {
  const 令牌 = String(配置.网盘令牌 || '')
  const 密码 = String(配置.网盘密码 || '')
  return {
    推送网盘: 配置.推送网盘 === true,
    网盘协议: String(配置.网盘协议 || 'openlist'),
    网盘地址: String(配置.网盘地址 || ''),
    网盘根目录: String(配置.网盘根目录 || ''),
    网盘子目录: String(配置.网盘子目录 || ''),
    网盘用户名: String(配置.网盘用户名 || ''),
    网盘保留天数: Math.max(0, Math.floor(Number(配置.网盘保留天数) || 0)),
    网盘超时秒: Math.max(5, Math.floor(Number(配置.网盘超时秒) || 30)),
    令牌已配置: 令牌 !== '',
    令牌尾巴: 令牌 === '' ? '' : 令牌.slice(-6),
    密码已配置: 密码 !== '',
    上次: 网盘推送状态,
  }
}

const 合法协议 = ['openlist', 'webdav']

/**
 * 把表单提交上来的那几项并进当前配置并存盘。
 *
 * 三条规矩：
 *   1) 只认白名单字段，别的（比如 目标目录、保留天数）一律不碰 ——
 *      表单只负责网盘，别的一改就可能把用户的备份路径弄丢。
 *   2) 令牌/密码留空 = **不改**；要真清掉得显式传 清空令牌 / 清空密码。
 *      这样「只改个地址」不会顺手把令牌抹了。
 *   3) 存盘前后都做一遍类型/取值校验，宁可报错也不写坏一份配置。
 */
async function 保存网盘配置(ctx, 当前配置, 体) {  const 入口 = ctx.fiber && ctx.fiber.entry
  const 编辑器 = ctx.get('configEditor')
  if (入口 === undefined || 编辑器 === undefined) {
    throw new Error('这个 profile 不支持写配置（找不到 configEditor 或插件入口）')
  }
  const 来源 = 体 && typeof 体 === 'object' ? 体 : {}
  const 改 = {}

  if (typeof 来源.推送网盘 === 'boolean') 改.推送网盘 = 来源.推送网盘

  if (typeof 来源.网盘协议 === 'string' && 来源.网盘协议.trim() !== '') {
    const 协议 = 来源.网盘协议.trim()
    if (!合法协议.includes(协议)) throw new Error('网盘协议只能是 ' + 合法协议.join(' / '))
    改.网盘协议 = 协议
  }

  if (typeof 来源.网盘地址 === 'string') {
    const 地址 = 来源.网盘地址.trim().replace(/\/+$/, '')
    if (!/^https?:\/\/[^\s]+$/i.test(地址)) throw new Error('网盘地址要以 http:// 或 https:// 开头')
    改.网盘地址 = 地址
  }

  for (const 键 of ['网盘根目录', '网盘子目录']) {
    if (typeof 来源[键] === 'string') {
      // 远端路径是拼出来的：这两个字段里出现 .. 就能跑到别的目录去，直接挡掉
      const 值 = 来源[键].trim().replace(/^\/+/, '').replace(/\/+$/, '')
      if (值.split('/').includes('..')) throw new Error(键 + ' 里不能有 ..')
      改[键] = 值
    }
  }

  if (typeof 来源.网盘用户名 === 'string') 改.网盘用户名 = 来源.网盘用户名.trim()

  if (来源.网盘保留天数 !== undefined && 来源.网盘保留天数 !== null && 来源.网盘保留天数 !== '') {
    const 天 = Number(来源.网盘保留天数)
    if (!Number.isFinite(天) || 天 < 0 || 天 > 3650) throw new Error('网盘保留天数要在 0–3650 之间（0 = 不删）')
    改.网盘保留天数 = Math.floor(天)
  }

  if (来源.网盘超时秒 !== undefined && 来源.网盘超时秒 !== null && 来源.网盘超时秒 !== '') {
    const 秒 = Number(来源.网盘超时秒)
    if (!Number.isFinite(秒) || 秒 < 5 || 秒 > 300) throw new Error('超时要在 5–300 秒之间')
    改.网盘超时秒 = Math.floor(秒)
  }

  // 秘密：留空 = 不改；要清掉得显式说
  if (typeof 来源.网盘令牌 === 'string' && 来源.网盘令牌.trim() !== '') 改.网盘令牌 = 来源.网盘令牌.trim()
  else if (来源.清空令牌 === true) 改.网盘令牌 = ''
  if (typeof 来源.网盘密码 === 'string' && 来源.网盘密码 !== '') 改.网盘密码 = 来源.网盘密码
  else if (来源.清空密码 === true) 改.网盘密码 = ''

  // 选 openlist 又没令牌 → 存下去也是必然失败，提前拦住（令牌可能是本次刚填的）
  const 协议后 = 改.网盘协议 || 当前配置.网盘协议
  const 令牌后 = 改.网盘令牌 !== undefined ? 改.网盘令牌 : 当前配置.网盘令牌
  const 用户名后 = 改.网盘用户名 !== undefined ? 改.网盘用户名 : 当前配置.网盘用户名
  if (改.推送网盘 !== false) {
    if (协议后 === 'openlist' && String(令牌后 || '') === '') {
      throw new Error('OpenList 要一个静态令牌（OpenList 网页 → 设置 → 其他 → Token），否则推送必然 401')
    }
    if (协议后 === 'webdav' && String(用户名后 || '') === '') throw new Error('WebDAV 要填用户名')
  }

  await 编辑器.edit(入口, (现配置) => ({ ...(现配置 && typeof 现配置 === 'object' ? 现配置 : {}), ...改 }))
  return Object.keys(改)
}

/**
 * 试连：不打洞、不上传、只看「这个地址 + 这个凭据能不能列目录」。
 * 排错时最花时间的就是分不清「网络不通 / 令牌不对 / 目录不存在」，所以三种分开报。
 */
export async function 试连网盘(配置) {
  const 协议 = String(配置.网盘协议 || 'openlist')
  const 超时 = Math.max(5, Math.floor(Number(配置.网盘超时秒) || 30)) * 1000
  if (协议 === 'openlist') {
    if (!配置.网盘令牌) return { 成功: false, 话: '没配令牌（OpenList 网页 → 设置 → 其他 → Token）' }
    const 目标 = 远端路径(配置, '')
    let 响应
    try {
      响应 = await fetch(网盘API(配置, 'fs/list'), {
        method: 'POST',
        headers: 网盘头(配置, true),
        body: JSON.stringify({ path: 目标, password: '', page: 1, per_page: 1, refresh: false }),
        signal: AbortSignal.timeout(超时),
      })
    } catch (错误) {
      const 因 = String((错误 && 错误.message) || 错误)
      return {
        成功: false,
        话: /timeout|aborted/i.test(因)
          ? `连不上 ${配置.网盘地址}（超时）—— OpenList 起了吗？`
          : `连不上 ${配置.网盘地址}：${因}`,
      }
    }
    const 体 = await 响应.json().catch(() => null)
    if (响应.status === 401 || 响应.status === 403) return { 成功: false, 话: `令牌被拒了（HTTP ${响应.status}），换一个静态令牌` }
    if (体 && 体.code === 200) return { 成功: true, 话: '能连上，目录也在：' + 目标 }
    return { 成功: false, 话: `列目录失败：${体 ? 描述错误(体) : 'HTTP ' + 响应.status}（目录 ${目标} 存在吗？）` }
  }

  // webdav：PROPFIND Depth:0，207 = 目录在
  const 根 = String(配置.网盘根目录 || '').replace(/^\/+/, '').replace(/\/+$/, '')
  const 址 = String(配置.网盘地址 || '').replace(/\/+$/, '') + (根 ? '/' + encodeURI(根) : '') + '/'
  const 头 = { Depth: '0' }
  if (配置.网盘用户名) {
    头.Authorization = 'Basic ' + Buffer.from(String(配置.网盘用户名) + ':' + String(配置.网盘密码 || '')).toString('base64')
  }
  try {
    const 响应 = await fetch(址, { method: 'PROPFIND', headers: 头, signal: AbortSignal.timeout(超时) })
    if (响应.status === 207) return { 成功: true, 话: '能连上：' + 址 }
    if (响应.status === 401 || 响应.status === 403) return { 成功: false, 话: `账号被拒了（HTTP ${响应.status}）` }
    return { 成功: false, 话: `PROPFIND 回了 HTTP ${响应.status}：${址}` }
  } catch (错误) {
    return { 成功: false, 话: '连不上 ' + 址 + '：' + String((错误 && 错误.message) || 错误) }
  }
}

/** 接口出错时的统一措辞（别把原始对象直接塞给网页）。 */
function 描述错误(体) {
  if (!体 || typeof 体 !== 'object') return '（空响应）'
  return [体.code, 体.message].filter((项) => 项 !== undefined && 项 !== '' && 项 !== null).join(' ')
}

/** 外面能看的唯一入口（测试脚本也走这条）。传空对象就走默认配置。 */
export async function 跑一轮(半份配置, 原因) {
  const 配置 = 归一配置(半份配置)
  const 结果 = await 备份一次(配置, 原因)
  if (结果.成功) await 清理旧备份(配置)
  // 媒体归置 2026-11-13 已搬到 dsh-reply-jitter，这里不再调
  // 备份成功后，如果开了网盘推送，把当天的备份推上去
  if (结果.成功 && 配置.推送网盘 === true) {
    try {
      await 推送当天备份(配置)
    } catch (错误) {
       await 记诊断(配置, 'ERROR', '网盘推送整体失败：' + String((错误 && 错误.message) || 错误))
      await 记推送状态(配置, { 时间: new Date().toISOString(), 结果: '失败', 话: String((错误 && 错误.message) || 错误), 文件数: 0, 字节: 0 })
    }
  }
  return 结果
}


// ---------------------------------------------------------------- 网页面板要读的
//
// 下面这些都是**只读**的：列出备份目录、数文件、读日志。
// 面板要「备份了哪些文件、哪天的」，但它不该知道 <目标目录>\<层>\<日期> 这套结构，
// 所以把结构翻译成人能看的一份 JSON，接口只负责端出去。

/** 每一层的文件列表最多给这么多条：网页上够铺一屏，又不至于为一天的上千个文件把接口拖慢。 */
const 最多文件条数 = 400

/**
 * 递归收集一层备份里的文件，`名` 是正斜杠相对路径。
 *
 * 深度封顶 6 层：备份目录是本插件自己写的，正常只有两三层
 * （应用状态的 Local Storage\leveldb、记忆的 memory/<卡名>.md）。
 * 万一有人往里塞了个大目录，也不能让网页端等在那里数分钟。
 */
async function 收集文件(根, 相对前缀 = '', 深度 = 0) {
  const 结果 = []
  if (深度 > 6) return 结果
  let 条目
  try {
    条目 = await readdir(join(根, 相对前缀), { withFileTypes: true })
  } catch {
    return 结果 // 这层没备（关着备份，或者那轮没备到）就是空的，不算错
  }
  for (const 项 of 条目) {
    const 名 = 相对前缀 === '' ? 项.name : 相对前缀 + '/' + 项.name
    if (项.isDirectory()) {
      结果.push(...(await 收集文件(根, 名, 深度 + 1)))
      continue
    }
    if (!项.isFile()) continue
    let 字节 = 0
    let 时间 = ''
    try {
      const 信息 = await stat(join(根, 名))
      字节 = Number(信息.size) || 0
      时间 = 信息.mtime.toISOString()
    } catch {
      // 数的这一刻文件被删了/被占着：条目留着、字节记 0，比整个接口挂掉强
    }
    结果.push({ 名, 字节, 时间 })
  }
  return 结果
}

/**
 * 一层（某层某一天）的汇总。
 * 文件数/字节是**真实总数**，只有 `文件` 会被截断 —— 面板顶部的汇总要是被截断后的数，就成谎话了。
 */
async function 汇总一层(根, 排除名们 = []) {
  const 全部 = (await 收集文件(根)).filter((条) => !排除名们.includes(条.名))
  // 先按名字排：截断时留下的是哪 400 条必须稳定，不能每次请求都不一样
  全部.sort((甲, 乙) => (甲.名 < 乙.名 ? -1 : 甲.名 > 乙.名 ? 1 : 0))
  let 字节 = 0
  for (const 条 of 全部) 字节 += 条.字节
  return {
    文件数: 全部.length,
    字节,
    文件: 全部.slice(0, 最多文件条数),
    截断: 全部.length > 最多文件条数,
  }
}

/** 会话本体那层多了「工作区」一维，所以要按工作区再分一层。 */
async function 汇总会话(配置, 日期, 路径表) {
  const 会话根 = 会话目录Of(配置)
  let 区们 = []
  try {
    区们 = await readdir(会话根, { withFileTypes: true })
  } catch {
    区们 = [] // 还没备过本体
  }
  区们 = 区们.filter((项) => 项.isDirectory()).sort((甲, 乙) => (甲.name < 乙.name ? -1 : 甲.name > 乙.name ? 1 : 0))

  const 工作区们 = []
  let 文件数 = 0
  let 字节 = 0
  let 截断 = false
  for (const 区 of 区们) {
    const 一层 = await 汇总一层(join(会话根, 区.name, 日期))
    // 这间工作区这天没备份：不占位，不然日期列表里会冒出一串空工作区
    if (一层.文件数 === 0) continue
    文件数 += 一层.文件数
    字节 += 一层.字节
    if (一层.截断) 截断 = true
    工作区们.push({
      工作区: 区.name,
      工作区路径: 路径表.get(区.name) || '',
      文件数: 一层.文件数,
      字节: 一层.字节,
      文件: 一层.文件,
      截断: 一层.截断,
    })
  }
  return { 文件数, 字节, 工作区们, 截断 }
}

/** 备份目录名 → 真实工作区路径。备份时目录名是「标题净化后的名字」，这里反推回去。 */
async function 工作区路径表() {
  const 表 = new Map()
  const 记录表 = await 读工作区表()
  for (const 记录 of 记录表.values()) {
    const 显示名 = 净化名(记录.标题 || String(记录.路径 || '').split('\\').pop())
    if (!表.has(显示名)) 表.set(显示名, 记录.路径)
  }
  return 表
}

/** 读一天的 manifest.json（老版本不写这文件，读不到就是 null）。 */
async function 读清单(文件) {
  try {
    const 清单 = JSON.parse(await readFile(文件, 'utf8'))
    return 清单 && typeof 清单 === 'object' ? 清单 : null
  } catch {
    return null
  }
}

/** 文件的最后 N 行。整个读进来再切：backup.log 一年也就几百 KB，不值得为它搞流式。 */
async function 读日志尾(文件, 要几行) {
  try {
    const 行们 = (await readFile(文件, 'utf8')).split(/\r?\n/).filter((行) => 行.trim() !== '')
    return 行们.slice(-要几行)
  } catch {
    return []
  }
}

/**
 * 目标目录下**不是**插件自己写的那几层 —— 比如 `手动`、`音频归档`、`隔离-孤儿会话`。
 * 那是别的脚本/别的工具放的，**只统计、不管理**（既不删也不列文件明细），
 * 但面板上得让人看见它们占了多大地方，不然「总字节」会莫名其妙对不上。
 */
async function 汇总其他目录(配置) {
  const 本层 = new Set([
    '应用状态',
    '人设',
    '记忆',
    basename(索引目录Of(配置)),
    basename(会话目录Of(配置)),
  ])
  let 条目 = []
  try {
    条目 = await readdir(配置.目标目录, { withFileTypes: true })
  } catch {
    return [] // 目标目录还没建 = 一轮都没跑过
  }
  const 名单 = []
  for (const 项 of 条目) {
    if (!项.isDirectory() || 本层.has(项.name)) continue
    const 文件 = await 收集文件(join(配置.目标目录, 项.name))
    let 字节 = 0
    for (const 条 of 文件) 字节 += 条.字节
    名单.push({ 名: 项.name, 文件数: 文件.length, 字节 })
  }
  名单.sort((甲, 乙) => (甲.名 < 乙.名 ? -1 : 甲.名 > 乙.名 ? 1 : 0))
  return 名单
}

/**
 * 网页面板的那份总表（测试脚本也走这条，方便肉眼核对）。
 *
 * 日期集合以 `索引` 为准：它是主目录，每天都在；会话/应用状态/人设/记忆
 * 可能某天缺（开关关着、或者那轮没备到），缺席的给 0 和空数组，不当成错误。
 */
export async function 列出备份(半份配置) {
  const 配置 = 归一配置(半份配置)
  // 首帧就要给对：读回上次推送结果（幂等，之后都是同一个 promise）
  await 读回推送状态(配置)
  const 目标 = 配置.目标目录
  const 索引根 = 索引目录Of(配置)

  let 索引条目 = []
  try {
    索引条目 = await readdir(索引根, { withFileTypes: true })
  } catch {
    索引条目 = []
  }
  const 日期名 = 索引条目
    .filter((项) => 项.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(项.name))
    .map((项) => 项.name)
    .sort()
    .reverse() // 新的在前：面板默认展示最近几天

  // 最新那天的 manifest 只读一次，同时当「上次备份」和「路径映射」用
  const 最新清单 = 日期名.length > 0 ? await 读清单(join(索引根, 日期名[0], 'manifest.json')) : null

  const 路径表 = await 工作区路径表()
  // manifest 里记着「备份目录名 → 真实路径」，比按标题反推准；有就盖一层
  const 映射 = 最新清单 && Array.isArray(最新清单.工作区映射) ? 最新清单.工作区映射 : []
  for (const 条 of 映射) {
    if (条 && typeof 条.工作区 === 'string' && typeof 条.路径 === 'string' && 条.路径 !== '') 路径表.set(条.工作区, 条.路径)
  }

  const 日期们 = []
  for (let 号 = 0; 号 < 日期名.length; 号 += 1) {
    const 日期 = 日期名[号]
    const 清单 = 号 === 0 ? 最新清单 : await 读清单(join(索引根, 日期, 'manifest.json'))
    // manifest.json 是元数据：它的文件数/有问题从清单里读，不该混进「索引文件」明细
    const 索引 = await 汇总一层(join(索引根, 日期), ['manifest.json'])
    const 会话 = await 汇总会话(配置, 日期, 路径表)
    const 应用状态 = await 汇总一层(join(目标, '应用状态', 日期))
    const 人设 = await 汇总一层(join(目标, '人设', 日期))
    const 记忆 = await 汇总一层(join(目标, '记忆', 日期))
    const 字节 = 索引.字节 + 会话.字节 + 应用状态.字节 + 人设.字节 + 记忆.字节
    const 文件数 = 索引.文件数 + 会话.文件数 + 应用状态.文件数 + 人设.文件数 + 记忆.文件数
    日期们.push({
      日期,
      总字节: 字节,
      文件数,
      有问题: 清单 ? Number(清单.有问题) || 0 : 0,
      索引,
      会话,
      应用状态,
      人设,
      记忆,
    })
  }

  let 总字节 = 0
  for (const 一天 of 日期们) 总字节 += 一天.总字节

  return {
    ok: true,
    服务器时间: new Date().toISOString(),
    配置: {
      目标目录: 配置.目标目录,
      // 这里是清理时真正生效的数，不是配置里那个可能被写成 0 的原始值
      保留天数: Math.max(1, Math.floor(Number(配置.保留天数) || 默认配置.保留天数)),
      每天几点: String(配置.每天几点 || ''),
      源目录: 源目录Of(配置),
      本体目录: 本体目录Of(配置),
      备份本体: 配置.备份本体 !== false,
      备份应用状态: 配置.备份应用状态 !== false,
      备份人设: 配置.备份人设 !== false,
      备份记忆: 配置.备份记忆 !== false,
      // 网盘推送配置（令牌脱敏，只告诉面板「配没配」）
      推送网盘: 配置.推送网盘 === true,
      网盘协议: String(配置.网盘协议 || 'openlist'),
      网盘地址: String(配置.网盘地址 || ''),
      网盘根目录: String(配置.网盘根目录 || ''),
      网盘子目录: String(配置.网盘子目录 || ''),
      网盘已配账号: Boolean(配置.网盘令牌 || 配置.网盘用户名),
    },
    网盘: {
      启用: 配置.推送网盘 === true,
      上次: 网盘推送状态,
      // 插件页面那一栏「网盘推送」的表单数据（令牌只报配没配 + 尾号）
      设置: 网盘配置视图(配置),
    },
    离线脚本: await 查离线脚本(配置),
    总字节,
    上次备份:
      最新清单 === null || 日期名.length === 0
        ? null
        : {
            日期: 日期名[0],
            时间: String(最新清单.时间 || ''),
            原因: String(最新清单.原因 || ''),
            文件数: Number(最新清单.文件数) || 0,
            总字节: Number(最新清单.总字节) || 0,
            有问题: Number(最新清单.有问题) || 0,
            // 应用状态有几个文件被独占抄不动 —— 面板上得能看见，不然 cookie 又白丢
            应用状态:
              最新清单.应用状态 && typeof 最新清单.应用状态 === 'object'
                ? {
                    成功: Number(最新清单.应用状态.成功) || 0,
                    跳过: Number(最新清单.应用状态.跳过) || 0,
                    被占用: Array.isArray(最新清单.应用状态.被占用) ? 最新清单.应用状态.被占用 : [],
                  }
                : null,
          },
    日期们,
    其他目录: await 汇总其他目录(配置),
    日志: await 读日志尾(join(目标, 'backup.log'), 40),
  }
}

/**
 * 删掉某一天在五层里的全部备份（索引 / 会话每个工作区下 / 应用状态 / 人设 / 记忆）。
 *
 * ⚠ 日期是直接从 HTTP 请求体里来的，会拼进 rm 的路径 ——
 *   不校验就等于把整个盘的删除权交出去。所以这里**自己再校验一遍**，
 *   不信调用方（`2026-11-07` 之外的一律不动）。
 */
async function 删除一天(配置, 日期) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(日期 || ''))) throw new Error('日期格式不对')

  const 删掉 = []
  const 试着删 = async (路径, 展示名) => {
    try {
      // 先看一眼在不在：rm 带 force 对不存在的路径不报错，分不出「删了」和「本来就没有」
      await stat(路径)
    } catch {
      return
    }
    try {
      await rm(路径, { recursive: true, force: true })
      删掉.push(展示名)
    } catch {
      // 删不动（被占用之类）就不列进「删掉」，面板上看得出来哪天没删成
    }
  }

  await 试着删(join(索引目录Of(配置), 日期), '索引/' + 日期)

  const 会话根 = 会话目录Of(配置)
  let 区们 = []
  try {
    区们 = await readdir(会话根, { withFileTypes: true })
  } catch {
    区们 = [] // 没备过本体，那一处就没什么可删的
  }
  for (const 区 of 区们) {
    if (!区.isDirectory()) continue
    await 试着删(join(会话根, 区.name, 日期), '会话/' + 区.name + '/' + 日期)
  }

  for (const 根名 of ['应用状态', '人设', '记忆']) {
    await 试着删(join(配置.目标目录, 根名, 日期), 根名 + '/' + 日期)
  }

  return 删掉
}

// ---------------------------------------------------------------- 插件本体

export function apply(ctx, config) {
  const 配置 = 归一配置(config)
  if (配置.enabled === false) {
    ctx.logger.info('session-backup: 配置里 enabled=false，本次不启用')
    return
  }

  const 时刻 = 解析时刻(配置.每天几点)
  if (时刻 === null) {
    ctx.logger.warn(`session-backup: 「每天几点」写坏了（${配置.每天几点}），定时不会跑，只保留启动补拍`)
  }

  // 把上次推送结果读回来：不读的话热重载后「网盘推送」栏会说假话（明明推过却显示没推过）
  void 读回推送状态(配置)

  // 进程退出时补抄「活着的时候读不了」的文件（Cookies 就是这一类）。
  // 'exit' 里只能同步做事，所以那条路用的是 fs 的同步 API。
  if (配置.备份应用状态 !== false) {
    ctx.effect(() => {
      const 钩子 = () => 退出补抄(配置)
      process.on('exit', 钩子)
      return () => process.removeListener('exit', 钩子)
    })
  }

  // 开机第一行：出问题时先确认「插件到底有没有加载、加载的是哪份配置」
  const 启动记录 = 记诊断(
    配置,
    'INFO',
    `插件加载 · 目标 ${配置.目标目录} · 每天 ${配置.每天几点} · 保留 ${配置.保留天数} 天 · ` +
      `启动补拍 ${配置.启动后立刻备份 !== false ? '开' : '关'} · 本体 ${配置.备份本体 !== false ? '备' : '不备'} · ` +
      `应用状态 ${配置.备份应用状态 !== false ? '备' : '不备'} · 人设 ${配置.备份人设 !== false ? '备' : '不备'} · ` +
      `记忆 ${配置.备份记忆 !== false ? '备' : '不备'}`,
  )

  let 上次拍的日期 = ''
  let 在拍 = false

  // 「立即备份」按钮和每日定时共用一把锁。
  // 原来只有 `在拍` 挡定时对定时；网页面板点出来的那轮走的是另一条路，
  // 撞上启动补拍时两轮会同时往同一批文件 copyFile —— 内容一样不会坏，
  // 但 manifest 和日志会写成两遍。撞上了就排到对方后面，不并行写。
  let 在跑的那轮 = null
  const 跑一轮串行 = (原因) => {
    if (在跑的那轮 !== null) return 在跑的那轮
    const 这轮 = 跑一轮(配置, 原因).finally(() => {
      在跑的那轮 = null
    })
    在跑的那轮 = 这轮
    return 这轮
  }

  const 拍 = async (原因) => {
    if (在拍) return // 上一版还没写完，别叠着来
    在拍 = true
    try {
      const 结果 = await 跑一轮串行(原因)
      if (结果.成功) {
        ctx.logger.info('session-backup: ' + 结果.话)
        上次拍的日期 = 本地日期()
      } else {
        ctx.logger.warn('session-backup: ' + 结果.话)
      }
    } catch (错误) {
      // finally 里再抛出会变成未处理的 rejection，这里必须吞掉
      ctx.logger.warn('session-backup: 备份出错（已忽略）：' + String((错误 && 错误.message) || 错误))
      void 记诊断(配置, 'WARN', '备份抛错（' + 原因 + '）：' + String((错误 && 错误.stack) || (错误 && 错误.message) || 错误))
    } finally {
      在拍 = false
    }
  }

  // 1) 启动后补拍一次（机器不会天天开着，光靠定时会漏）
  if (配置.启动后立刻备份 !== false) {
    const 延迟 = Math.max(0, Math.floor(Number(配置.启动延迟秒) || 0)) * 1000
    ctx.effect(() => {
      const 表 = setTimeout(() => {
        void 拍('启动补拍')
      }, 延迟)
      return () => clearTimeout(表)
    })
  }

  // 2) 每 60 秒看一次墙钟：到点了、今天还没拍过 → 拍
  if (typeof ctx.interval === 'function' && 时刻 !== null) {
    ctx.effect(() =>
      ctx.interval(() => {
        const 现在 = new Date()
        if (现在.getHours() !== 时刻.时 || 现在.getMinutes() !== 时刻.分) return
        if (上次拍的日期 === 本地日期(现在)) return
        void 拍('每日定时')
      }, tick毫秒),
    )
  } else if (typeof ctx.interval !== 'function') {
    ctx.logger.warn('session-backup: 拿不到 timer 服务（ctx.interval 不在），只有启动补拍会跑')
  }

  ctx.logger.info(
    `session-backup: 已加载 · 源 ${源目录Of(配置)} · 目标 ${配置.目标目录} · 每天 ${配置.每天几点} · 保留 ${配置.保留天数} 天`,
  )

  // 3) 网页面板的四个接口：列表 / 手动跑一轮 / 删某一天 / 读日志
  //
  // ⚠ 这里必须用 `ctx.inject`，**不能**用 `ctx.get('webServer')`：
  //   冷启动时 webServer 往往比本插件晚起来，`ctx.get` 在 apply 那一刻拿到的是
  //   undefined。第一版就栽在这一步 —— 定时备份照跑（backup.log 里有「启动补拍」），
  //   网页面板却永远 404（2026-11-07 01:00 实测：重启后 /session-backup/list 全 404）。
  //   `ctx.inject` 会等服务真的在线上再把这块调起来（HMR 重组那次能通，纯属当时
  //   webServer 早就起来了，把这个 bug 盖住了）。
  //
  //   为什么不是把 webServer 写进 `inject`：那样在没有网页宿主的 profile 里
  //   整个插件都不会激活，连每天的备份都没了。备份不能因为一个面板挂掉，
  //   面板也不能因为启动顺序挂掉 —— 所以是「插件照常起，接口等 webServer 到了再挂」。
  ctx.inject(['webServer'], (网页) => {
    const web = 网页.webServer
    // 开机自检用：日志里看不到这一行 = 面板接口没挂上（冷启动那次就是这么查出来的）
    ctx.logger.info('session-backup: 网页面板接口已挂上（/session-backup/list|run|delete|log）')
    // 排在「插件加载」那一行后面写：两行时间戳一样，顺序乱了看着别扭
    void 启动记录.finally(() =>
      记诊断(配置, 'INFO', '网页面板接口已挂上 /session-backup/{list,run,delete,log,log-client}'),
    )

    /**
     * 插件自己挂在 webServer 上的地址**不吃 DSH 的登录校验** ——
     * 随便一个网页都能 POST 过来跑备份、删备份。所以 POST 先问 connection 服务：
     * 这个请求是不是外来的。
     *
     * ⚠ 一律「失败就放行」：拿不到 connection、老宿主没这个接口、内部抛错，都当没事。
     *   宁可这一版防不住，也不能因为宿主升个版本就把面板锁死。
     */
    const 外来请求 = (req) => {
      try {
        const 连接 = ctx.get('connection')
        if (连接 && typeof 连接.requestRejection === 'function') {
          const 码 = 连接.requestRejection(req)
          if (码 === 401 || 码 === 403) return 码
        }
      } catch {
        // 鉴权这条路自己坏了 → 放行
      }
      return 0
    }

    const 发送JSON = (res, 状态, 体) => {
      try {
        res.writeHead(状态, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(体))
      } catch {
        // 页面早关了，写不进去就算了
      }
    }

    const 读请求体 = async (req) => {
      let 原文 = ''
      try {
        for await (const 块 of req) 原文 += 块
      } catch {
        // 读到一半断了就当空体
      }
      return 原文
    }

    const 只接受POST = (req, res) => {
      if (req.method === 'POST') return false
      发送JSON(res, 405, { ok: false, error: '只接受 POST' })
      return true
    }

    const 挡外来 = (req, res) => {
      const 码 = 外来请求(req)
      if (码 === 0) return false
      void 记诊断(配置, 'WARN', `拒了外来请求 ${req.method} ${String(req.url || '')} → ${码}`)
      发送JSON(res, 码, { ok: false, error: 码 === 401 ? 'authentication_required' : 'forbidden' })
      return true
    }

    // 面板打开时先拉这份：配置 + 每天一层、每层有哪些文件
    网页.effect(() =>
      web.register({
        kind: 'exact',
        path: '/session-backup/list',
        handler: async (req, res) => {
          try {
            发送JSON(res, 200, await 列出备份(配置))
          } catch (错误) {
            发送JSON(res, 500, { ok: false, error: String((错误 && 错误.message) || 错误) })
          }
        },
      }),
    )

    // 手动跑一轮。⚠ 等它跑完再回：一轮几秒，回完页面才能立刻拉到新的一天
    网页.effect(() =>
      web.register({
        kind: 'exact',
        path: '/session-backup/run',
        handler: async (req, res) => {
          if (只接受POST(req, res)) return
          if (挡外来(req, res)) return
          const 开始 = Date.now()
          try {
            const 结果 = await 跑一轮串行('手动-网页端')
            const 清单 = Array.isArray(结果.清单) ? 结果.清单 : []
            let 字节 = 0
            for (const 条 of 清单) 字节 += Number(条.备份字节) || 0
            void 记诊断(
              配置,
              'INFO',
              `面板手动备份 → ${结果.成功 !== false ? '成功' : '有问题'} · ${清单.length} 个文件 · ${Date.now() - 开始}ms`,
            )
            发送JSON(res, 200, {
              ok: true,
              成功: 结果.成功 !== false,
              话: String(结果.话 || ''),
              文件数: 清单.length,
              总字节: 字节,
            })
          } catch (错误) {
            void 记诊断(配置, 'ERROR', '面板手动备份抛错：' + String((错误 && 错误.stack) || 错误))
            发送JSON(res, 500, { ok: false, error: String((错误 && 错误.message) || 错误) })
          }
        },
      }),
    )

    // 手动推网盘：把当天备份再推一遍（不用等明天定时）
    网页.effect(() =>
      web.register({
        kind: 'exact',
        path: '/session-backup/push',
        handler: async (req, res) => {
          if (只接受POST(req, res)) return
          if (挡外来(req, res)) return
          try {
            if (配置.推送网盘 !== true) {
              发送JSON(res, 400, { ok: false, error: '网盘推送没开（配置里 推送网盘 不是 true）' })
              return
            }
            if (配置.网盘协议 !== 'openlist' && !配置.网盘用户名) {
              发送JSON(res, 400, { ok: false, error: '还没配网盘账号（网盘用户名/网盘密码 为空）' })
              return
            }
            if (配置.网盘协议 === 'openlist' && !配置.网盘令牌) {
              发送JSON(res, 400, { ok: false, error: '还没配 OpenList 令牌（网盘令牌 为空）' })
              return
            }
            const 结果 = await 推送当天备份(配置)
            发送JSON(res, 200, { ok: true, 成功: 结果.成功, 话: 结果.话, 文件数: 结果.文件数, 字节: 结果.字节 })
          } catch (错误) {
            void 记诊断(配置, 'ERROR', '面板手动推送网盘抛错：' + String((错误 && 错误.message) || 错误))
            发送JSON(res, 500, { ok: false, error: String((错误 && 错误.message) || 错误) })
          }
        },
      }),
    )

    // 离线备份脚本：查状态（GET）/ 装一份（POST）/ 打开所在文件夹（POST）
    // 为什么需要它：Cookies 在 DSH 运行时是独占锁，插件抄不到；退出钩子又经常
    // 来不及跑（13 天只成过 1 次）。所以给一个"双击就行"的本地脚本。
    网页.effect(() =>
      web.register({
        kind: 'exact',
        path: '/session-backup/offline',
        handler: async (req, res) => {
          try {
            发送JSON(res, 200, { ok: true, ...(await 查离线脚本(配置)) })
          } catch (错误) {
            发送JSON(res, 500, { ok: false, error: String((错误 && 错误.message) || 错误) })
          }
        },
      }),
    )

    网页.effect(() =>
      web.register({
        kind: 'exact',
        path: '/session-backup/offline-install',
        handler: async (req, res) => {
          if (只接受POST(req, res)) return
          if (挡外来(req, res)) return
          try {
            const 装了 = await 安装离线脚本(配置)
            void 记诊断(配置, 'INFO', '装了离线备份脚本 → ' + 装了.脚本)
            发送JSON(res, 200, { ok: true, ...装了 })
          } catch (错误) {
            const 话 = String((错误 && 错误.message) || 错误)
            void 记诊断(配置, 'ERROR', '装离线备份脚本失败：' + 话)
            发送JSON(res, 500, { ok: false, error: 话 })
          }
        },
      }),
    )

    // 在资源管理器里选中那个脚本 —— 面板上一句"去这里双击"，不如直接给他打开
    网页.effect(() =>
      web.register({
        kind: 'exact',
        path: '/session-backup/offline-open',
        handler: async (req, res) => {
          if (只接受POST(req, res)) return
          if (挡外来(req, res)) return
          try {
            const 状态 = await 查离线脚本(配置)
            if (!状态.已装) {
              发送JSON(res, 400, { ok: false, error: '还没装离线脚本' })
              return
            }
            // 只允许打开我们自己算出来的目录，不接受任何来自请求体的路径
            const { execFile } = await import('node:child_process')
            const 目标 = 状态.启动器 !== '' ? 状态.启动器 : 状态.目录
            execFile('explorer.exe', [状态.启动器 !== '' ? '/select,' + 目标 : 目标])
            发送JSON(res, 200, { ok: true, 打开: 目标 })
          } catch (错误) {
            发送JSON(res, 500, { ok: false, error: String((错误 && 错误.message) || 错误) })
          }
        },
      }),
    )

    // 网盘设置：读（GET，只回脱敏后的视图）/ 存（POST）/ 试连（POST，不落盘）
    // 存盘走 configEditor，不自己改 profile 文件。
    网页.effect(() =>
      web.register({
        kind: 'exact',
        path: '/session-backup/netdisk',
        handler: async (req, res) => {
          try {
            // 这个接口是详情页/页签唯一的读入口：先保证状态读回来，别报「还没推过」
            await 读回推送状态(配置)
            发送JSON(res, 200, { ok: true, 设置: 网盘配置视图(配置), 上次: 网盘推送状态 })
          } catch (错误) {
            发送JSON(res, 500, { ok: false, error: String((错误 && 错误.message) || 错误) })
          }
        },
      }),
    )

    网页.effect(() =>
      web.register({
        kind: 'exact',
        path: '/session-backup/netdisk-save',
        handler: async (req, res) => {
          if (只接受POST(req, res)) return
          if (挡外来(req, res)) return
          let 体 = {}
          try {
            体 = JSON.parse((await 读请求体(req)) || '{}')
          } catch {
            发送JSON(res, 400, { ok: false, error: '请求体不是 JSON' })
            return
          }
          try {
            const 改了 = await 保存网盘配置(ctx, 配置, 体)
            void 记诊断(配置, 'INFO', '面板保存网盘设置 → ' + (改了.length ? 改了.join('、') : '（没有变化）'))
            发送JSON(res, 200, { ok: true, 改了 })
          } catch (错误) {
            const 话 = String((错误 && 错误.message) || 错误)
            void 记诊断(配置, 'WARN', '面板保存网盘设置失败：' + 话)
            发送JSON(res, 400, { ok: false, error: 话 })
          }
        },
      }),
    )

    网页.effect(() =>
      web.register({
        kind: 'exact',
        path: '/session-backup/netdisk-test',
        handler: async (req, res) => {
          if (只接受POST(req, res)) return
          if (挡外来(req, res)) return
          // 允许带上表单里还没存的值，这样「先试再存」不用先写坏配置
          let 体 = {}
          try {
            体 = JSON.parse((await 读请求体(req)) || '{}')
          } catch {
            // 空体 = 用当前已存的配置试
          }
          const 试 = { ...配置 }
          for (const 键 of ['网盘协议', '网盘地址', '网盘根目录', '网盘子目录', '网盘用户名', '网盘密码', '网盘令牌', '网盘超时秒']) {
            if (typeof 体[键] === 'string' && 体[键].trim() !== '') 试[键] = 体[键].trim()
          }
          try {
            const 结果 = await 试连网盘(试)
            void 记诊断(配置, 结果.成功 ? 'INFO' : 'WARN', '面板试连网盘：' + 结果.话)
            发送JSON(res, 200, { ok: true, 成功: 结果.成功, 话: 结果.话 })
          } catch (错误) {
            发送JSON(res, 200, { ok: true, 成功: false, 话: String((错误 && 错误.message) || 错误) })
          }
        },
      }),
    )

    // 删掉某一天的备份（五层一起删）
    网页.effect(() =>
      web.register({
        kind: 'exact',
        path: '/session-backup/delete',
        handler: async (req, res) => {
          if (只接受POST(req, res)) return
          if (挡外来(req, res)) return
          let 体 = {}
          try {
            体 = JSON.parse((await 读请求体(req)) || '{}')
          } catch {
            // 体不是 JSON 就当没给日期，下面会按格式不对回 400
          }
          const 日期 = String((体 && 体.日期) || '').trim()
          // ⚠ 这个字符串会拼进 rm 的路径：只认 YYYY-MM-DD，别的一律 400
          if (!/^\d{4}-\d{2}-\d{2}$/.test(日期)) {
            发送JSON(res, 400, { ok: false, error: '日期格式不对' })
            return
          }
          try {
            const 删掉 = await 删除一天(配置, 日期)
            await 记文件日志(配置, '手动删除 ' + 日期)
            void 记诊断(配置, 'INFO', `面板删除 ${日期} → 删掉 ${删掉.length} 处：${删掉.join('、') || '（本来就没有）'}`)
            发送JSON(res, 200, { ok: true, 日期, 删掉 })
          } catch (错误) {
            void 记诊断(配置, 'ERROR', `面板删除 ${日期} 抛错：` + String((错误 && 错误.stack) || 错误))
            发送JSON(res, 500, { ok: false, error: String((错误 && 错误.message) || 错误) })
          }
        },
      }),
    )

    // 面板上那两个「看日志」：默认 backup.log；?which=plugin 看诊断日志。
    // 只认这两个名字（白名单），别让它变成任意文件读取的口子。
    网页.effect(() =>
      web.register({
        kind: 'exact',
        path: '/session-backup/log',
        handler: async (req, res) => {
          try {
            const 址 = new URL(String(req.url || ''), 'http://127.0.0.1')
            const 要 = Math.max(1, Math.min(500, Math.floor(Number(址.searchParams.get('lines')) || 100)))
            const 哪个 = 址.searchParams.get('which') === 'plugin' ? 'plugin.log' : 'backup.log'
            发送JSON(res, 200, { ok: true, 哪个, 行: await 读日志尾(join(配置.目标目录, 哪个), 要) })
          } catch (错误) {
            发送JSON(res, 500, { ok: false, error: String((错误 && 错误.message) || 错误) })
          }
        },
      }),
    )

    // 网页半边把错误写到这儿 —— 浏览器 console 没人看得到，不落盘就等于没发生。
    // 2026-11-07 面板白屏那次，错误就只活在 console 里，查了很久。
    网页.effect(() =>
      web.register({
        kind: 'exact',
        path: '/session-backup/log-client',
        handler: async (req, res) => {
          if (只接受POST(req, res)) return
          if (挡外来(req, res)) return
          let 体 = {}
          try {
            体 = JSON.parse((await 读请求体(req)) || '{}')
          } catch {
            // 体坏了也回 200：这是诊断通道，别让网页那边为了报错再折腾
          }
          const 标题 = String((体 && 体.message) || '（没给标题）').slice(0, 500)
          const 详情 = String((体 && 体.detail) || '').slice(0, 2000)
          发送JSON(res, 200, { ok: true })
          await 记诊断(配置, '客户端', 标题 + (详情 === '' ? '' : '\n' + 详情))
        },
      }),
    )
  })
}




