/**
 * Browser-side panel for the EvoOntology semantic layer.
 *
 * A read-only view of `<workspace>`: which versions exist, how many records each
 * one holds, the newest evolution run, and where the offline explorer lives.
 *
 * It is a right-sidebar tab, not a left-column global panel: the point is to
 * watch the semantic layer while the conversation keeps running, and a global
 * panel would take the centre column (which hides the right sidebar entirely).
 *
 * There is no MCP tool access from the browser, so every read goes through the
 * Host's `/evo` command over the connection; see docs/subsystems/client-sidebar.md.
 */
window.__ModuleLoader__.load({
  id: '@noah/dsh-evoontology',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const NS = 'dsh-evoontology'
    const TAB_ID = '@noah/dsh-evoontology'

    const zh = {
      'tab.title': 'EvoOntology',
      'tab.description': '本体层版本、记录数量与最近演化运行（只读）',
      'state.loading': '加载中…',
      'state.refresh': '刷新',
      'state.noSession': '没有可用会话；打开一个会话后重试。',
      'state.error': '读取失败',
      'state.errorHint': '如果刚刚安装，请重启 DSH 让插件加载新的实现。',
      'empty.title': '工作区还没有本体层',
      'empty.hint1': '让 agent 使用 build-ontology 技能从数据与问题建一层本体。',
      'empty.hint2': '建好并发布后，这里会列出每个版本的记录数量。',
      'section.versions': '版本',
      'section.active': '活动',
      'section.total': '记录合计',
      'section.runs': '演化运行',
      'section.noRuns': '还没有演化运行记录。',
      'section.explorer': '离线探索器',
      'section.noExplorer': '尚未生成（发布或聚合时产出）。',
      'section.trajectories': '任务轨迹',
      'section.workspace': '工作区',
      'run.status': '状态',
      'run.parent': 'Parent',
      'run.candidate': 'Candidate',
      'run.accepted': '已接受版本',
      'run.round': '轮次',
      'run.budget': '预算',
      'run.endReason': '终止原因',
      'run.updated': '更新于',
    }

    const en = {
      'tab.title': 'EvoOntology',
      'tab.description': 'Ontology versions, record counts and the latest evolution run (read-only)',
      'state.loading': 'Loading…',
      'state.refresh': 'Refresh',
      'state.noSession': 'No usable session — open a conversation and retry.',
      'state.error': 'Could not read the workspace',
      'state.errorHint': 'If you just installed this bundle, restart DSH so the new implementation loads.',
      'empty.title': 'No ontology layer in this workspace yet',
      'empty.hint1': 'Ask the agent to build one with the build-ontology skill.',
      'empty.hint2': 'Once a version is published, its record counts show up here.',
      'section.versions': 'Versions',
      'section.active': 'active',
      'section.total': 'records',
      'section.runs': 'Evolution runs',
      'section.noRuns': 'No evolution runs recorded yet.',
      'section.explorer': 'Offline explorer',
      'section.noExplorer': 'Not generated yet (produced on publish or finalize).',
      'section.trajectories': 'Task trajectories',
      'section.workspace': 'Workspace',
      'run.status': 'status',
      'run.parent': 'Parent',
      'run.candidate': 'Candidate',
      'run.accepted': 'Accepted',
      'run.round': 'Round',
      'run.budget': 'Budget',
      'run.endReason': 'End reason',
      'run.updated': 'Updated',
    }

    // Neutral, theme-agnostic styles: no colors, no backgrounds. Only spacing,
    // separators and relative type sizes so the panel reads like host chrome.
    const S = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        padding: '12px 14px 20px',
        fontSize: 13,
        lineHeight: 1.5,
        minWidth: 0,
        height: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
      },
      header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
      title: { fontSize: 14, fontWeight: 600, margin: 0 },
      button: {
        font: 'inherit',
        padding: '2px 10px',
        borderRadius: 6,
        border: '1px solid rgba(128,128,128,0.45)',
        background: 'transparent',
        cursor: 'pointer',
      },
      section: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
      sectionTitle: {
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: '0.02em',
        opacity: 0.75,
        textTransform: 'uppercase',
        margin: 0,
      },
      row: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 10,
        padding: '4px 0',
        borderBottom: '1px solid rgba(128,128,128,0.18)',
        minWidth: 0,
      },
      rowMain: { display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' },
      muted: { opacity: 0.7, fontSize: 12 },
      wrap: { wordBreak: 'break-all', minWidth: 0 },
      kv: { display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 },
      kvKey: { opacity: 0.65, fontSize: 12, minWidth: 84, flexShrink: 0 },
      hint: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5, opacity: 0.8 },
      path: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 11.5, opacity: 0.7, wordBreak: 'break-all' },
    }

    function formatCounts(counts) {
      return ['terms', 'mappings', 'relations', 'constraints', 'evidence']
        .map((family) => `${family} ${counts[family] ?? 0}`)
        .join(' · ')
    }

    function Kv(props) {
      return h('div', { style: S.kv },
        h('span', { style: S.kvKey }, props.label),
        h('span', { style: { ...S.wrap, ...(props.mono ? S.mono : null) } }, props.value)
      )
    }

    function EvoPane(props) {
      const { t, load } = props
      const [state, setState] = useState({ status: 'loading', payload: undefined, message: '' })

      const refresh = useCallback(async () => {
        setState((previous) => ({ ...previous, status: 'loading', message: '' }))
        try {
          const payload = await load()
          setState({ status: 'ready', payload, message: '' })
        } catch (error) {
          setState({ status: 'error', payload: undefined, message: String((error && error.message) || error) })
        }
      }, [load])

      useEffect(() => { refresh() }, [refresh])

      const header = h('div', { style: S.header },
        h('h4', { style: S.title }, t('tab.title')),
        h('button', {
          type: 'button',
          style: S.button,
          onClick: refresh,
          disabled: state.status === 'loading',
        }, t('state.refresh'))
      )

      if (state.status === 'loading') {
        return h('div', { style: S.root }, header, h('div', { style: S.muted }, t('state.loading')))
      }

      if (state.status === 'error') {
        return h('div', { style: S.root },
          header,
          h('div', { style: S.section },
            h('div', { style: S.sectionTitle }, t('state.error')),
            h('div', { style: S.wrap }, state.message),
            h('div', { style: S.hint }, h('span', null, t('state.errorHint')))
          )
        )
      }

      const data = state.payload || {}
      const versions = Array.isArray(data.versions) ? data.versions : []
      const runs = Array.isArray(data.runs) ? data.runs : []
      const visualizations = Array.isArray(data.visualizations) ? data.visualizations : []

      // No store yet, or a store with no published version: both mean "nothing
      // to look at", so they share the guidance state instead of empty tables.
      if (!data.exists || versions.length === 0) {
        return h('div', { style: S.root },
          header,
          h('div', { style: S.section },
            h('div', { style: S.sectionTitle }, t('empty.title')),
            h('div', { style: S.hint },
              h('span', null, t('empty.hint1')),
              h('span', null, t('empty.hint2'))
            )
          ),
          h('div', { style: S.section },
            h('div', { style: S.sectionTitle }, t('section.workspace')),
            h('div', { style: S.path }, data.workspace || '')
          )
        )
      }

      const versionsSection = h('div', { style: S.section },
        h('div', { style: S.sectionTitle }, `${t('section.versions')} · ${versions.length}`),
        versions.map((row) => h('div', { key: row.version, style: S.row },
          h('div', { style: S.rowMain },
            h('span', { style: S.mono }, row.version),
            row.active ? h('span', { style: S.muted }, `· ${t('section.active')}`) : null
          ),
          h('span', { style: S.muted }, `${formatCounts(row.counts)} · ${t('section.total')} ${row.total}`)
        ))
      )

      const latest = data.latestRun
      const runsSection = h('div', { style: S.section },
        h('div', { style: S.sectionTitle }, `${t('section.runs')} · ${runs.length}`),
        latest === null || latest === undefined
          ? h('div', { style: S.muted }, t('section.noRuns'))
          : h('div', { style: S.section },
            h(Kv, { label: t('run.status'), value: String(latest.status ?? '—'), mono: true }),
            h(Kv, { label: t('run.parent'), value: String(latest.parentVersion ?? '—'), mono: true }),
            h(Kv, { label: t('run.candidate'), value: String(latest.currentCandidate ?? '—'), mono: true }),
            latest.acceptedVersion
              ? h(Kv, { label: t('run.accepted'), value: String(latest.acceptedVersion), mono: true })
              : null,
            h(Kv, { label: t('run.round'), value: `${latest.round ?? '—'} / ${latest.budget ?? '—'}`, mono: true }),
            latest.endReason ? h(Kv, { label: t('run.endReason'), value: String(latest.endReason) }) : null,
            latest.updatedAt ? h(Kv, { label: t('run.updated'), value: String(latest.updatedAt).replace('T', ' ').slice(0, 19) }) : null
          )
      )

      const explorerSection = h('div', { style: S.section },
        h('div', { style: S.sectionTitle }, t('section.explorer')),
        visualizations.length === 0
          ? h('div', { style: S.muted }, t('section.noExplorer'))
          : visualizations.slice(0, 3).map((entry) => h('div', { key: entry.path, style: S.path }, entry.path))
      )

      const metaSection = h('div', { style: S.section },
        h(Kv, { label: t('section.trajectories'), value: String(data.trajectories ?? 0), mono: true }),
        h(Kv, { label: t('section.workspace'), value: data.workspace || '', mono: true })
      )

      return h('div', { style: S.root },
        header,
        versionsSection,
        runsSection,
        explorerSection,
        metaSection
      )
    }

    return {
      inject: ['slots', 'locale', 'remote', 'sessions', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-evoontology: locale dictionaries')
        const t = ctx.locale.bind(NS)

        const currentSessionId = () => {
          try {
            const ui = ctx.get('uiSession')
            const current = ui && ui.current && typeof ui.current.getSnapshot === 'function'
              ? ui.current.getSnapshot()
              : undefined
            if (current && current.key) return current.key
          } catch {
            // fall through to the sessions snapshot
          }
          try {
            const snapshot = ctx.sessions && ctx.sessions.list ? ctx.sessions.list.getSnapshot() : undefined
            if (snapshot && Array.isArray(snapshot.ids) && snapshot.ids.length > 0) {
              const main = snapshot.ids.find((id) => {
                const row = snapshot.byId ? snapshot.byId[id] : undefined
                return row && row.retainedBy && (row.retainedBy.mainView ?? 0) > 0
              })
              return main || snapshot.ids[0]
            }
          } catch {
            // no session face yet
          }
          return undefined
        }

        const load = async () => {
          const commands = ctx.get('remote.commands')
          if (!commands || typeof commands.execute !== 'function') throw new Error(t('state.noSession'))
          const sessionId = currentSessionId()
          if (!sessionId) throw new Error(t('state.noSession'))
          const response = await commands.execute(sessionId, '/evo status', [])
          if (!response || !response.ok) {
            throw new Error((response && response.error && response.error.message) || t('state.error'))
          }
          const execution = response.value
          if (!execution || !execution.result) throw new Error(t('state.error'))
          if (execution.result.kind !== 'success') throw new Error(execution.result.text || t('state.error'))
          try {
            return JSON.parse(execution.result.text)
          } catch {
            return execution.result.text
          }
        }

        // 1) Define the tab kind. The same `id` keys the body slot below.
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: 'evo',
          title: () => t('tab.title'),
          keepMounted: true,
          guide: {
            order: 40,
            title: () => t('tab.title'),
            description: () => t('tab.description'),
          },
        }), 'dsh-evoontology: evo tab type')

        // 2) Provide the body. The seat dispatches a tab to the id of its
        //    effective kind definition, so this key must be the same string.
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: NS,
          inject: () => ({ t, load }),
        }, EvoPane))
      },
    }
  },
})
