/**
 * dsh-session-backup · 网页半边
 * ============================================================================
 * 左侧栏多一栏「备份」（跟插件 / 自动化任务那组面板按钮一起，order 90），
 * 点开就是一个主区页面：哪几天备过、每一天里索引 / 会话本体 / 应用状态 /
 * 人设 / 记忆各备了哪些文件、多大，逐层能展开看文件名；还能手动跑一轮、
 * 把某一天的备份整个删掉。
 *
 * 数据全往宿主要，网页这边不留副本：
 *   GET  /session-backup/list              日期们 + 每层文件 + 上次备份 + 日志
 *   POST /session-backup/run               立刻拍一版
 *   POST /session-backup/delete  { 日期 }   删掉某一天（五层一起删）
 * 面板打开时拉一次，之后每 60 秒自己重读 —— 放着不动，宿主夜里拍的那版也会自己出现。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-backup',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/session-backup'

    /**
     * 把网页这边的错误写进宿主的 `plugin.log`。
     *
     * 浏览器 console 只有按 F12 才看得见 —— 2026-11-07 面板白屏那次，报错就只
     * 活在 console 里，最后是读代码把 bug 猜出来的。往后这类错直接落盘。
     * 一律 fire-and-forget：报错这件事本身绝不能再抛。
     */
    const 报告给宿主 = (标题, 详情) => {
      try {
        void fetch(API + '/log-client', {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            message: String(标题 || ''),
            detail: String((详情 && (详情.stack || 详情.message)) || 详情 || ''),
          }),
        }).catch(() => {})
      } catch {
        // 报不上就算了
      }
    }

    // 五层备份，顺序就是展示顺序：越靠上越小越常看
    const 层们 = [
      { 键: '索引', 名: '索引', 说明: '投影缓存，渲染对话用的消息视图' },
      { 键: '会话', 名: '会话本体', 说明: '真正的聊天记录，丢了只能靠它', 分组: true },
      { 键: '应用状态', 名: '应用状态', 说明: '网页端 Cookies / Local Storage / logs' },
      { 键: '人设', 名: '人设', 说明: 'profile 的 cordis.patch.yml（人设卡都在这）' },
      { 键: '记忆', 名: '记忆', 说明: 'soul-md 的卡记忆 + remember 工具写的记忆' },
    ]

    const 周 = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    const 补 = (n) => String(n).padStart(2, '0')

    // ---------------------------------------------------------------- 小工具

    const 格式化字节 = (n) => {
      const 值 = Number(n)
      if (!Number.isFinite(值) || 值 <= 0) return '0 B'
      if (值 < 1024) return 值 + ' B'
      if (值 < 1024 * 1024) return (值 / 1024).toFixed(1) + ' KB'
      if (值 < 1024 * 1024 * 1024) return (值 / 1024 / 1024).toFixed(1) + ' MB'
      return (值 / 1024 / 1024 / 1024).toFixed(2) + ' GB'
    }

    const 格式化时刻 = (iso) => {
      if (!iso) return ''
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return ''
      return 补(d.getMonth() + 1) + '-' + 补(d.getDate()) + ' ' + 补(d.getHours()) + ':' + 补(d.getMinutes())
    }

    const 今天键 = () => {
      const d = new Date()
      return d.getFullYear() + '-' + 补(d.getMonth() + 1) + '-' + 补(d.getDate())
    }

    // 日期一律按本地「YYYY-MM-DD」字符串比较，不经过 Date（省掉时区那堆事）
    const 昨天键 = () => {
      const d = new Date()
      d.setDate(d.getDate() - 1)
      return d.getFullYear() + '-' + 补(d.getMonth() + 1) + '-' + 补(d.getDate())
    }

    const 相对日 = (日期) => {
      if (日期 === 今天键()) return '今天'
      if (日期 === 昨天键()) return '昨天'
      const d = new Date(日期 + 'T00:00:00')
      return Number.isNaN(d.getTime()) ? '' : 周[d.getDay()]
    }

    const 层数据 = (日, 键) => {
      const 值 = 日 && 日[键]
      if (!值 || typeof 值 !== 'object') return { 文件数: 0, 字节: 0, 文件: [] }
      return 值
    }

    // ---------------------------------------------------------------- 样式

    const CSS = `
.sb-root { height: 100%; overflow-y: auto; overscroll-behavior: contain; }
.sb-page { max-width: 940px; margin: 0 auto; padding: 30px 30px 72px; color: var(--dsw-alias-label-primary, inherit); }
.sb-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; flex-wrap: wrap; }
.sb-kicker { font-size: 11px; letter-spacing: .10em; font-weight: 600; text-transform: uppercase; color: var(--dsw-alias-brand-primary, #4d7cfe); }
.sb-title { margin: 6px 0 8px; font-size: 24px; line-height: 1.2; font-weight: 650; }
.sb-sub { margin: 0; max-width: 640px; font-size: 12.5px; line-height: 1.75; color: var(--dsw-alias-label-secondary, #8a8f98); }
.sb-sub code { font-family: inherit; font-size: 12px; padding: 1px 5px; border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14)); color: var(--dsw-alias-label-primary, inherit); }
.sb-actions { display: flex; gap: 8px; flex-wrap: wrap; padding-top: 4px; }
.sb-btn { padding: 7px 13px; border-radius: 8px; font-size: 12.5px; font-family: inherit; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.32)); background: transparent; color: inherit;
  transition: background .15s, border-color .15s; }
.sb-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14)); }
.sb-btn:disabled { opacity: .5; cursor: default; }
.sb-btn-primary { background: var(--dsw-alias-brand-primary, #3b82f6); border-color: var(--dsw-alias-brand-primary, #3b82f6); color: #fff; }
.sb-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-brand-primary, #3b82f6); filter: brightness(1.08); }
.sb-btn-danger { color: var(--dsw-alias-state-error-primary, #ef4444); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 45%, transparent); }
.sb-btn-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 14%, transparent); }
.sb-btn-solid-danger { background: var(--dsw-alias-state-error-primary, #ef4444); border-color: var(--dsw-alias-state-error-primary, #ef4444); color: #fff; }
.sb-btn-solid-danger:hover:not(:disabled) { filter: brightness(1.06); }

.sb-stats { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
.sb-stat { padding: 8px 12px; border-radius: 9px; font-size: 11px; line-height: 1.45;
  color: var(--dsw-alias-label-secondary, #8a8f98);
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.07));
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18)); }
.sb-stat b { display: block; margin-top: 2px; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
.sb-stat-bad b { color: var(--dsw-alias-state-error-primary, #ef4444); }

.sb-notice { margin-top: 14px; padding: 9px 13px; border-radius: 9px; font-size: 12px; line-height: 1.6; }
.sb-notice[data-kind="ok"] { color: var(--dsw-alias-state-success-primary, #22c55e);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 32%, transparent); }
.sb-notice[data-kind="warn"] { color: var(--dsw-alias-state-warn-primary, #f59e0b);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 32%, transparent); }
.sb-notice[data-kind="bad"] { color: var(--dsw-alias-state-error-primary, #ef4444);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 32%, transparent); }

.sb-empty { margin-top: 22px; padding: 30px 24px; border-radius: 12px; text-align: center;
  border: 1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,.32));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.05)); }
.sb-empty-title { font-size: 14px; font-weight: 600; }
.sb-empty-sub { margin-top: 6px; font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-secondary, #8a8f98); }
.sb-empty .sb-btn { margin-top: 14px; }

.sb-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 22px 0 2px; }
.sb-toolbar-label { font-size: 12px; font-weight: 600; }
.sb-toolbar-hint { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.sb-toolbar-spacer { flex: 1; }
.sb-toolbar .sb-btn { padding: 5px 10px; font-size: 11.5px; border-radius: 7px; }

.sb-day { margin-top: 10px; border-radius: 11px; overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.20));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.05)); }
.sb-day[data-open="1"] { border-color: var(--dsw-alias-border-l2, rgba(128,128,128,.34)); }
.sb-day-head { display: flex; align-items: center; gap: 4px; padding-right: 8px; }
.sb-day-toggle { display: flex; align-items: center; gap: 9px; flex: 1; min-width: 0;
  padding: 12px 4px 12px 14px; font-family: inherit; font-size: 13px; text-align: left; cursor: pointer;
  border: 0; background: transparent; color: inherit; }
.sb-day-toggle:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.09)); }
.sb-caret { flex: none; width: 11px; font-size: 10px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.sb-caret svg { display: block; transition: transform .16s ease; }
.sb-caret[data-open="1"] svg { transform: rotate(90deg); }
.sb-day-name { font-weight: 600; font-variant-numeric: tabular-nums; }
.sb-week { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.sb-badge { font-size: 10px; padding: 1.5px 6px; border-radius: 999px; font-weight: 600;
  color: var(--dsw-alias-brand-primary, #4d7cfe);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 14%, transparent); }
.sb-badge-bad { font-size: 10px; padding: 1.5px 6px; border-radius: 999px; font-weight: 600;
  color: var(--dsw-alias-state-error-primary, #ef4444);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 14%, transparent); }
.sb-day-size { margin-left: auto; font-size: 12px; font-variant-numeric: tabular-nums; }
.sb-day-count { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #8a8f98); font-variant-numeric: tabular-nums; }
.sb-day-del { flex: none; padding: 4px 9px; font-size: 11px; border-radius: 7px; font-family: inherit; cursor: pointer;
  border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); }
.sb-day-del:hover { color: var(--dsw-alias-state-error-primary, #ef4444);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 40%, transparent); }

.sb-body { padding: 0 14px 12px; }
.sb-layer { border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.16)); }
.sb-layer-head { display: flex; align-items: baseline; gap: 9px; width: 100%; padding: 8px 2px;
  font-family: inherit; font-size: 12px; text-align: left; cursor: pointer;
  border: 0; background: transparent; color: inherit; }
.sb-layer-head:hover { color: var(--dsw-alias-brand-primary, #4d7cfe); }
.sb-layer-head:disabled { cursor: default; opacity: .55; }
.sb-layer-head:disabled:hover { color: inherit; }
.sb-layer-name { font-weight: 600; }
.sb-layer-meta { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, #8a8f98); }
.sb-layer-note { margin-left: auto; font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.sb-files { max-height: 264px; overflow: auto; overscroll-behavior: contain;
  padding: 2px 0 8px 20px; }
.sb-ws { padding: 3px 0; }
.sb-ws-head { display: flex; align-items: baseline; gap: 8px; padding: 3px 0; font-size: 11.5px; font-weight: 600; }
.sb-ws-meta { font-weight: 400; font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.sb-file { display: flex; align-items: baseline; gap: 12px; padding: 1.5px 0; font-size: 11px; }
.sb-file-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-secondary, #8a8f98); }
.sb-file-size { flex: none; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, #8a8f98); }
.sb-more { padding: 4px 0 2px; font-size: 10.5px; color: var(--dsw-alias-state-warn-primary, #f59e0b); }

.sb-confirm { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 4px 14px 12px 34px; font-size: 12px; }
.sb-confirm-text { color: var(--dsw-alias-state-error-primary, #ef4444); }
.sb-confirm .sb-btn { padding: 5px 11px; font-size: 11.5px; }

.sb-others { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 14px; }
.sb-other { padding: 4px 10px; border-radius: 999px; font-size: 11px;
  color: var(--dsw-alias-label-secondary, #8a8f98);
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.20));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.05)); }
.sb-other b { font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }

.sb-log { margin-top: 26px; }
.sb-log-head { display: flex; align-items: center; gap: 8px; padding: 6px 2px;
  font-family: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
  border: 0; background: transparent; color: inherit; }
.sb-log-head:hover { color: var(--dsw-alias-brand-primary, #4d7cfe); }
.sb-log-meta { font-weight: 400; font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.sb-log-body { margin-top: 6px; max-height: 260px; overflow: auto; overscroll-behavior: contain;
  padding: 10px 12px; border-radius: 9px; font-size: 11px; line-height: 1.7;
  white-space: pre-wrap; word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--dsw-alias-label-secondary, #8a8f98);
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.07));
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18)); }
.sb-log-line { display: block; }
.sb-log-line[data-bad="1"] { color: var(--dsw-alias-state-error-primary, #ef4444); }

.sb-foot { margin-top: 30px; font-size: 11px; line-height: 1.75; color: var(--dsw-alias-label-secondary, #8a8f98); }
.sb-foot code { font-family: inherit; font-size: 11px; padding: 1px 4px; border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14)); }

/* ---- 页签（备份记录 / 网盘推送）---- */
.sb-tabs { display: flex; gap: 2px; margin: 20px 0 0; padding: 3px; width: fit-content;
  border-radius: 9px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)); }
.sb-tab { padding: 6px 15px; border-radius: 7px; font-family: inherit; font-size: 12.5px; cursor: pointer;
  border: 0; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); }
.sb-tab:hover { color: var(--dsw-alias-label-primary, inherit); }
.sb-tab[data-on="1"] { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.22));
  color: var(--dsw-alias-label-primary, inherit); font-weight: 600; }
.sb-tab-num { margin-left: 5px; font-size: 10.5px; opacity: .7; font-variant-numeric: tabular-nums; }

/* ---- 网盘设置表单 ---- */
.sb-form { margin-top: 16px; border-radius: 11px; overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.20));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.05)); }
.sb-form-head { padding: 13px 16px 11px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.16)); }
.sb-form-title { font-size: 13px; font-weight: 650; }
.sb-form-sub { margin-top: 4px; font-size: 11.5px; line-height: 1.65; color: var(--dsw-alias-label-secondary, #8a8f98); }
.sb-form-body { padding: 14px 16px 16px; display: grid; gap: 11px; }
.sb-row { display: grid; grid-template-columns: 152px 1fr; gap: 12px; align-items: start; }
.sb-row-label { padding-top: 7px; font-size: 12px; }
.sb-row-label small { display: block; margin-top: 2px; font-size: 10.5px; line-height: 1.5;
  color: var(--dsw-alias-label-secondary, #8a8f98); }
.sb-row-ctl { display: flex; gap: 7px; align-items: center; flex-wrap: wrap; min-width: 0; }
.sb-input, .sb-select { box-sizing: border-box; width: 100%; min-width: 0; padding: 6px 10px; border-radius: 7px;
  font-family: inherit; font-size: 12px; color: inherit;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.32));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06)); }
.sb-input:focus, .sb-select:focus { outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6); outline-offset: -1px; }
.sb-input:disabled, .sb-select:disabled { opacity: .55; }
.sb-input-narrow { width: 96px; }
.sb-secret { display: flex; align-items: center; gap: 7px; width: 100%; }
.sb-secret .sb-input { flex: 1; }
.sb-chip { font-size: 10.5px; padding: 2px 8px; border-radius: 999px; white-space: nowrap;
  color: var(--dsw-alias-label-secondary, #8a8f98);
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.24)); }
.sb-chip[data-ok="1"] { color: var(--dsw-alias-state-success-primary, #22c55e);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 40%, transparent); }
.sb-switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 12px; }
.sb-switch input { width: 15px; height: 15px; accent-color: var(--dsw-alias-brand-primary, #3b82f6); cursor: pointer; }
.sb-form-foot { display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
  padding: 12px 16px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.16));
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.05)); }
.sb-form-foot .sb-btn { padding: 6px 13px; font-size: 12px; }
.sb-form-hint { margin-left: auto; font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.sb-callout { padding: 9px 13px; border-radius: 8px; font-size: 11.5px; line-height: 1.7;
  color: var(--dsw-alias-label-secondary, #8a8f98);
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.09)); }
.sb-callout b { color: var(--dsw-alias-label-primary, inherit); font-weight: 600; }
`

    // ---------------------------------------------------------------- 图标

    // 跟左侧栏其它栏目一样的单色线框图标（继承当前文字颜色）：
    // 一个带盖子的备份箱 + 往下的箭头 —— 一眼是「存档 / 回滚」那类东西。
    function 备份图标(props) {
      const size = typeof props.size === 'number' ? props.size : 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: 'M3.4 7.2h17.2' }),
        h('path', { d: 'M5.1 7.2V19a1.6 1.6 0 0 0 1.6 1.6h10.6a1.6 1.6 0 0 0 1.6-1.6V7.2' }),
        h('path', { d: 'M4.1 3.4h15.8a.8.8 0 0 1 .8.8v3H3.3v-3a.8.8 0 0 1 .8-.8Z' }),
        h('path', { d: 'M12 10.4v6.6' }),
        h('path', { d: 'M9.5 14.5 12 17l2.5-2.5' }),
      )
    }

    // ---------------------------------------------------------------- 备份位置

    /**
     * 「备份位置」表单：改目标目录 / 保留天数 / 每天几点 / 启动延迟。
     *
     * 为什么单独一块、不塞进「网盘推送」那张表：这两件事的风险不一样。
     * 网盘配错了只是推不上去；**位置改错了，备份就散在别处找不着了**。
     * 所以这里把「当前在哪、是不是默认、改完旧的还在不在」都摊开说清楚。
     */
    function 位置设置({ 设置, 读 }) {
      const [表单, set表单] = React.useState({
        目标目录: (设置 && 设置.目标目录) || '',
        保留天数: (设置 && 设置.保留天数) || 14,
        每天几点: (设置 && 设置.每天几点) || '04:30',
        启动延迟秒: (设置 && 设置.启动延迟秒) || 60,
      })
      const [脏, set脏] = React.useState(false)
      const [保存中, set保存中] = React.useState(false)
      const [结果, set结果] = React.useState(null)

      React.useEffect(() => {
        if (脏 || !设置) return
        set表单({
          目标目录: 设置.目标目录 || '',
          保留天数: 设置.保留天数 || 14,
          每天几点: 设置.每天几点 || '04:30',
          启动延迟秒: 设置.启动延迟秒 || 60,
        })
      }, [设置, 脏])

      const 改 = (键, 值) => {
        set表单((旧) => ({ ...旧, [键]: 值 }))
        set脏(true)
        set结果(null)
      }

      const 保存 = async () => {
        set保存中(true)
        set结果(null)
        try {
          const r = await fetch(API + '/where-save', {
            method: 'POST',
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(表单),
          })
          const j = await r.json().catch(() => null)
          if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || 'HTTP ' + r.status)
          const 换了 = j.旧目录 !== j.新目录
          set结果({
            kind: 'ok',
            text:
              (j.改了 && j.改了.length ? '已保存：' + j.改了.join('、') : '没有改动') +
              (换了 ? '　新备份会写到 ' + j.新目录 + '；旧的那份还在 ' + j.旧目录 + '，没搬也没删' : ''),
          })
          set脏(false)
          await 读()
        } catch (失败) {
          set结果({ kind: 'bad', text: '保存失败：' + String((失败 && 失败.message) || 失败) })
        } finally {
          set保存中(false)
        }
      }

      const 行 = (标签, 说明, 控件) =>
        h(
          'div',
          { className: 'sb-row' },
          h('label', { className: 'sb-row-label' }, 标签, 说明 ? h('small', null, 说明) : null),
          h('div', { className: 'sb-row-ctl' }, 控件),
        )

      return h(
        'div',
        { className: 'sb-form' },
        h(
          'div',
          { className: 'sb-form-head' },
          h('div', { className: 'sb-form-title' }, '备份位置'),
          h(
            'div',
            { className: 'sb-form-sub' },
            '留空就用默认位置（DSH 自己的家目录下的 backups，卸载/换机器都好找）。' +
              '填了绝对路径就按你填的来 —— 注意填了就**不会**跟着 DSH_HOME 走。',
          ),
        ),
        h(
          'div',
          { className: 'sb-form-body' },
          行(
            '目录',
            (设置 && 设置.目标目录来源 === '默认' ? '现在是默认位置' : '现在是自己指定的') +
              '；留空 = ' + ((设置 && 设置.默认目录) || ''),
            h('input', {
              className: 'sb-input',
              type: 'text',
              value: 表单.目标目录,
              placeholder: (设置 && 设置.默认目录) || '留空用默认位置',
              onChange: (事件) => 改('目标目录', 事件.target.value),
            }),
          ),
          行(
            '保留天数',
            '更早的日期目录会被整个删掉',
            h(
              'div',
              { className: 'sb-row-ctl', style: { flexWrap: 'nowrap' } },
              h('input', {
                className: 'sb-input sb-input-narrow',
                type: 'number',
                min: 1,
                max: 3650,
                value: 表单.保留天数,
                onChange: (事件) => 改('保留天数', 事件.target.value),
              }),
              h('span', { className: 'sb-chip' }, '天'),
            ),
          ),
          行(
            '每天几点',
            '24 小时制，本地时间',
            h(
              'div',
              { className: 'sb-row-ctl', style: { flexWrap: 'nowrap' } },
              h('input', {
                className: 'sb-input sb-input-narrow',
                type: 'text',
                value: 表单.每天几点,
                placeholder: '04:30',
                onChange: (事件) => 改('每天几点', 事件.target.value),
              }),
            ),
          ),
          行(
            '启动延迟',
            'DSH 起来后等多久再补拍（秒）',
            h(
              'div',
              { className: 'sb-row-ctl', style: { flexWrap: 'nowrap' } },
              h('input', {
                className: 'sb-input sb-input-narrow',
                type: 'number',
                min: 0,
                max: 600,
                value: 表单.启动延迟秒,
                onChange: (事件) => 改('启动延迟秒', 事件.target.value),
              }),
              h('span', { className: 'sb-chip' }, '秒'),
            ),
          ),
        ),
        h(
          'div',
          { className: 'sb-form-foot' },
          h(
            'button',
            { type: 'button', className: 'sb-btn sb-btn-primary', disabled: 保存中, onClick: 保存 },
            保存中 ? '保存中…' : '保存设置',
          ),
          脏
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'sb-btn',
                  disabled: 保存中,
                  onClick: () => {
                    set表单({
                      目标目录: (设置 && 设置.目标目录) || '',
                      保留天数: (设置 && 设置.保留天数) || 14,
                      每天几点: (设置 && 设置.每天几点) || '04:30',
                      启动延迟秒: (设置 && 设置.启动延迟秒) || 60,
                    })
                    set脏(false)
                    set结果(null)
                  },
                },
                '撤销改动',
              )
            : null,
          h('span', { className: 'sb-form-hint' }, 脏 ? '有未保存的改动' : '与已存配置一致'),
        ),
        结果 ? h('div', { className: 'sb-notice', 'data-kind': 结果.kind, style: { margin: '12px 16px 16px' } }, 结果.text) : null,
      )
    }

    // ---------------------------------------------------------------- 离线备份

    /**
     * 「离线备份」这一栏：装一个本地脚本，双击就能拿到 Cookies。
     *
     * 为什么必须有这么一块：`Network\Cookies` 在 DSH 运行时被 Chromium 独占锁死
     * （2026-11-23 实测，copyFile / .NET Share.ReadWrite 全 EBUSY，非管理员无解），
     * 而 `process.on('exit')` 那个钩子在 13 天里只成过 1 次 —— Electron 退出时
     * 常常直接把进程收掉，JS 来不及跑。
     *
     * 所以给出路：装个脚本 → 它关 DSH → 抄（这时候一定抄得到）→ 再把 DSH 开回来。
     * 用户只双击一下，不用记命令行。
     */
    function 离线备份({ 状态 }) {
      const [现况, set现况] = React.useState(状态 || null)
      const [忙, set忙] = React.useState(null) // 'install' | 'open'
      const [结果, set结果] = React.useState(null)

      React.useEffect(() => {
        if (状态) set现况(状态)
      }, [状态])

      const 重读 = async () => {
        try {
          const r = await fetch(API + '/offline', { cache: 'no-store', credentials: 'same-origin' })
          const j = await r.json().catch(() => null)
          if (r.ok && j && j.ok !== false) set现况(j)
        } catch {
          // 读不到就保持原样，别把已有状态擦掉
        }
      }

      const 装 = async () => {
        set忙('install')
        set结果(null)
        try {
          const r = await fetch(API + '/offline-install', {
            method: 'POST',
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          const j = await r.json().catch(() => null)
          if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || 'HTTP ' + r.status)
          set结果({ kind: 'ok', text: '已装到 ' + j.目录 + '（双击 双击我-离线备份.cmd 就能用）' })
          await 重读()
        } catch (失败) {
          const 话 = String((失败 && 失败.message) || 失败)
          set结果({ kind: 'bad', text: '装失败：' + 话 })
          报告给宿主('装离线备份脚本失败：' + 话)
        } finally {
          set忙(null)
        }
      }

      const 打开 = async () => {
        set忙('open')
        set结果(null)
        try {
          const r = await fetch(API + '/offline-open', {
            method: 'POST',
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          const j = await r.json().catch(() => null)
          if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || 'HTTP ' + r.status)
          set结果({ kind: 'ok', text: '已在资源管理器里选中' })
        } catch (失败) {
          set结果({ kind: 'bad', text: '打不开：' + String((失败 && 失败.message) || 失败) })
        } finally {
          set忙(null)
        }
      }

      const 已装 = 现况 && 现况.已装 === true

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'sb-callout', style: { marginBottom: '12px' } },
          h('b', null, '为什么需要它'),
          '：浏览器 cookie 库（',
          h('code', null, 'Network\\Cookies'),
          '）在 DSH 运行时是**独占锁**，插件抄不到 —— 这不是路径写错，是那个文件物理上读不了。' +
            '唯一稳的办法是「DSH 停下来的时候抄」。下面的脚本就是干这个的：双击一下，它关 DSH → 抄 → 再把 DSH 开回来。',
        ),
        h(
          'div',
          { className: 'sb-form' },
          h(
            'div',
            { className: 'sb-form-head' },
            h('div', { className: 'sb-form-title' }, '离线备份脚本'),
            h(
              'div',
              { className: 'sb-form-sub' },
              已装
                ? '已装好。双击那个 .cmd 就行 —— 它会先问都不问地关掉 DSH，抄完再开回来。'
                : '还没装。装一份之后，随时想要完整的 cookie 就双击它。',
            ),
          ),
          h(
            'div',
            { className: 'sb-form-body' },
            已装
              ? h(
                  'div',
                  { className: 'sb-row' },
                  h('label', { className: 'sb-row-label' }, '装在哪'),
                  h(
                    'div',
                    { className: 'sb-row-ctl', style: { flexDirection: 'column', alignItems: 'stretch', gap: '4px' } },
                    h('code', { style: { fontSize: '11.5px', wordBreak: 'break-all' } }, 现况.启动器 || 现况.目录),
                    h('span', { className: 'sb-chip', 'data-ok': '1', style: { alignSelf: 'flex-start' } },
                      '装于 ' + 格式化时刻(现况.时间)),
                  ),
                )
              : null,
            h(
              'div',
              { className: 'sb-callout' },
              h('b', null, '它会做什么'),
              h('br'),
              '1. 结束 DSH（含子进程），等它真退干净（最多 45 秒，不行就强杀）',
              h('br'),
              '2. 备份索引 / 会话本体 / 应用状态（**这时 Cookies 一定抄得到**）/ 人设 / 记忆',
              h('br'),
              '3. 把 DSH 开回来（只有它原先在跑才会开）',
              h('br'),
              '4. 结果写进 plugin.log 和 backup.log，面板上能看到',
            ),
          ),
          h(
            'div',
            { className: 'sb-form-foot' },
            h(
              'button',
              { type: 'button', className: 'sb-btn sb-btn-primary', disabled: 忙 !== null, onClick: 装 },
              忙 === 'install' ? '装着…' : 已装 ? '重新装一份' : '装到本机',
            ),
            已装
              ? h(
                  'button',
                  { type: 'button', className: 'sb-btn', disabled: 忙 !== null, onClick: 打开 },
                  忙 === 'open' ? '打开中…' : '在文件夹里看看',
                )
              : null,
            h('span', { className: 'sb-form-hint' }, '装在备份根下的「离线备份」目录里'),
          ),
        ),
        结果 ? h('div', { className: 'sb-notice', 'data-kind': 结果.kind }, 结果.text) : null,
      )
    }

    // ---------------------------------------------------------------- 网盘设置

    // 表单的初始值：从宿主给的「脱敏视图」来。令牌/密码永远是空输入框 ——
    // 宿主只告诉我们「配没配」和尾号，明文根本不进网页。
    const 空表单 = {
      推送网盘: false,
      网盘协议: 'openlist',
      网盘地址: 'http://127.0.0.1:5244',
      网盘根目录: '百度网盘',
      网盘子目录: 'DSH备份',
      网盘用户名: '',
      网盘保留天数: 0,
      网盘超时秒: 30,
      网盘令牌: '',
      网盘密码: '',
      清空令牌: false,
      清空密码: false,
    }

    const 从设置取表单 = (设置) => {
      const 源 = 设置 && typeof 设置 === 'object' ? 设置 : {}
      return {
        ...空表单,
        推送网盘: 源.推送网盘 === true,
        网盘协议: 源.网盘协议 || 'openlist',
        网盘地址: 源.网盘地址 || '',
        网盘根目录: 源.网盘根目录 || '',
        网盘子目录: 源.网盘子目录 || '',
        网盘用户名: 源.网盘用户名 || '',
        网盘保留天数: Number(源.网盘保留天数) || 0,
        网盘超时秒: Number(源.网盘超时秒) || 30,
      }
    }

    /**
     * 「网盘推送」这一栏。
     *
     * 两处都用它：
     *   · 左侧栏「备份」页的第二个页签（日常用）
     *   · DSH 插件管理页里这个插件的详情页（发布出去以后，别人装完就在这里配）
     *
     * 所以它**自己会去读设置**，不依赖外面先拉好 data —— 插件详情页那边
     * 压根没有 /session-backup/list 那份数据。传进来的 设置/上次 只是首帧的
     * 初始值（有就先用，省一次闪烁），没有就自己去拿。
     */
    function 网盘设置({ 设置: 初设置, 上次: 初上次, 读: 外部读, 紧凑 }) {
      const [设置, set设置] = React.useState(初设置 || null)
      const [上次, set上次] = React.useState(初上次 || null)
      const [表单, set表单] = React.useState(() => 从设置取表单(初设置))
      const [脏, set脏] = React.useState(false)
      const [保存中, set保存中] = React.useState(false)
      const [试连中, set试连中] = React.useState(false)
      const [读失败, set读失败] = React.useState(null)
      const [结果, set结果] = React.useState(null) // { kind, text }

      // 自己读一份：详情页里没有外层数据，页签里也要能在热重载后拿到新值
      const 自己读 = React.useCallback(async () => {
        try {
          const 响应 = await fetch(API + '/netdisk', { cache: 'no-store', credentials: 'same-origin' })
          const 负载 = await 响应.json().catch(() => null)
          if (!响应.ok || !负载 || 负载.ok === false) {
            throw new Error((负载 && 负载.error) || 'HTTP ' + 响应.status)
          }
          set设置(负载.设置 || null)
          set上次(负载.上次 || null)
          set读失败(null)
          return 负载
        } catch (失败) {
          const 话 = String((失败 && 失败.message) || 失败)
          set读失败(话)
          return null
        }
      }, [])

      React.useEffect(() => {
        void 自己读()
      }, [自己读])

      // 宿主那边刷新了（别人改了配置 / 热重载）→ 表单没动过才跟着变，
      // 动过就留住用户手打的东西，不然输入一半被覆盖是最烦的
      React.useEffect(() => {
        if (脏) return
        set表单(从设置取表单(设置))
      }, [设置, 脏])

      const 改 = (键, 值) => {
        set表单((旧) => ({ ...旧, [键]: 值 }))
        set脏(true)
        set结果(null)
      }

      const 保存 = async () => {
        set保存中(true)
        set结果(null)
        try {
          // 秘密留空就不传，宿主那边「留空 = 不改」
          const 体 = { ...表单 }
          if (体.网盘令牌 === '') delete 体.网盘令牌
          if (体.网盘密码 === '') delete 体.网盘密码
          const 响应 = await fetch(API + '/netdisk-save', {
            method: 'POST',
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(体),
          })
          const 负载 = await 响应.json().catch(() => null)
          if (!响应.ok || !负载 || 负载.ok === false) {
            throw new Error((负载 && 负载.error) || 'HTTP ' + 响应.status)
          }
          const 改了 = Array.isArray(负载.改了) ? 负载.改了 : []
          set结果({
            kind: 'ok',
            text: 改了.length === 0 ? '没有改动（值都一样）' : '已保存：' + 改了.join('、') + '（配置热重载后生效）',
          })
          set表单((旧) => ({ ...旧, 网盘令牌: '', 网盘密码: '', 清空令牌: false, 清空密码: false }))
          set脏(false)
          await 自己读()
          if (typeof 外部读 === 'function') await 外部读()
        } catch (失败) {
          const 话 = String((失败 && 失败.message) || 失败)
          set结果({ kind: 'bad', text: '保存失败：' + 话 })
          报告给宿主('面板保存网盘设置失败：' + 话)
        } finally {
          set保存中(false)
        }
      }

      const 试连 = async () => {
        set试连中(true)
        set结果(null)
        try {
          const 体 = { ...表单 }
          if (体.网盘令牌 === '') delete 体.网盘令牌
          if (体.网盘密码 === '') delete 体.网盘密码
          const 响应 = await fetch(API + '/netdisk-test', {
            method: 'POST',
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(体),
          })
          const 负载 = await 响应.json().catch(() => null)
          if (!响应.ok || !负载 || 负载.ok === false) {
            throw new Error((负载 && 负载.error) || 'HTTP ' + 响应.status)
          }
          set结果({ kind: 负载.成功 ? 'ok' : 'warn', text: (负载.成功 ? '连上了：' : '连不上：') + (负载.话 || '') })
        } catch (失败) {
          const 话 = String((失败 && 失败.message) || 失败)
          set结果({ kind: 'bad', text: '试连失败：' + 话 })
        } finally {
          set试连中(false)
        }
      }

      const 是OpenList = 表单.网盘协议 === 'openlist'
      const 有令牌 = (设置 && 设置.令牌已配置 === true) || 表单.网盘令牌 !== ''
      const 有密码 = (设置 && 设置.密码已配置 === true) || 表单.网盘密码 !== ''

      const 行 = (标签, 说明, 控件) =>
        h(
          'div',
          { className: 'sb-row' },
          h('label', { className: 'sb-row-label' }, 标签, 说明 ? h('small', null, 说明) : null),
          h('div', { className: 'sb-row-ctl' }, 控件),
        )

      return h(
        'div',
        null,
        读失败
          ? h(
              'div',
              { className: 'sb-notice', 'data-kind': 'bad' },
              '读不到网盘设置：' + 读失败 + '（宿主的 /session-backup/netdisk 没挂上？）',
            )
          : null,
        h(
          'div',
          { className: 'sb-form' },
          h(
            'div',
            { className: 'sb-form-head' },
            h('div', { className: 'sb-form-title' }, '网盘推送'),
            h(
              'div',
              { className: 'sb-form-sub' },
              '每天备份跑完，把当天那一层原样再推一份到网盘。存盘走的是 DSH 的配置编辑服务 —— 会校验、会走热重载，不会把 profile 文件改坏。',
            ),
          ),
          h(
            'div',
            { className: 'sb-form-body' },
            行(
              '总开关',
              '关掉就只备份到本地',
              h(
                'label',
                { className: 'sb-switch' },
                h('input', {
                  type: 'checkbox',
                  checked: 表单.推送网盘 === true,
                  onChange: (事件) => 改('推送网盘', 事件.target.checked),
                }),
                表单.推送网盘 ? '每天自动推' : '不推',
              ),
            ),
            行(
              '协议',
              'OpenList 的 WebDAV 是只读的，得走 API',
              h(
                'select',
                {
                  className: 'sb-select',
                  value: 表单.网盘协议,
                  onChange: (事件) => 改('网盘协议', 事件.target.value),
                },
                h('option', { value: 'openlist' }, 'OpenList（本机 5244，走 HTTP API）'),
                h('option', { value: 'webdav' }, 'WebDAV（坚果云等，支持 PUT）'),
              ),
            ),
            行(
              '服务地址',
              '带 http://，末尾不带斜杠',
              h('input', {
                className: 'sb-input',
                type: 'text',
                value: 表单.网盘地址,
                placeholder: 是OpenList ? 'http://127.0.0.1:5244' : 'https://dav.jianguoyun.com/dav',
                onChange: (事件) => 改('网盘地址', 事件.target.value),
              }),
            ),
            是OpenList
              ? 行(
                  '静态令牌',
                  'OpenList 网页 → 设置 → 其他 → Token（绕开 2FA）',
                  h(
                    'div',
                    { className: 'sb-secret' },
                    h('input', {
                      className: 'sb-input',
                      type: 'password',
                      autoComplete: 'new-password',
                      value: 表单.网盘令牌,
                      placeholder: 有令牌 ? '已配置（尾号 ' + (设置.令牌尾巴 || '…') + '），留空不改' : '还没配',
                      onChange: (事件) => 改('网盘令牌', 事件.target.value),
                    }),
                    h('span', { className: 'sb-chip', 'data-ok': 有令牌 ? '1' : '0' }, 有令牌 ? '已配' : '未配'),
                  ),
                )
              : null,
            是OpenList
              ? null
              : 行(
                  '账号',
                  'WebDAV 的用户名 / 密码',
                  h(
                    'div',
                    { className: 'sb-secret' },
                    h('input', {
                      className: 'sb-input',
                      type: 'text',
                      value: 表单.网盘用户名,
                      placeholder: '用户名',
                      onChange: (事件) => 改('网盘用户名', 事件.target.value),
                    }),
                    h('input', {
                      className: 'sb-input',
                      type: 'password',
                      autoComplete: 'new-password',
                      value: 表单.网盘密码,
                      placeholder: 有密码 ? '已配置，留空不改' : '密码',
                      onChange: (事件) => 改('网盘密码', 事件.target.value),
                    }),
                  ),
                ),
            行(
              '远端目录',
              '挂在 OpenList 下的存储名 → 里面再套一层',
              h(
                'div',
                { className: 'sb-secret' },
                h('input', {
                  className: 'sb-input',
                  type: 'text',
                  value: 表单.网盘根目录,
                  placeholder: '百度网盘',
                  onChange: (事件) => 改('网盘根目录', 事件.target.value),
                }),
                h('input', {
                  className: 'sb-input',
                  type: 'text',
                  value: 表单.网盘子目录,
                  placeholder: 'DSH备份（可留空）',
                  onChange: (事件) => 改('网盘子目录', 事件.target.value),
                }),
              ),
            ),
            行(
              '远端保留',
              '0 = 永不删除远端',
              h(
                'div',
                { className: 'sb-row-ctl', style: { flexWrap: 'nowrap' } },
                h('input', {
                  className: 'sb-input sb-input-narrow',
                  type: 'number',
                  min: 0,
                  max: 3650,
                  value: 表单.网盘保留天数,
                  onChange: (事件) => 改('网盘保留天数', 事件.target.value),
                }),
                h('span', { className: 'sb-chip' }, '天'),
                h(
                  'span',
                  { style: { marginLeft: '6px', fontSize: '11px', opacity: 0.7 } },
                  表单.网盘保留天数 === 0 ? '不删远端任何东西' : '更早的远端日期目录会被清理',
                ),
              ),
            ),
            行(
              '请求超时',
              '单个 HTTP 请求等多久',
              h(
                'div',
                { className: 'sb-row-ctl', style: { flexWrap: 'nowrap' } },
                h('input', {
                  className: 'sb-input sb-input-narrow',
                  type: 'number',
                  min: 5,
                  max: 300,
                  value: 表单.网盘超时秒,
                  onChange: (事件) => 改('网盘超时秒', 事件.target.value),
                }),
                h('span', { className: 'sb-chip' }, '秒'),
              ),
            ),
          ),
          h(
            'div',
            { className: 'sb-form-foot' },
            h(
              'button',
              { type: 'button', className: 'sb-btn sb-btn-primary', disabled: 保存中 || 试连中, onClick: 保存 },
              保存中 ? '保存中…' : '保存设置',
            ),
            h(
              'button',
              { type: 'button', className: 'sb-btn', disabled: 保存中 || 试连中, onClick: 试连 },
              试连中 ? '试着连…' : '试连',
            ),
            脏
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'sb-btn',
                    disabled: 保存中 || 试连中,
                    onClick: () => {
                      set表单(从设置取表单(设置))
                      set脏(false)
                      set结果(null)
                    },
                  },
                  '撤销改动',
                )
              : null,
            h('span', { className: 'sb-form-hint' }, 脏 ? '有未保存的改动' : '与已存配置一致'),
          ),
        ),
        结果 ? h('div', { className: 'sb-notice', 'data-kind': 结果.kind }, 结果.text) : null,
        h(
          'div',
          { className: 'sb-callout', style: { marginTop: '12px' } },
          h('b', null, '上次推送'),
          '：',
          上次 && 上次.时间
            ? 格式化时刻(上次.时间) + ' · ' + (上次.结果 || '') + (上次.话 ? ' · ' + 上次.话 : '')
            : '还没推过（下次备份成功后自动推）',
        ),
      )
    }

    /**
     * 插件管理页里这个 bundle 详情页上的「网盘推送」一节。
     *
     * 为什么另开一处而不是只在左侧栏那个页面里配：发布出去以后，别人装完
     * 在插件页看到的就是这个详情页 —— 那里没有「备份」侧边栏入口可点
     * （他们不会知道你把它放在 order 90）。配置必须在他**看得见的地方**。
     *
     * `subject` 是插件页传进来的「这一页在讲谁」：只对自己的 bundle 渲染，
     * 别人的页面上这一节根本不该出现。
     */
    function 详情页网盘节({ subject }) {
      const 我的包名 = new Set(['@thegoast/dsh-session-backup', 'dsh-session-backup'])
      const 讲我 = subject && subject.kind === 'bundle' && subject.pkg && 我的包名.has(subject.pkg.name)
      if (!讲我) return null
      return h(
        'section',
        null,
        h('style', null, CSS),
        h(
          'div',
          { className: 'sb-page', style: { padding: 0, maxWidth: 'none' } },
          h('h3', { className: 'sb-form-title', style: { marginBottom: '4px' } }, '网盘推送'),
          h(
            'p',
            { className: 'sb-form-sub', style: { marginTop: 0, marginBottom: '10px' } },
            '每天备份跑完，把当天那一层原样再推一份到网盘。这里存的设置和左侧栏「备份 → 网盘推送」是同一份配置。',
          ),
          h(网盘设置, { 设置: null, 上次: null, 读: null }),
        ),
      )
    }


    /**
     * 兜底：面板渲染抛错时**别让整个 slot 条目死掉**。
     * 死掉的样子是一片空白，连「哪里错了」都看不到 —— 2026-11-07 被一个
     * 暂时性死区坑过一次，就是白着。React 的错误边界只能写成 class。
     */
    class 面板兜底 extends React.Component {
      constructor(属性) {
        super(属性)
        this.state = { 错: null }
      }

      static getDerivedStateFromError(错) {
        return { 错: String((错 && 错.message) || 错) }
      }

      // 光在页面上显示还不够：这个错要进 plugin.log 才能事后查
      componentDidCatch(错, 信息) {
        报告给宿主('面板渲染出错：' + String((错 && 错.message) || 错), (信息 && 信息.componentStack) || 错)
      }

      render() {
        if (this.state.错 === null) return this.props.children
        return h(
          'div',
          { className: 'sb-root' },
          h('style', null, CSS),
          h(
            'div',
            { className: 'sb-page' },
            h(
              'header',
              { className: 'sb-head' },
              h(
                'div',
                null,
                h('div', { className: 'sb-kicker' }, 'session-backup'),
                h('h1', { className: 'sb-title' }, '备份'),
              ),
            ),
            h('div', { className: 'sb-notice', 'data-kind': 'bad' }, '面板渲染出错了：' + this.state.错),
            h(
              'button',
              {
                type: 'button',
                className: 'sb-btn',
                style: { marginTop: '14px' },
                onClick: () => this.setState({ 错: null }),
              },
              '重试',
            ),
          ),
        )
      }
    }

    function 备份面板() {
      const [data, setData] = React.useState(null)
      const [错误, set错误] = React.useState(null)
      const [忙碌, set忙碌] = React.useState(null) // 'run' | 'del:2026-11-07'
      const [提示, set提示] = React.useState(null) // { kind, text }
      const [展开日, set展开日] = React.useState({})
      const [展开层, set展开层] = React.useState({})
      const [确认删, set确认删] = React.useState(null)
      const [展开日志, set展开日志] = React.useState(false)
      const [展开诊断, set展开诊断] = React.useState(false)
      const [诊断行, set诊断行] = React.useState([])
      // '记录' 看备份了哪些文件；'网盘' 配推送。分开是因为一个是「看」一个是「改」
      const [页签, set页签] = React.useState('记录')
      // 「备份位置」表单要的那几个值（跟列表分开读，改位置时不用等整份列表刷完）
      const [位置设置数据, set位置设置数据] = React.useState(null)

      // 同一个读取错误只报一次：60 秒轮询一轮，报满整本日志就没人看得下去了
      const 报过的错 = React.useRef('')
      // 面板被打开这件事本身也值得记一笔 —— 排查时先要知道「它到底渲染过没有」
      const 报过打开 = React.useRef(false)
      React.useEffect(() => {
        if (报过打开.current) return
        报过打开.current = true
        报告给宿主('面板打开')
      }, [])

      const 读 = React.useCallback(async () => {
        try {
          const response = await fetch(API + '/list', { cache: 'no-store', credentials: 'same-origin' })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const 负载 = await response.json()
          if (负载 && 负载.ok === false) throw new Error(负载.error || '读取失败')
          setData(负载)
          set错误(null)
          报过的错.current = ''
        } catch (失败) {
          const 话 = String((失败 && 失败.message) || 失败)
          set错误(话)
          if (报过的错.current !== 话) {
            报过的错.current = 话
            报告给宿主('面板读不到 /session-backup/list：' + 话)
          }
        }
        // 位置表单单独一路：它读失败不该把整个面板标成"读不到备份情况"
        try {
          const r2 = await fetch(API + '/where', { cache: 'no-store', credentials: 'same-origin' })
          const j2 = await r2.json().catch(() => null)
          if (r2.ok && j2 && j2.ok !== false) set位置设置数据(j2.设置)
        } catch {
          // 读不到就保持上一次的值，别把用户正在编辑的表单清空
        }
      }, [])

      React.useEffect(() => {
        let 活着 = true
        const 跑 = () => {
          if (活着) 读()
        }
        跑()
        const 表 = window.setInterval(跑, 60000)
        return () => {
          活着 = false
          window.clearInterval(表)
        }
      }, [读])

      // 诊断日志按需拉：只有点开那一块才读，别掺进 60 秒轮询里
      const 读诊断 = async () => {
        try {
          const response = await fetch(API + '/log?lines=120&which=plugin', {
            cache: 'no-store',
            credentials: 'same-origin',
          })
          const 负载 = await response.json()
          set诊断行(负载 && 负载.ok === true && Array.isArray(负载.行) ? 负载.行 : [])
        } catch (失败) {
          set诊断行(['读不到 plugin.log：' + String((失败 && 失败.message) || 失败)])
        }
      }

      // 第一次拿到数据时把最新那天展开；之后再刷新不抢用户的展开状态
      const 日期们 = data && Array.isArray(data.日期们) ? data.日期们 : []
      const 已初始化 = React.useRef(false)
      React.useEffect(() => {
        if (已初始化.current) return
        if (日期们.length === 0) return
        已初始化.current = true
        set展开日({ [日期们[0].日期]: true })
      }, [日期们])

      const 跑一轮 = async () => {
        set忙碌('run')
        set提示(null)
        try {
          const response = await fetch(API + '/run', {
            method: 'POST',
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          const 负载 = await response.json().catch(() => null)
          if (!response.ok || !负载 || 负载.ok === false) {
            throw new Error((负载 && 负载.error) || 'HTTP ' + response.status)
          }
          set提示({ kind: 负载.成功 ? 'ok' : 'warn', text: 负载.话 || '备份完成' })
          await 读()
        } catch (失败) {
          const 话 = String((失败 && 失败.message) || 失败)
          set提示({ kind: 'bad', text: '备份失败：' + 话 })
          报告给宿主('面板「立即备份」失败：' + 话)
        } finally {
          set忙碌(null)
        }
      }

      const 推网盘 = async () => {
        set忙碌('push')
        set提示(null)
        try {
          const response = await fetch(API + '/push', {
            method: 'POST',
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          const 负载 = await response.json().catch(() => null)
          if (!response.ok || !负载 || 负载.ok === false) {
            throw new Error((负载 && 负载.error) || 'HTTP ' + response.status)
          }
          set提示({ kind: 负载.成功 ? 'ok' : 'warn', text: 负载.话 || '推送完成' })
          await 读()
        } catch (失败) {
          const 话 = String((失败 && 失败.message) || 失败)
          set提示({ kind: 'bad', text: '推送失败：' + 话 })
          报告给宿主('面板「推送网盘」失败：' + 话)
        } finally {
          set忙碌(null)
        }
      }

      const 删掉一天 = async (日期) => {
        set忙碌('del:' + 日期)
        set提示(null)
        try {
          const response = await fetch(API + '/delete', {
            method: 'POST',
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ 日期 }),
          })
          const 负载 = await response.json().catch(() => null)
          if (!response.ok || !负载 || 负载.ok === false) {
            throw new Error((负载 && 负载.error) || 'HTTP ' + response.status)
          }
          const 删了 = Array.isArray(负载.删掉) ? 负载.删掉 : []
          set提示({ kind: 'ok', text: '已删掉 ' + 日期 + ' 的备份（' + 删了.length + ' 处）' })
          set确认删(null)
          await 读()
        } catch (失败) {
          const 话 = String((失败 && 失败.message) || 失败)
          set提示({ kind: 'bad', text: '删除失败：' + 话 })
          报告给宿主('面板删除 ' + 日期 + ' 失败：' + 话)
        } finally {
          set忙碌(null)
        }
      }

      const 配置 = (data && data.配置) || {}
      const 有数据 = 日期们.length > 0
      const 总字节 = (data && data.总字节) || 0
      const 上次 = data && data.上次备份
      const 坏的总数 = 日期们.reduce((和, 日) => 和 + (Number(日 && 日.有问题) || 0), 0)

      const 展开状态 = (键) => 展开层[键] === true
      const 切层 = (键) => set展开层((旧) => ({ ...旧, [键]: !旧[键] }))

      const 画文件行 = (文件们) => {
        const 数组 = Array.isArray(文件们) ? 文件们 : []
        if (数组.length === 0) {
          return h('div', { className: 'sb-file' }, h('span', { className: 'sb-file-name' }, '（这一层没有文件）'))
        }
        return 数组.map((文件, 序) =>
          h(
            'div',
            { className: 'sb-file', key: (文件 && 文件.名) || 序 },
            h(
              'span',
              { className: 'sb-file-name', title: (文件 && 文件.名) || '' },
              (文件 && 文件.名) || '（无名）',
            ),
            h('span', { className: 'sb-file-size' }, 格式化字节(文件 && 文件.字节)),
          ),
        )
      }

      const 画层 = (日, 层) => {
        const 数据 = 层数据(日, 层.键)
        const 键 = 日.日期 + '|' + 层.键
        const 有料 = (Number(数据.文件数) || 0) > 0
        const 开着 = 有料 && 展开状态(键)
        return h(
          'div',
          { className: 'sb-layer', key: 键 },
          h(
            'button',
            {
              type: 'button',
              className: 'sb-layer-head',
              onClick: () => 切层(键),
              disabled: !有料,
              'aria-expanded': 开着,
            },
            h(
              'span',
              { className: 'sb-caret', 'data-open': 开着 ? '1' : '0' },
              h(
                'svg',
                { width: 9, height: 9, viewBox: '0 0 10 10', fill: 'currentColor', 'aria-hidden': true },
                h('path', { d: 'M3 1.5 7.5 5 3 8.5Z' }),
              ),
            ),
            h('span', { className: 'sb-layer-name' }, 层.名),
            h(
              'span',
              { className: 'sb-layer-meta' },
              (Number(数据.文件数) || 0) + ' 个文件 · ' + 格式化字节(数据.字节),
            ),
            h('span', { className: 'sb-layer-note' }, 层.说明),
          ),
          开着
            ? h(
                'div',
                { className: 'sb-files' },
                层.分组 && Array.isArray(数据.工作区们)
                  ? 数据.工作区们.map((区, 序) =>
                      h(
                        'div',
                        { className: 'sb-ws', key: (区 && 区.工作区) || 序 },
                        h(
                          'div',
                          {
                            className: 'sb-ws-head',
                            // 备份目录名是「标题净化后」的名字，鼠标悬停给出它原本是哪个路径
                            title: (区 && 区.工作区路径) || '',
                          },
                          h('span', null, (区 && 区.工作区) || '（未知工作区）'),
                          h(
                            'span',
                            { className: 'sb-ws-meta' },
                            (Number(区 && 区.文件数) || 0) + ' 个 · ' + 格式化字节(区 && 区.字节),
                          ),
                        ),
                        画文件行(区 && 区.文件),
                      ),
                    )
                  : 画文件行(数据.文件),
                数据.截断 === true
                  ? h('div', { className: 'sb-more' }, '文件太多，这里只列前 400 个（磁盘上都在）')
                  : null,
              )
            : null,
        )
      }

      const 画一天 = (日) => {
        const 日期 = 日.日期
        const 开着 = 展开日[日期] === true
        const 有问题 = Number(日.有问题) || 0
        const 在删 = 确认删 === 日期
        return h(
          'section',
          { className: 'sb-day', 'data-open': 开着 ? '1' : '0', key: 日期 },
          // 展开按钮和删除按钮是并排的两个真按钮，不是「按钮里套按钮」——
          // 后者虽然能靠 stopPropagation 混过去，但遇到键盘和读屏就露馅了。
          h(
            'div',
            { className: 'sb-day-head' },
            h(
              'button',
              {
                type: 'button',
                className: 'sb-day-toggle',
                onClick: () => set展开日((旧) => ({ ...旧, [日期]: !旧[日期] })),
                'aria-expanded': 开着,
              },
              h(
                'span',
                { className: 'sb-caret', 'data-open': 开着 ? '1' : '0' },
                h(
                  'svg',
                  { width: 10, height: 10, viewBox: '0 0 10 10', fill: 'currentColor', 'aria-hidden': true },
                  h('path', { d: 'M3 1.5 7.5 5 3 8.5Z' }),
                ),
              ),
              h('span', { className: 'sb-day-name' }, 日期),
              h('span', { className: 'sb-week' }, 相对日(日期)),
              日期 === (日期们[0] && 日期们[0].日期)
                ? h('span', { className: 'sb-badge' }, '最新')
                : null,
              有问题 > 0 ? h('span', { className: 'sb-badge-bad' }, 有问题 + ' 个校验失败') : null,
              h('span', { className: 'sb-day-count' }, (Number(日.文件数) || 0) + ' 个文件'),
              h('span', { className: 'sb-day-size' }, 格式化字节(日.总字节)),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'sb-day-del',
                title: '删掉这一天的备份',
                onClick: () => set确认删(在删 ? null : 日期),
              },
              '删除',
            ),
          ),
          在删
            ? h(
                'div',
                { className: 'sb-confirm' },
                h('span', { className: 'sb-confirm-text' }, '把 ' + 日期 + ' 这一天的备份（五层一起）删掉？'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'sb-btn sb-btn-solid-danger',
                    disabled: 忙碌 === 'del:' + 日期,
                    onClick: () => 删掉一天(日期),
                  },
                  忙碌 === 'del:' + 日期 ? '删着…' : '确认删除',
                ),
                h(
                  'button',
                  { type: 'button', className: 'sb-btn', onClick: () => set确认删(null) },
                  '取消',
                ),
              )
            : null,
          开着 ? h('div', { className: 'sb-body' }, 层们.map((层) => 画层(日, 层))) : null,
        )
      }

      const 顶部 = h(
        'header',
        { className: 'sb-head' },
        h(
          'div',
          null,
          h('div', { className: 'sb-kicker' }, 'session-backup'),
          h('h1', { className: 'sb-title' }, '备份'),
          h(
            'p',
            { className: 'sb-sub' },
            '每天把会话本体、索引、应用状态、人设、记忆各留一份。',
            配置.目标目录 ? h('code', null, 配置.目标目录) : null,
            配置.目标目录是默认值 ? h('span', { className: 'sb-chip', style: { marginLeft: '6px' } }, '默认位置') : null,
            '　每天 ' + (配置.每天几点 || '—') + ' 拍一版，保留最近 ' + (配置.保留天数 || '—') + ' 天。',
          ),
        ),
        h(
          'div',
          { className: 'sb-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'sb-btn sb-btn-primary',
              disabled: 忙碌 !== null,
              onClick: 跑一轮,
            },
            忙碌 === 'run' ? '备份中…' : '立即备份',
          ),
          // 网盘推送开了才显示这个按钮
          data && data.网盘 && data.网盘.启用 === true
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'sb-btn',
                  disabled: 忙碌 !== null,
                  onClick: 推网盘,
                },
                忙碌 === 'push' ? '推送中…' : '推送网盘',
              )
            : null,
          h(
            'button',
            { type: 'button', className: 'sb-btn', disabled: 忙碌 !== null, onClick: () => 读() },
            '刷新',
          ),
        ),
      )

      // 第一帧 data 还是 null：这时候别急着喊「还没有备份」，那会闪一下假消息
      const 统计 = data === null
        ? null
        : h(
            'div',
            { className: 'sb-stats' },
            h('div', { className: 'sb-stat' }, '已备份', h('b', null, 日期们.length + ' 天')),
            h('div', { className: 'sb-stat' }, '总体积', h('b', null, 格式化字节(总字节))),
            h(
              'div',
              { className: 'sb-stat' },
              '上次备份',
              h('b', null, 上次 && 上次.时间 ? 格式化时刻(上次.时间) : '还没跑过'),
            ),
            坏的总数 > 0
              ? h('div', { className: 'sb-stat sb-stat-bad' }, '校验失败', h('b', null, 坏的总数 + ' 个'))
              : null,
          )

      const 工具栏 = 有数据
        ? h(
            'div',
            { className: 'sb-toolbar' },
            h('span', { className: 'sb-toolbar-label' }, '备份记录'),
            h('span', { className: 'sb-toolbar-hint' }, '点日期展开，再点某一层看具体文件'),
            h('span', { className: 'sb-toolbar-spacer' }),
            h(
              'button',
              {
                type: 'button',
                className: 'sb-btn',
                onClick: () => {
                  const 全开 = {}
                  for (const 日 of 日期们) 全开[日.日期] = true
                  set展开日(全开)
                },
              },
              '全部展开',
            ),
            h(
              'button',
              { type: 'button', className: 'sb-btn', onClick: () => set展开日({}) },
              '全部收起',
            ),
          )
        : null

      // 应用状态被独占的文件（基本都是浏览器的 cookie 库）：说清楚，
      // 别让人打开面板以为「都备齐了」，等真要用的时候才发现 cookie 是空的。
      const 应用状态跳过 = 上次 && 上次.应用状态 ? Number(上次.应用状态.跳过) || 0 : 0
      const 被占用名单 = 上次 && 上次.应用状态 && Array.isArray(上次.应用状态.被占用)
        ? 上次.应用状态.被占用
            .filter((条) => 条 && 条.文件)
            .map((条) => 条.文件 + (条.原因 ? '（' + 条.原因 + '）' : ''))
            .join('、')
        : ''
      const 被占用提示 =
        应用状态跳过 > 0
          ? h(
              'div',
              { className: 'sb-notice', 'data-kind': 'warn' },
              '上次备份有 ' +
                应用状态跳过 +
                ' 个应用状态文件没抄下来' +
                (被占用名单 ? '：' + 被占用名单 : '') +
                '。这类文件（浏览器 cookie 库）在 DSH 跑着的时候是独占锁，只能等退出时补抄 —— ' +
                '真要一份确定能用的，关掉 DSH 再跑一次 backup-now.mjs。',
            )
          : null

      // 网盘推送状态一行：没开就什么都不显示（「网盘」页签里有完整状态，
      // 这里只在「记录」页留一条轻提示，免得看记录时不知道它在后台推）
      const 网盘信息 = data && data.网盘
      const 网盘状态行 = 页签 === '记录' && 网盘信息 && 网盘信息.启用 === true
        ? h(
            'div',
            { className: 'sb-notice', 'data-kind': 网盘信息.上次 && 网盘信息.上次.结果 === '成功' ? 'ok' : 'warn' },
            '网盘推送：' +
              (配置.网盘根目录 ? (配置.网盘协议 === 'openlist' ? 'OpenList' : 'WebDAV') + ' → ' + 配置.网盘根目录 + (配置.网盘子目录 ? '/' + 配置.网盘子目录 : '') : '（还没配网盘）') +
              (网盘信息.上次 && 网盘信息.上次.话
                ? '　上次：' + 格式化时刻(网盘信息.上次.时间) + ' · ' + 网盘信息.上次.话
                : '　还没推过（下次备份后自动推）'),
          )
        : null

      // 两个页签：记录 = 看备份；网盘 = 配推送。默认停在「记录」——
      // 日常最常看的是「昨天备了没」，配网盘是一辈子改两次的事。
      const 天数额 = 日期们.length
      const 页签栏 = h(
        'div',
        { className: 'sb-tabs', role: 'tablist' },
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': 页签 === '记录',
            'data-on': 页签 === '记录' ? '1' : '0',
            className: 'sb-tab',
            onClick: () => set页签('记录'),
          },
          '备份记录',
          h('span', { className: 'sb-tab-num' }, 天数额 > 0 ? 天数额 : ''),
        ),
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': 页签 === '网盘',
            'data-on': 页签 === '网盘' ? '1' : '0',
            className: 'sb-tab',
            onClick: () => set页签('网盘'),
          },
          '网盘推送',
        ),
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': 页签 === '离线',
            'data-on': 页签 === '离线' ? '1' : '0',
            className: 'sb-tab',
            onClick: () => set页签('离线'),
          },
          '离线备份',
          // 没装的时候挂个提示点：这是"cookie 一直备不上"的正解，得让人看见
          data && data.离线脚本 && data.离线脚本.已装 !== true
            ? h('span', { className: 'sb-tab-num', title: '还没装离线脚本（cookie 备不全）' }, '!')
            : null,
        ),
      )

      // 「离线」页签：装本地脚本，双击就能拿到完整 cookie
      const 离线页 =
        页签 === '离线' ? h(离线备份, { 状态: data && data.离线脚本 }) : null

      // 「网盘」页签的内容：表单 + 上一次推送的结果
      const 网盘页 =
        页签 === '网盘'
          ? h(
              'div',
              null,
              网盘信息 && 网盘信息.启用 !== true
                ? h(
                    'div',
                    { className: 'sb-notice', 'data-kind': 'warn' },
                    '网盘推送现在是关的。打开总开关并保存后，下次备份成功才会自动推。',
                  )
                : null,
              h(网盘设置, { 设置: (网盘信息 && 网盘信息.设置) || null, 上次: 网盘信息 && 网盘信息.上次, 读 }),
            )
          : null


      // 还没拿到第一份数据（且不是报错）→ 只说一句「读取中」，别猜
      const 读取中 =
        data === null && !错误
          ? h(
              'div',
              { className: 'sb-empty' },
              h('div', { className: 'sb-empty-title' }, '正在读备份情况…'),
            )
          : null

      const 空状态 =
        data !== null && !有数据
          ? h(
              'div',
              { className: 'sb-empty' },
              h('div', { className: 'sb-empty-title' }, '还没有备份'),
              h(
                'div',
                { className: 'sb-empty-sub' },
                '点下面这个按钮先拍一版，之后每天到点会自己拍。',
              ),
              h(
                'button',
                { type: 'button', className: 'sb-btn sb-btn-primary', disabled: 忙碌 !== null, onClick: 跑一轮 },
                忙碌 === 'run' ? '备份中…' : '立即备份',
              ),
            )
          : null

      // 错误文案带上能动手的线索：404 = 宿主那边接口压根没挂上，不是数据的问题
      const 错误提示 = 错误
        ? '读不到备份情况：' +
          错误 +
          (/404/.test(错误)
            ? '（宿主的 /session-backup 接口没挂上 —— 插件刚改过的话，存一下 profile 的 cordis.patch.yml 让它重组一次）'
            : '')
        : ''

      // ⚠ 这里必须先落到一个「不是 h(...) 那行自己」的变量上：
      // 写成 `const 其他目录 = ... ? h(..., 其他目录.map(...)) : null` 的话，
      // `其他目录.map` 的取值发生在 const 自己的初始化式里 —— 那是暂时性死区，
      // 有数据就抛 ReferenceError，整个面板直接白掉（2026-11-07 真踩过：
      // 无数据时短路所以看着没事，接口一通就炸）。
      const 其他目录们 = data && Array.isArray(data.其他目录) ? data.其他目录 : []
      const 其他目录块 =
        其他目录们.length > 0
          ? h(
              'div',
              { className: 'sb-others' },
              其他目录们.map((目录, 序) =>
                h(
                  'span',
                  { className: 'sb-other', key: (目录 && 目录.名) || 序 },
                  h('b', null, (目录 && 目录.名) || '（无名）'),
                  ' · ' + (Number(目录 && 目录.文件数) || 0) + ' 个 · ' + 格式化字节(目录 && 目录.字节),
                ),
              ),
            )
          : null

      // 两块日志长一个样：一块是备份流水（backup.log），一块是诊断日志（plugin.log）。
      // 抽出来是因为「以后要加第三块」几乎是必然的，别把手写三遍。
      const 画日志块 = (标题, 行们, 说明, 开着, 切换) => {
        const 数组 = Array.isArray(行们) ? 行们 : []
        return h(
          'div',
          { className: 'sb-log' },
          h(
            'button',
            { type: 'button', className: 'sb-log-head', onClick: 切换 },
            h(
              'span',
              { className: 'sb-caret', 'data-open': 开着 ? '1' : '0' },
              h(
                'svg',
                { width: 10, height: 10, viewBox: '0 0 10 10', fill: 'currentColor', 'aria-hidden': true },
                h('path', { d: 'M3 1.5 7.5 5 3 8.5Z' }),
              ),
            ),
            标题,
            h('span', { className: 'sb-log-meta' }, 说明),
          ),
          开着
            ? h(
                'div',
                { className: 'sb-log-body' },
                数组.length === 0
                  ? h('span', { className: 'sb-log-line' }, '（还没有内容）')
                  : 数组
                      .slice()
                      .reverse()
                      .map((行, 序) =>
                        h(
                          'span',
                          {
                            className: 'sb-log-line',
                            key: 序,
                            'data-bad': /失败|异常|出错|error|mismatch|WARN|ERROR/i.test(String(行)) ? '1' : '0',
                          },
                          String(行),
                        ),
                      ),
              )
            : null,
        )
      }

      const 日志行 = data && Array.isArray(data.日志) ? data.日志 : []
      const 流水日志 = 画日志块(
        '运行日志',
        日志行,
        '最近 ' + 日志行.length + ' 行 · backup.log',
        展开日志,
        () => set展开日志((旧) => !旧),
      )
      const 诊断日志块 = 画日志块(
        '诊断日志',
        诊断行,
        'plugin.log · 加载 / 接口 / 网页报错',
        展开诊断,
        () => {
          const 开 = !展开诊断
          set展开诊断(开)
          if (开) void 读诊断()
        },
      )

      // 「备份记录」页签的内容：统计 + 每天一层层展开 + 日志
      const 记录页 = 页签 === '记录' ? h(
        'div',
        null,
        统计,
        网盘状态行,
        被占用提示,
        提示 ? h('div', { className: 'sb-notice', 'data-kind': 提示.kind }, 提示.text) : null,
        错误
          ? h(
              'div',
              { className: 'sb-notice', 'data-kind': 'bad' },
              错误提示,
              有数据 ? '（下面这份是上次读到的）' : '',
            )
          : null,
        // 位置设置放在记录页顶部：这是"备份存哪儿"的事，跟列表是同一件事的两面
        h(位置设置, { 设置: 位置设置数据, 读 }),
        工具栏,
        日期们.map((日) => 画一天(日)),
        读取中,
        空状态,
        其他目录块,
        流水日志,
        诊断日志块,
        h(
          'div',
          { className: 'sb-foot' },
          '备份写在 ',
          配置.目标目录 ? h('code', null, 配置.目标目录) : '备份根目录',
          '，不在任何工作区里面，所以清工作区、搬家都不会伤到它。超过 ' +
            (配置.保留天数 || '—') +
            ' 天的日期目录，会在每天备份跑完时整个删掉。',
        ),
      ) : null

      return h(
        'div',
        { className: 'sb-root' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'sb-page' },
          顶部,
          页签栏,
          网盘页,
          离线页,
          记录页,
        ),
      )
    }

    // ---------------------------------------------------------------- 挂载

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      // 全局面板：左侧栏一个按钮 + 主区一页，两边用同一个 id 对上
      slots.inject('main', () =>
        slots.register({ name: 'main', key: 'session-backup' }, () =>
          h(面板兜底, null, h(备份面板)),
        ),
      )

      slots.inject('sidebar.panellist', () =>
        slots.register(
          {
            name: 'sidebar.panellist',
            id: 'session-backup',
            order: 90,
            label: () => '备份',
          },
          备份图标,
        ),
      )

      // 插件管理页 → 这个 bundle 的详情页 → 「网盘推送」一节。
      // 发布出去以后别人就是从这里配（他们没有左侧栏那个入口的心智）。
      // 用 optional 而不是硬注入：老宿主没有这个 slot 时不能连累整个插件。
      try {
        if (typeof slots.inject === 'function') {
          slots.inject('plugins.detail.section', () =>
            slots.register(
              { name: 'plugins.detail.section', id: 'session-backup-netdisk' },
              详情页网盘节,
            ),
          )
        }
      } catch (错误) {
        // 没有这个 slot 就只保留左侧栏那条路，不影响备份本身
        报告给宿主('挂 plugins.detail.section 失败（忽略）：' + String((错误 && 错误.message) || 错误))
      }
    }

    return { inject: ['slots'], apply }
  },
})
