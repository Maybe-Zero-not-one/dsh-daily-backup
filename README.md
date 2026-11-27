# dsh-daily-backup

DSH 插件：**每天把会话、人设、记忆、应用状态各留一份到工作区外，只留最近 N 天**，
左侧栏有一栏「备份」能看每天备了哪些文件，也能手动备份、删掉某一天的备份；
页面里第二个页签可以直接**配网盘推送**（OpenList / WebDAV），每天备份完自动推一份异地保险。

npm 上的包名是 **`dsh-daily-backup`**（`dsh-session-backup` 这个名字 2026-10 已被别人占用，
功能不是一回事）。装：

```powershell
dsh plugin add dsh-daily-backup
```

或在「插件 → 添加插件」里填 `dsh-daily-backup`。

## 适配哪个 DSH 版本

| 插件 | DSH | 实测日期 |
| --- | --- | --- |
| 1.2.12 | 0.2.2-rc.1 | 2026-11-27（新增「数据来源」页签：人设/记忆归属说明 + 扫描散落的数据 + 自定义备份路径（含可访问/可复制/大小限制三条规则）） |
| 1.2.11 | 0.2.2-rc.1 | 2026-11-27（修面板「推送网盘」误报 Failed to fetch：改成后台跑 + 轮询；单文件瞬时失败重试一次） |
| 1.2.10 | 0.2.2-rc.1 | 2026-11-26（README 版本表补全 1.2.7–1.2.9；无代码改动，纯文档对齐） |
| 1.2.9 | 0.2.2-rc.1 | 2026-11-26（说明人设/记忆分别属于 dsh-soul-md 与 dsh-fish-memory；重发 v1.2.8 被回退的文档） |
| 1.2.8 | 0.2.2-rc.1 | 2026-11-26（同 1.2.9 的内容，但 README 发布时被过时副本覆盖，已由 1.2.9 重发） |
| 1.2.7 | 0.2.2-rc.1 | 2026-11-25（删掉已搬走的媒体归置整节；页签数改为三个、路由表补全到 14 条） |
| 1.2.6 | 0.2.2-rc.1 | 2026-11-25（README 去掉「跑一个插件并不附带的修复脚本」的说法） |
| 1.2.5 | 0.2.2-rc.1 | 2026-11-25（README 去掉作者机器专属信息：快捷方式名、崩溃时间戳、账号） |
| 1.2.4 | 0.2.2-rc.1 | 2026-11-25（描述与作者字段整理，去掉个人邮箱） |
| 1.2.3 | 0.2.2-rc.1 | 2026-11-25（补 repository / homepage / bugs，README 标题改回 dsh-daily-backup） |
| 1.2.1 | 0.2.2-rc.1 | 2026-11-24（修「是默认位置」判断：归一化后永远 false） |
| 1.2.0 | 0.2.2-rc.1 | 2026-11-24（默认备份位置改到 `<DSH_HOME>\backups`，面板可改） |
| 1.1.0 | 0.2.2-rc.1 | 2026-11-24（新增「离线备份」页签：装本地脚本，双击拿到完整 Cookies） |
| 1.0.4 | 0.2.2-rc.1 | 2026-11-23（去掉指向不存在仓库的 homepage/repository） |
| 1.0.3 | 0.2.2-rc.1 | 2026-11-23（README 补上 npm 安装段与网盘设置页签说明） |
| 1.0.2 | 0.2.2-rc.1 | 2026-11-23（清掉源码/文档里写死的绝对路径示例） |
| 1.0.1 | 0.2.2-rc.1 | 2026-11-23（默认目录不再依赖某台具体机器） |
| 1.0.0 | 0.2.2-rc.1 | 2026-11-23（首个公开发布：加了网盘设置页签） |
| 0.2.3 | 0.2.2-rc.1 | 2026-11-11 |
| 0.2.2 | 0.2.2-rc.1 | 2026-11-11 |
| 0.2.1 | 0.2.2-rc.1 | 2026-11-07 |
| 0.2.0 | 0.2.2-rc.1 | 2026-11-07 |
| 0.1.1 | 0.2.2-rc.1 | 2026-11-05 |


会话本体是**现找** `session.v*.jsonl.zstd`（有多个就取版本号最大的），不写死 v4 ——
DSH 以后把本体改名成 v5 也不会静默漏备。

## 它为什么存在

QQ 那边的会话在 `<DSH_HOME>\storages\session_projcache\sessions\onebot-*.json`（索引），
真身是 `<DSH_HOME>\sessions\<工作区>\<会话ID>\session.v4.jsonl.zstd`（本体）。

插件删会话只把引用去掉，日志还留在盘上；映射文件又会跟着 `mediaDir` 搬家 ——
一旦搬家没跟上，会话就变成没人引用的孤儿，手一抖删掉就没了。

人设和记忆更脆：人设卡存在 profile 的 `cordis.patch.yml` 里，记忆散在
`soul-md\memory` 和 `fish-memory` 两个目录，都不大，但**丢了没法重建**。

所以每天留一版，成本几乎为零。

## 备份什么

| 层 | 源 | 落点 |
| --- | --- | --- |
| 索引 | `storages\session_projcache\sessions\*.json` | `索引\<日期>\` |
| 本体 | `sessions\<工作区>\<会话ID>\session.v4.jsonl.zstd` | `会话\<工作区名>\<日期>\` |
| 应用状态 | `%APPDATA%\@deepseek-ai\dsh-desktop` 里的 Cookies、Local Storage、logs 等 | `应用状态\<日期>\`（Cookies 被独占，见「Cookies 备不上」一节） |
| 人设 | profile 的 `cordis.patch.yml`（卡片、默认卡、会话映射） | `人设\<日期>\` |
| 记忆 | `soul-md\memory`（每张卡一个 md）+ `fish-memory`（remember 工具） | `记忆\<日期>\<目录名>\` |

### 人设和记忆是哪个插件的？

这两层不归本插件管 —— 本插件只是**把它们抄一份**。数据本身属于另外两个插件，
装没装、装哪个版本、配置成什么样，都会影响备份里有什么：

| 层 | 属于哪个插件 | 它在哪写数据 | 没装会怎样 |
| --- | --- | --- | --- |
| **人设** | [`dsh-soul-md`](https://www.npmjs.com/package/dsh-soul-md)（人设与记忆） | `<DSH_HOME>\profiles\<profile>\cordis.patch.yml` 里 `- id: soul-md` 那一块的 `config.cards`（每张卡一条）+ `cards.active`（默认卡）+ 会话映射。`soulMaxBytes` 也在这里 | 备份里只剩 `<DSH_HOME>\profiles\desktop\cordis.patch.yml` 这个文件的当前内容；没有 soul-md 的配置块，就没有人设卡 |
| **记忆 · 其一** | 同上 `dsh-soul-md` | `<DSH_HOME>\soul-md\memory\<卡名>.md`，每张卡一个 md（还有 `global.md`）。`memory_append` / `memory_read` / `memory_rewrite` 这几个工具写的就是这里 | 目录不存在，这一路自动跳过（不报错） |
| **记忆 · 其二** | [`dsh-fish-memory`](https://github.com/Yuuyuko-uu/dsh-fish-memory)（会话记忆） | `<DSH_HOME>\fish-memory\*.json`，**一个会话一个文件**（`session-<uuid>.json`），QQ 那种还有 `onebot-*.json`；同名 `.bak` 是它自己的备份 | 目录不存在，这一路自动跳过（不报错） |

三个要点：

1. **换插件名/换作者就找不到。** 本插件认的是**目录名**（`<DSH_HOME>\soul-md\memory` 和
   `<DSH_HOME>\fish-memory`），不是 npm 包名。换了别的记忆插件、或者把它配到别的目录，
   得用 `记忆目录` 配置项指过去，否则那一路会静默跳过。
2. **「记忆」是两套东西，别混。** `soul-md\memory` 是**按人设卡**存的（谁在说话就写谁的卡），
   `fish-memory` 是**按会话**存的（这个会话记住了什么）。两套互不覆盖，所以两个目录都备。
3. **人设是「配置」不是「文件」。** 它没有独立的数据文件，就活在 `cordis.patch.yml` 里面。
   所以 `人设\<日期>\cordis.patch.yml` 这个备份**顺带也含了整份 profile 配置**
   （网盘账号、API key、QQ token 等）—— 落盘前会脱敏（见下），但仍建议把备份目录当敏感数据对待。

<details>
<summary>怎么确认自己装的是这两个、以及它们的配置长什么样</summary>

```yaml
# <DSH_HOME>\profiles\desktop\cordis.patch.yml

- id: soul-md                     # ← 人设卡在这里
  name: dsh-soul-md
  config:
    cards:
      小鲸鱼小清: |-              # 每张卡一条，键名就是卡名
        你是「…」，性格…
    active: 小鲸鱼小清             # 默认卡
    soulMaxBytes: 65536

# fish-memory 一般不需要配置，装了就用 <DSH_HOME>\fish-memory
```

两个插件都必须在 profile 的 `package.json` 里同时出现在 `dependencies` **和**
`dsh.profile.bundles` 里才会真正加载 —— 只在 `dependencies` 里是装了但没启用，
那种情况下这两个目录可能还是旧的、或者干脆不存在。

</details>

> 脱敏规则：写 `人设\<日期>\cordis.patch.yml` 之前，`网盘密码` / `网盘令牌` / `密码` /
> `accessToken` / `apiKey` / `token` / `secret` / `密钥` 这些键的值会替换成
> `'***（已脱敏）'`。所以**推上网盘的那份不带你自己的密码**；本机备份目录那份同样是脱敏的
> —— 真要原样留一份配置，得自己另外存。恢复时如果某个密码位是 `***（已脱敏）`，填回原值即可。

默认根目录是 **`<DSH_HOME>\backups`**（默认即 `~\.dsh\backups`，**不在任何工作区里**，清工作区不会伤到它）；`目标目录` 留空就是这个，写了就按写的来。面板「备份记录」页顶部的**备份位置**能直接改。

## 结构

```
_backups\
├── 索引\YYYY-MM-DD\*.json
├── 会话\<工作区名>\YYYY-MM-DD\<会话ID>.zstd
├── 应用状态\YYYY-MM-DD\...
├── 人设\YYYY-MM-DD\cordis.patch.yml     （来自 dsh-soul-md 的 config.cards，已脱敏）
├── 记忆\YYYY-MM-DD\memory\*.md           （来自 dsh-soul-md 的 soul-md\memory，按卡）
├── 记忆\YYYY-MM-DD\fish-memory\*.json    （来自 dsh-fish-memory，按会话）
├── manifest.json        （在 索引\<日期>\ 下，列每个文件的大小、mtime、MD5、校验结果）
├── backup.log           每轮一行流水（备了几个文件、成功还是异常）
├── plugin.log           诊断日志（加载 / 接口 / 网页报错），超 2MB 滚成 plugin.log.1
└── README.md            自动生成的目录说明
```

## Cookies 备不上：浏览器的独占锁

`应用状态\Network\Cookies` 是 Chromium 的 SQLite cookie 库，DSH 跑着的时候它带
**独占锁**：`copyFile`、`CopyFileEx`、`robocopy`、`.NET FileStream` 全都 EBUSY，
连 `open(..., 'r')` 都打不开（2026-11-07 实测：6 秒 40 次尝试，0 次成功；
这台机不是管理员，也没有 SeBackupPrivilege / VSS 那条路）。

所以 **cookie 不能在 DSH 运行时备份**，这不是路径写错。插件现在的处理：

1. 每轮照样试（重试 4 次，撞上不持锁的瞬间就赚了），抄不动就记成
   `skipped: EBUSY`，写进 manifest 的 `应用状态.被占用`，并往 `plugin.log` 告一句。
   以前这里只悄悄 `跳过 += 1`，所以「cookie 一直没备上」很久才被发现。
2. **退出时补抄**：插件挂了 `process.on('exit')`，进程退出那一刻用同步 API 再试一次，
   结果写进 `plugin.log`（找 `退出补抄 ✔ Network\Cookies`）。这是尽力而为 ——
   Electron 的网络服务进程有可能比这个钩子还晚松手。
3. **确定能用的一条路**：关掉 DSH，再跑 `node backup-now.mjs`（或桌面的「立即备份」）。
   这时文件是自由的，一定抄得到；跑完会明确告诉你 cookies 有没有抄上。

`Network\Cookies-journal` 也一样锁着，一起列在 `应用状态项` 里。

## DSH 打不开时先看这里

2026-11-07 01:14–01:16 连崩 4 次，四次完全一样：

```
phase: startup
Error: desktop welcome: Web authentication failed
    at connectDesktopWelcome (…/app.asar/lib/main.js:16856:31)
```

这一行来自桌面版主进程：它拿一个带**本次进程令牌**的 URL，用 Electron 的 cookie 罐
去请求自己的网页服务，拿到非 200（`if (!authenticated.ok) throw`）就中止启动。
**跟会话、插件、备份都没关系**，是「本机网页认证」这一步没过去。

能对上的两个原因，按可能性排：

1. **cookie 罐里是旧的/坏的/串台的凭证**。这一项是这个请求唯一依赖的持久状态；
   把这份 cookie 换成新的之后就好了 —— 它几乎等于全新重建的一份。
2. **上一个实例没退干净**：几次崩溃的时间挨得很近（几秒到几十秒之内），
   像是旧进程还占着 userData 和端口，新进程认证到了别人的服务上。

下次再遇到，按这个顺序试（**插件本身不带修复脚本，也不用装任何东西**）：

1. **先把残留进程结束干净**：任务管理器里结束所有 DSH / Electron 进程（不是只关窗口），等几秒。
2. **把 cookie 罐整个换掉**：把 `%APPDATA%\@deepseek-ai\dsh-desktop\Network` 改名成
   `Network.broken-<时间戳>`，DSH 下次启动会自己重建它。认证凭证每次启动都是新发的，旧的丢掉不影响登录。
3. 再打开 DSH。如果这次换成了别的错（插件加载报错 / 端口被占），去看 `plugin.log` 里对应那一条。
4. **别急着「从备份恢复 cookies」**：旧凭证对新进程本来就没用，反而更像第 1 条那种坏状态。

> 面板第三个页签「离线备份」生成的是**备份**脚本（关掉 DSH 后抄 Cookies 用），不是修启动的；上面这几步都不需要它。

## 左侧栏「备份」面板（0.2.0 起）

左侧栏在「插件」「自动化任务」「MCP」那一组里多一个图标，点开是主区一整页，**四个页签**（备份记录 / 网盘推送 / 离线备份 / 数据来源）：

**页签一 · 备份记录**（看）

- **顶部**：备份根目录、每天几点拍、保留几天；四个数字——已备份天数、总体积、
  上次备份的时间、校验失败个数（只有真的坏了才出现）。
- **每天一张卡**：日期 + 周几（最近两天显示「今天 / 昨天」）+ 文件数 + 体积，
  最新那天标「最新」。点开之后按五层列：索引 / 会话本体 / 应用状态 / 人设 / 记忆，
  每层写着「N 个文件 · 多大」，再点开就能看**具体文件名**（会话那一层按工作区分组，
  鼠标停在组名上会显示它原本是哪个路径）。
- **备份文件管理**：每张卡右边「删除」→ 当场问一句「把这一天的备份（五层一起）删掉？」，
  确认才真删；顶部「立即备份」手动拍一版；「刷新」重读。
- 底部两块折叠日志：**运行日志**（`backup.log` 最近 40 行，备份流水）和
  **诊断日志**（`plugin.log` 最近 120 行，加载 / 接口 / 网页报错），点开才拉。
- 面板打开时拉一次数据，之后每 60 秒自己重读 —— 夜里宿主拍的那版，早上打开就在了。

**页签二 · 网盘推送**（配，1.0.0 起）

一整页表单：总开关、协议（OpenList / WebDAV）、服务地址、静态令牌（或账号密码）、
远端目录（存储名 + 子目录）、远端保留天数、请求超时。按钮三个：

- **保存设置**：走宿主 `configEditor` 服务写进 profile —— 会校验、会和别的 profile
  改动串行、会走正常热重载。**不自己拿正则改用户的 yml**（那样会吃掉注释和 `!!js`）。
- **试连**：只列一次目录，不上传。三种失败分开报：连不上 / 令牌被拒 / 目录不存在。
- **撤销改动**：表单脏了才出现。

令牌和密码**永远不以明文回到网页**：宿主的 `/session-backup/netdisk` 只报
「配没配」+ 末 6 位。输入框留空 = 不改；要真清掉得走接口的 `清空令牌` / `清空密码`。

**页签四 · 数据来源**（看归属 + 扫描 + 自定义路径，1.2.12 起）

这一页解决三件事，都在说「人设和记忆到底是谁的数据、还有什么没在备」：

**① 人设和记忆是谁的** —— 一张对照表写清：人设卡属于 `dsh-soul-md`（存在 profile 的
`cordis.patch.yml` 里）、记忆分两套（`dsh-soul-md` 按人设卡、`dsh-fish-memory` 按会话）。
本插件只负责抄一份，不生产这些数据 —— 免得用户以为「装了备份插件就全都备了」。

**② 扫描：还有哪些数据没在备** —— 点「扫描本机」，插件会看 DSH 家目录、`AppData\Local`、
`AppData\Roaming`、文档这几处的**最多三层**，按「目录名像不像 + 里面装的东西对不对」
双重判断，列出「像人设/记忆数据、但不在当前备份里」的目录，每条带路径、体积、文件数和建议。
只读扫描，不改任何文件。

> ⚠ 扫描会**跟进 junction / symlink**。实测踩过：`StarSeaHub\data` 是个 junction，指向
> `D:\...\星海记忆中枢\Database Library`，真正的人设卡在那儿。用 `readdir` 的
> `withFileTypes` 时 junction 的 `isDirectory()` 是 `false`、`isSymbolicLink()` 是 `true`，
> 只看 `isDirectory()` 会把整棵树漏掉。

**③ 自定义备份路径** —— 除了固定的五层，还可以让你自己指定的目录跟着备。每条可以配：

| 字段 | 说明 |
| --- | --- |
| 路径 | 绝对路径。相对路径会被拒（不知道该相对谁） |
| 备份文件夹名 | **这就是「自定义文件夹名字」的地方**；留空 = 用路径最后一段 |
| 排除 | 空格隔开的通配符，如 `*.tmp *.log node_modules`（`*` `?` 都支持） |
| 单文件上限 | MB，0 = 不限。超过的单个文件跳过，并把这几个文件名记进清单 |

外加全局的「存放子目录」（落点 `<目标目录>\<子目录>\<名字>\<日期>\`）和「整块上限」（MB，0 = 不限）。

**保存前每条都会体检**，三条规则对应三个检查：

| 规则 | 怎么查 | 不合格时 |
| --- | --- | --- |
| 可访问 | `stat` 一次 | 报「路径不存在 / 没权限 / 路径里有一段不是目录」 |
| 可复制 | `open(r)` 真读一次（有些文件能 stat 但打不开，比如被独占） | 报「被别的程序独占 / 没权限读」 |
| 大小限制 | 递归数一遍，跟单文件上限和整块上限比 | 报「整块 X MB 超过上限 Y MB」 |

不合格的条目**不会写进配置** —— 存进去但备份时才发现路径是错的，那才叫坑。
输入框旁边还有点「检查这条」，改完路径先试一遍再存。

插件自己写的那几层之外的目录（`手动`、`音频归档`、`隔离-孤儿会话`）只**统计**不管理，
列在下面一排小药丸里，免得「总体积」看起来对不上账。


## 日志怎么看（两个文件，分工不同）

| 文件 | 记什么 | 什么时候看 |
| --- | --- | --- |
| `backup.log` | 每轮一行流水：备了几个文件、多大、成功还是有异常 | 「今天备了吗」「上一轮为什么跳过」 |
| `plugin.log` | **原因**：加载了什么配置、接口挂上没有、请求被拒、网页那边报了什么错 | 「面板打不开」「接口 404」「白屏」 |

两个都在 `<目标目录>` 下（`目标目录` 留空时是 `<DSH_HOME>\backups\`（默认 `~\.dsh\backups`））。
`plugin.log` 超过 2MB 自动滚成 `plugin.log.1`（只留一代 —— 诊断日志看最近的，
不该在备份目录里长成几十兆）。

`plugin.log` 的几行典型长相：

```
[...] INFO  插件加载 · 目标 D:\…\_backups · 每天 04:30 · 保留 30 天 · 启动补拍 开 · 本体 备 · …
[...] INFO  网页面板接口已挂上 /session-backup/{list,run,delete,log,log-client}
[...] 客户端 面板打开
[...] 客户端 面板渲染出错：Cannot access '其他目录' before initialization
[...] WARN  拒了外来请求 POST /session-backup/log-client → 401
```

排障顺序：**「插件加载」在不在**（插件活着没）→ **「接口已挂上」在不在**
（webServer 那条路通了没）→ **「面板打开」在不在**（浏览器那边渲染到没）→
**有没有「客户端 …」的报错**（前端炸在哪）。

网页半边的错是**主动报上来**的：渲染崩了走错误边界的 `componentDidCatch`，
接口挂了在 fetch 的 catch 里报 —— 浏览器 console 不落盘，没人按 F12 就等于没发生。

## 网页接口（面板用的，也可以自己 curl）

宿主半边在 `webServer` 上挂了十九个路由（拿不到 webServer 的 profile 里自动跳过，不影响定时备份）：

| 方法 | 路径 | 干什么 |
| --- | --- | --- |
| GET | `/session-backup/list` | 配置 + 每天每层的文件明细 + 上次备份 + 其他目录 + 日志尾巴 + 网盘设置（脱敏） |
| POST | `/session-backup/run` | 立刻拍一版，等跑完再回 `{ok,成功,话,文件数,总字节}` |
| POST | `/session-backup/delete` | 体 `{日期:'YYYY-MM-DD'}`，五层一起删，回 `{ok,日期,删掉:[...]}` |
| POST | `/session-backup/push` | 手动把当天备份推一遍网盘 |
| GET | `/session-backup/push-status` | 推送进度：`{ok,运行中,开始于,结果,上次}`；面板每 2 秒问一次 |
| GET | `/session-backup/custom` | 自定义备份路径：当前条目 + 每条的健康状况（可用/原因/大小/文件数） |
| POST | `/session-backup/custom-save` | 存自定义备份。**每条先体检**，不合格的当场报错且不写入 |
| POST | `/session-backup/custom-check` | 单条体检：体 `{路径,块上限MB,最大单文件MB}` → `{可用,原因,大小,文件数,字节}` |
| GET | `/session-backup/scan` | 扫描人设/记忆数据散在哪儿（只读）：`{发现,已在备,扫描根}` |
| GET | `/session-backup/netdisk` | 网盘设置（令牌/密码只回「配没配」+ 末 6 位） |
| POST | `/session-backup/netdisk-save` | 存网盘设置，走 `configEditor`；回 `{ok,改了:[...]}` |
| POST | `/session-backup/netdisk-test` | 试连（只列目录，不上传）；回 `{ok,成功,话}` |
| GET | `/session-backup/log?lines=100&which=backup` | `backup.log` 或 `plugin.log`（`which=plugin`）最后 N 行（1..500） |
| POST | `/session-backup/log-client` | 网页半边报错专用：体 `{message, detail}` → 写进 `plugin.log` |
| GET | `/session-backup/offline` | 离线备份脚本状态：装没装、脚本与 cmd 的路径 |
| POST | `/session-backup/offline-install` | 把自包含的备份脚本写到 `<目标目录>\离线备份\`，回 `{ok,脚本,cmd}` |
| POST | `/session-backup/offline-open` | 在资源管理器里打开脚本所在目录（没装则 400） |
| GET | `/session-backup/where` | 备份位置：当前目录、默认目录、来源（默认 / 自定义）、`DSH_HOME` |
| POST | `/session-backup/where-save` | 存备份位置，走 `configEditor`；回 `{ok,改了:[...]}` |

所有 POST 会先问 `connection.requestRejection`：不是这个浏览器会话发来的就 401/403，
所以别处（包括别的网页）不能靠它们删备份、改配置、往日志里灌字。`delete` 的日期**自己再校验一遍**
`YYYY-MM-DD` 才拼路径 —— 这个字符串会进 `rm`，不校验等于把删盘权交出去。
`log` 的 `which` 也只认白名单里那两个名字，不是任意文件读取的口子。
`netdisk-save` 只认白名单字段（网盘那 9 个），**碰不到 `目标目录`/`保留天数`** ——
表单只负责网盘，别的一改就可能把备份路径弄丢。


路由注册在 `ctx.inject(['webServer'], …)` 里，**不能**用 `ctx.get('webServer')`：
冷启动时 webServer 往往比插件晚起来，`ctx.get` 那一刻是 `undefined`，
一路 return 下去面板就永远 404（2026-11-07 01:00 重启后就是这么坏的 ——
`backup.log` 里有「启动补拍」，接口却全 404）。`ctx.inject` 会等服务真在线上再挂。
排障口诀：**面板说「读不到备份情况」就先 `curl /session-backup/list`**，
404 = 接口没挂上（webServer 那条路断了），200 = 是前端或字段的事。

「立即备份」和每日定时共用一把锁：撞上了就排队，不会两轮同时往同一批文件 `copyFile`。

## 怎么工作

1. **启动后补拍一次**（默认延迟 60 秒）—— 机器不会天天开着，光靠定时会漏。
2. **每 60 秒看一次墙钟**：到点（默认 `04:30`）、当天还没拍过 → 拍一版。
   用 tick 而不是几小时的长定时器，是为了扛休眠/唤醒和系统时间改动。
3. 拷完**核对字节数 + MD5**，不一致记成 `size-mismatch`（备份最怕"看着有文件其实是半截"）。
4. 每次在被备目录里写 `manifest.json`，带 `附加备份: 人设=N 记忆=N` 的统计。
5. 超过 `保留天数` 的日期目录整个删掉（索引、会话、应用状态、人设、记忆 都清）。

## 配置

改 profile 的 `cordis.patch.yml` 里 `- id: session-backup` 那段：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉就整个不启用 |
| `源目录` | `''` | 空 = `<DSH_HOME>/storages/session_projcache/sessions` |
| `目标目录` | `''` | 备份根；留空 = `<DSH_HOME>\backups`（默认 `~\.dsh\backups`），面板可改 |
| `索引子目录` / `会话子目录` | `索引` / `会话` | 根下面两个子目录名 |
| `会话文件` | `['onebot-*.json']` | 索引匹配规则，支持 `*` `?` |
| `每天几点` | `'04:30'` | 24 小时制本地时间，**要加引号** |
| `保留天数` | `14` | 更早的日期目录整个删 |
| `启动后立刻备份` / `启动延迟秒` | `true` / `60` | 启动补拍开关与延迟 |
| `备份本体` / `本体目录` | `true` / `''` | 空 = `<DSH_HOME>/sessions` |
| `备份应用状态` / `应用状态目录` / `应用状态项` | `true` / `''` / 见源码 | 网页端 Cookies 等 |
| `备份人设` / `人设配置` | `true` / `''` | 空 = `<DSH_HOME>/profiles/desktop/cordis.patch.yml`（**人设卡本体属于 `dsh-soul-md`**） |
| `备份记忆` / `记忆目录` | `true` / `[]` | 空 = `[<DSH_HOME>/soul-md/memory, <DSH_HOME>/fish-memory]`（**前者属于 `dsh-soul-md`，后者属于 `dsh-fish-memory`**；换插件/换目录时在这里指过去） |
| `自定义备份` | `[]` | 自己指定的备份路径，每条形如 `{路径, 名称, 启用, 排除, 块上限MB, 最大单文件MB}`。落 `<目标目录>\<自定义子目录>\<名称>\<日期>\` |
| `自定义子目录` | `'自定义'` | 上面那批的落点子目录名 |
| `自定义块上限MB` / `自定义单文件上限MB` | `0` / `0` | 0 = 不限；条目里可以单独覆盖。超过的跳过并记进清单的校验说明 |
| `推送网盘` | `false` | 备份成功后把当天备份推到网盘（面板「网盘推送」页签可改） |
| `网盘协议` | `openlist` | `openlist`（本机 OpenList HTTP API）或 `webdav`（PUT/MKCOL） |
| `网盘地址` | `http://127.0.0.1:5244` | OpenList 地址（webdav 协议时填 WebDAV 端点） |
| `网盘令牌` | `''` | OpenList 静态令牌（设置里生成，绕开 2FA）；webdav 用下面两个 |
| `网盘用户名` / `网盘密码` | `''` / `''` | webdav 协议才用 |
| `网盘根目录` | `百度网盘` | OpenList 里挂载的存储名（百度网盘/夸克…） |
| `网盘子目录` | `DSH备份` | 在网盘里再套一层目录 |
| `网盘保留天数` | `0` | 0 = 远端不删（全留） |
| `网盘超时秒` | `30` | 单个请求超时 |

上面这 9 个网盘键都可以在**插件页面的「网盘推送」页签**里改，不用手改 yml。


## 网盘推送（0.2.3 起）

每天备份成功后，把当天的备份**原样**推到网盘，远端结构跟本地一致：

```
<网盘子目录>\YYYY-MM-DD\索引\...
<网盘子目录>\YYYY-MM-DD\会话\<工作区名>\*.zstd
<网盘子目录>\YYYY-MM-DD\应用状态\...
<网盘子目录>\YYYY-MM-DD\人设\...
<网盘子目录>\YYYY-MM-DD\记忆\...
```

**默认协议 openlist（本机 OpenList，alist 系）**：

- ⚠ 实测 OpenList 的 `/dav` WebDAV 是**只读**的（Allow 头里没有 PUT/MKCOL，PUT 一律 404），
  上传只能走它的 HTTP API：`POST /api/fs/mkdir`（建目录）+ `PUT /api/fs/put`（上传，路径放 `File-Path` 头）。
- 认证用**静态令牌**（OpenList 网页 → 设置 → 其他 → Token），绕开 2FA ——
  账号密码登录会撞 2FA，别用那条路。
- 推到的位置：OpenList 挂载的存储（默认 `百度网盘`）下 `<网盘子目录>\<日期>\`，按层分目录。
- **0 字节空文件直接跳过**：百度网盘上传接口不收空文件（errno 2），`Cookies-journal` 这种
  空文件会拖成「部分失败」，跳过才干净。
- 推不动的文件记下来不中断（网盘是额外保险，不能反过来拖垮备份）。
- 面板「网盘推送」页签显示上次推送结果，按钮「推送网盘」可手动补推。
- **手动推送接口**：`POST /session-backup/push`（同样过本机会话校验）。它**只负责开跑就返回**（一轮要 6–8 分钟，同步等会让浏览器超时误报失败），进度靠 `GET /session-backup/push-status` 轮询。

**webdav 协议**（想连坚果云 `dav.jianguoyun.com` 这类支持 PUT/MKCOL 的）：把 `网盘协议` 改成
`webdav`、`网盘地址` 填端点、`网盘用户名/密码` 填账号。

⚠ **想连「关闭 DSH 后手动备份」一起推**（那是 Cookies 唯一能备全的时候）：
把 `backup-config.json` 里也配上同样的网盘配置，再 `node backup-now.mjs`。

## 备份位置（1.2.0 起默认在 DSH 家里）

**默认 `<DSH_HOME>\backups`**（`DSH_HOME` 没设就是 `~\.dsh`），即：

```
C:\Users\<你>\.dsh\backups\
├── 索引\YYYY-MM-DD\
├── 会话\<工作区>\YYYY-MM-DD\
├── 应用状态\YYYY-MM-DD\
├── 人设\YYYY-MM-DD\
├── 记忆\YYYY-MM-DD\
├── 离线备份\               ← 「离线备份」页签装的脚本
├── backup.log  plugin.log
└── 网盘推送状态.json
```

为什么放这儿：

- **跟着 DSH 走**。`DSH_HOME` 设到别的盘（比如 `E:\dsdata`），备份自动跟着去 `E:\dsdata\backups`。
- **不会污染主目录根**。1.0.x 用的是 `%USERPROFILE%\dsh-session-backup`，
  会在 `C:\Users\<你>\` 下凭空多一个目录。
- **卸载好找**。想清掉就删 `~\.dsh\backups` 一处，不会有残留散在别处。
- **不在任何工作区里**，清工作区、搬家都不会伤到它。

### 改位置

面板「备份记录」页顶部的 **备份位置** 区块：

| 字段 | 说明 |
| --- | --- |
| 目录 | 留空 = 用默认（`<DSH_HOME>\backups`）。填绝对路径就按填的来 |
| 保留天数 | 1–3650，更早的日期目录整个删 |
| 每天几点 | `HH:MM`，24 小时制本地时间 |
| 启动延迟 | DSH 起来后等几秒补拍 |

**换目录不会搬旧备份**（那是几 GB，静默搬会让人以为卡住）。保存后提示会告诉你
新旧两个目录各在哪，旧的自己处理。

三道保护：

1. 保存前**真的 mkdir 一次** —— 建不出来当场报，不会写完配置才发现路径是坏的
2. **不许指到源目录/本体目录里面** —— 那会变成自己抄自己，越抄越大（会被拒绝）
3. 只改白名单那 4 个键，碰不到网盘配置和别的东西

⚠ **填了绝对路径就不会跟着 `DSH_HOME` 走**了。想换机器/换盘还自动跟随，就把这栏留空。

## 离线备份：把 Cookies 也备上（1.1.0 起）

### 为什么需要它

`应用状态\Network\Cookies` 是 Chromium 的 SQLite cookie 库，**DSH 跑着的时候它是独占锁死的**：

```
Network\Cookies           ✘ 锁着 (49152 B)   ← copyFile / CopyFileEx / robocopy /
Network\Cookies-journal   ✔ 能读 (0 B)          .NET FileStream 连 Share.ReadWrite 强开都失败
Preferences / Local State / leveldb ✓ 能读       非管理员没有 SeBackupPrivilege，也没有 VSS
```

这不是路径写错，是那个文件在 DSH 运行期间**物理上读不了**。

`process.on('exit')` 那个补抄钩子也救不了：13 天里只触发过 1 次，那次 cookie 还是 `EBUSY`。
Electron 退出时常常直接把进程收掉，JS 钩子来不及跑。

### 怎么办：装一个本地脚本

面板第三个页签「离线备份」→ 点**装到本机**。它会生成：

```
<目标目录>\离线备份\
├── 离线备份.mjs            自包含的备份脚本（不 import 插件包）
└── 双击我-离线备份.cmd     双击就跑
```

双击那个 `.cmd`，脚本做三件事：

1. **结束 DSH**（含子进程），等它真退干净（最多 45 秒，不行就强杀）
2. **备份**索引 / 会话本体 / 应用状态（**这时 Cookies 一定抄得到**）/ 人设 / 记忆
3. **把 DSH 开回来**（只有它原先在跑才会开）

结果同时写进 `plugin.log` 和 `backup.log`，面板上能看到。

### 为什么脚本是自包含的

脚本里**内联**了抄文件的逻辑，不 `import` 插件包。理由很实在：插件升级、搬家、
被卸载之后，桌面那个双击还得能用；靠 import 一条路径，迟早因为包挪位而断。

### 它用的是哪个 node

不是用户装的 node，是 **DSH 自带的**那份：

```
D:\…\AHa\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
```

通过 `process.resourcesPath` 找（不管 DSH 装在 C 盘还是 D 盘都对），
找不到才退回 `PATH` 里的 `node`。

⚠ 不能用 `process.execPath` —— DSH 是 Electron，那个指向 `DeepSeek Harness.exe`，
拿它跑 `.mjs` 会变成"又开一个 DSH"。

### 另一条路：`backup-now.mjs`

插件包里也有 `backup-now.mjs`，可以 `node backup-now.mjs` 直接跑。它跟面板
「立即备份」走同一套逻辑，但**同样需要 DSH 关着**才拿得到 Cookies。

配置从哪来（按优先级）：

1. `--config <路径>`
2. 同目录 `backup-config.json`
3. 都没有 → 走插件默认值（不再崩；1.0.4 之前是硬读，发布版因此一点就 ENOENT）

环境变量 `DSH_BACKUP_TARGET` 可以覆盖目标目录。

## 手动跑一轮

```powershell
node backup-now.mjs
```

用的是同目录 `backup-config.json` 里的配置，走的是同一个 `跑一轮()`。
桌面上还有一个「立即备份.cmd」，双击就跑一次，不用开终端。

## 改完代码怎么生效

- **宿主半边**（`lib/host.js` / `package.json` 的 `dsh.client`）：不用关 app 重启。
  开着 HMR 的 profile 里，**存一下 profile 的 `cordis.patch.yml`**
  （`%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml`，哪怕只改一行注释）
  就会触发一次 profile 重组；重组会把「链接包里改过的文件」换掉，
  插件以新代码重启，路由和网页面板一起上新。实测 2026-11-07 新增的 `/session-backup/*`
  就是这么上线的。
- **网页半边**（`client.js`）：存盘后客户端 HMR 自己重载，左侧栏的图标当场就出现；
  要稳妥就刷一下页面。
- 手动入口 `backup-now.mjs` 一直是直接读文件跑的，改完立刻能用，不受上面这些影响。
