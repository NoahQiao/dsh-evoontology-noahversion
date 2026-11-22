/**
 * The right-sidebar seat (P2).
 *
 * A browser module cannot hold a SQLite handle and must not talk to MCP tools,
 * so the panel is a pure projection: it asks the Host for `/evo status --json`,
 * and the Host answers from the same store the tools write to. One projector
 * means the panel and the CLI can never disagree.
 *
 * Two registrations share one id — the tab *definition* and the tab *body* —
 * and the seat dispatches the body through the id the definition returns. Get
 * either id wrong and the seat renders an empty pane.
 */
window.__ModuleLoader__.load({
  id: '@noah/dsh-evoontology',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const NS = 'dsh-evoontology'
    const TAB_ID = '@noah/dsh-evoontology'
    const KIND = 'evo'

    const zh = {
      'tab.title': 'EvoOntology',
      'tab.description': '本体层：版本、节点、差异',
      'state.loading': '读取中…',
      'state.refresh': '刷新',
      'state.noSession': '还没有会话，打开一个会话后会自动读取。',
      'state.error': '读取失败',
      'empty.title': '还没有激活版本',
      'empty.hint1': '让 agent 先探测数据，再用 evo_commit 建节点、evo_publish 激活。',
      'empty.hint2': '也可以直接说：给这份数据建语义层。',
      'section.active': '激活版本',
      'section.none': '无',
      'section.versions': '版本',
      'section.noVersions': '（还没有任何版本）',
      'section.diff': '差异',
      'section.diffHint': '点一个版本看它相对激活版本改了什么。',
      'section.diffLoading': '对比中…',
      'section.diffFailed': '对比失败',
      'section.tasks': '任务',
      'section.taskLine': '进行中 {running} · 完成 {completed} · 失败 {failed}',
      'section.store': '存储',
      'label.total': '合计',
      'label.published': '已发布',
      'label.draft': '草稿',
      'label.retired': '历史',
      'diff.added': '新增',
      'diff.removed': '删除',
      'diff.changed': '修改',
      'diff.none': '与激活版本没有差异',
      'diff.edges': '边 +{added} -{removed}'
    }

    const en = {
      'tab.title': 'EvoOntology',
      'tab.description': 'Ontology layer: versions, nodes, diffs',
      'state.loading': 'Loading…',
      'state.refresh': 'Refresh',
      'state.noSession': 'No session yet — open one and the panel reads itself.',
      'state.error': 'Failed to read',
      'empty.title': 'No active version yet',
      'empty.hint1': 'Have the agent probe the data, build nodes with evo_commit, then activate with evo_publish.',
      'empty.hint2': 'Or just say: build a semantic layer for this dataset.',
      'section.active': 'Active',
      'section.none': 'none',
      'section.versions': 'Versions',
      'section.noVersions': '(no versions yet)',
      'section.diff': 'Diff',
      'section.diffHint': 'Pick a version to see what it changes against the active one.',
      'section.diffLoading': 'Diffing…',
      'section.diffFailed': 'Diff failed',
      'section.tasks': 'Tasks',
      'section.taskLine': 'running {running} · completed {completed} · failed {failed}',
      'section.store': 'Store',
      'label.total': 'total',
      'label.published': 'published',
      'label.draft': 'draft',
      'label.retired': 'retired',
      'diff.added': 'added',
      'diff.removed': 'removed',
      'diff.changed': 'changed',
      'diff.none': 'No difference from the active version',
      'diff.edges': 'edges +{added} -{removed}'
    }

    // Neutral only: separators, weight and opacity. Colors belong to the host
    // theme, and a plugin that hardcodes them breaks in the other theme.
    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: 0, height: '100%', fontSize: 13, lineHeight: 1.5, overflow: 'auto' },
      bar: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid rgba(128,128,128,.18)', position: 'sticky', top: 0, backdropFilter: 'blur(6px)' },
      barTitle: { fontWeight: 600 },
      spacer: { flex: 1 },
      button: { border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit', borderRadius: 6, padding: '2px 8px', fontSize: 12, cursor: 'pointer' },
      section: { padding: '10px 12px', borderBottom: '1px solid rgba(128,128,128,.12)' },
      sectionTitle: { fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', opacity: 0.6, marginBottom: 6 },
      row: { display: 'flex', alignItems: 'baseline', gap: 8, padding: '4px 6px', borderRadius: 6, cursor: 'pointer' },
      rowActive: { background: 'rgba(128,128,128,.12)' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 },
      dim: { opacity: 0.62 },
      small: { fontSize: 11.5, opacity: 0.72 },
      muted: { fontSize: 12, opacity: 0.6 },
      pill: { border: '1px solid rgba(128,128,128,.3)', borderRadius: 999, padding: '0 6px', fontSize: 11, opacity: 0.85 },
      counts: { display: 'flex', flexWrap: 'wrap', gap: 6 },
      diffBlock: { marginTop: 6 },
      diffLine: { display: 'flex', gap: 6, alignItems: 'baseline' },
      sign: { width: 10, textAlign: 'center', opacity: 0.75 },
      list: { margin: 0, padding: 0, listStyle: 'none' }
    }

    const pad = (n) => String(n).padStart(2, '0')
    const formatTime = (iso) => {
      if (!iso) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return iso
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }
    const statusLabel = (t, status) => t(`label.${status === 'active' ? 'published' : status}`)
    const countsText = (counts) =>
      counts ? `term ${counts.term ?? 0} · mapping ${counts.mapping ?? 0} · constraint ${counts.constraint ?? 0} · evidence ${counts.evidence ?? 0}` : ''
    const fill = (template, values) =>
      String(template).replace(/\{(\w+)\}/g, (_match, key) => (values[key] === undefined ? '' : String(values[key])))

    function Row({ label, value, mono }) {
      return h(
        'div',
        { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
        h('span', { style: { ...S.dim, minWidth: 62 } }, label),
        h('span', { style: mono ? S.mono : null }, value)
      )
    }

    function DiffBlock({ t, diff }) {
      if (!diff) return null
      const groups = [
        ['added', '+', diff.added],
        ['removed', '-', diff.removed],
        ['changed', '~', diff.changed]
      ]
      const total = groups.reduce((sum, group) => sum + group[2].length, 0)
      if (!total) return h('div', { style: S.muted }, t('diff.none'))
      return h(
        'div',
        { style: S.diffBlock },
        h('div', { style: S.small }, fill(t('diff.edges'), { added: diff.addedEdges.length, removed: diff.removedEdges.length })),
        groups.map(([label, sign, nodes]) =>
          nodes.length
            ? h(
                'div',
                { key: label },
                h('div', { style: { ...S.small, marginTop: 6 } }, `${t(`diff.${label}`)} ${nodes.length}`),
                h(
                  'ul',
                  { style: S.list },
                  nodes.map((node) =>
                    h(
                      'li',
                      { key: node.id, style: S.diffLine },
                      h('span', { style: S.sign }, sign),
                      h('span', { style: S.mono }, node.id),
                      node.kind ? h('span', { style: S.muted }, node.kind) : null,
                      node.label ? h('span', { style: S.dim }, node.label) : null
                    )
                  )
                )
              )
            : null
        )
      )
    }

    function EvoPane({ t, load }) {
      const [state, setState] = useState({ phase: 'loading' })
      const [selected, setSelected] = useState(null)
      const [diff, setDiff] = useState({ phase: 'idle' })

      const refresh = useCallback(() => {
        let alive = true
        setState((prev) => ({ phase: prev.data ? 'ready' : 'loading', data: prev.data }))
        load()
          .then((data) => {
            if (alive) setState({ phase: 'ready', data })
          })
          .catch((error) => {
            if (alive) setState({ phase: 'error', message: String((error && error.message) || error) })
          })
        return () => {
          alive = false
        }
      }, [load])

      useEffect(() => refresh(), [refresh])

      const data = state.data
      const activeId = data && data.active ? data.active.id : null

      const pick = useCallback(
        (id) => {
          setSelected(id)
          if (!data || !activeId || id === activeId) {
            setDiff({ phase: 'idle' })
            return
          }
          setDiff({ phase: 'loading' })
          load(`/evo diff ${activeId} ${id} --json`)
            .then((payload) => setDiff({ phase: 'ready', payload }))
            .catch((error) => setDiff({ phase: 'error', message: String((error && error.message) || error) }))
        },
        [data, activeId, load]
      )

      if (state.phase === 'loading' && !data) {
        return h('div', { style: { ...S.root, padding: 16 } }, h('span', { style: S.muted }, t('state.loading')))
      }

      if (state.phase === 'error') {
        return h(
          'div',
          { style: { ...S.root, padding: 16, gap: 8 } },
          h('div', { style: { fontWeight: 600 } }, t('state.error')),
          h('div', { style: S.mono }, state.message),
          h('button', { style: S.button, onClick: refresh }, t('state.refresh'))
        )
      }

      const hasContent = data && (data.active || data.versions.length > 0)

      return h(
        'div',
        { style: S.root },
        h(
          'div',
          { style: S.bar },
          h('span', { style: S.barTitle }, t('tab.title')),
          data && data.drafts.length ? h('span', { style: S.pill }, `${t('label.draft')} ${data.drafts.length}`) : null,
          h('span', { style: S.spacer }),
          h('button', { style: S.button, onClick: refresh, title: formatTime(data && data.generatedAt) }, t('state.refresh'))
        ),
        !hasContent
          ? h(
              'div',
              { style: { ...S.section, paddingTop: 24, paddingBottom: 24 } },
              h('div', { style: { fontWeight: 600, marginBottom: 6 } }, t('empty.title')),
              h('div', { style: S.muted }, t('empty.hint1')),
              h('div', { style: { ...S.muted, marginTop: 4 } }, t('empty.hint2'))
            )
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { style: S.section },
                h('div', { style: S.sectionTitle }, t('section.active')),
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } }, h('span', { style: { ...S.mono, fontWeight: 600 } }, activeId || t('section.none')), data.active && data.active.summary ? h('span', { style: S.dim }, data.active.summary) : null),
                data.counts ? h('div', { style: { ...S.small, marginTop: 4 } }, countsText(data.counts)) : null,
                data.active && data.active.createdAt ? h('div', { style: { ...S.muted, marginTop: 2 } }, formatTime(data.active.createdAt)) : null
              ),
              h(
                'div',
                { style: S.section },
                h('div', { style: S.sectionTitle }, t('section.versions')),
                !data.versions.length
                  ? h('div', { style: S.muted }, t('section.noVersions'))
                  : h(
                      'ul',
                      { style: S.list },
                      data.versions.map((version) =>
                        h(
                          'li',
                          {
                            key: version.id,
                            style: { ...S.row, ...(version.id === selected ? S.rowActive : null) },
                            onClick: () => pick(version.id),
                            title: version.summary || version.id
                          },
                          h('span', { style: { ...S.mono, fontWeight: version.status === 'active' ? 600 : 400 } }, version.id),
                          h('span', { style: S.pill }, statusLabel(t, version.status)),
                          h('span', { style: S.small }, `${version.counts ? version.counts.total : 0} ${t('label.total')}`),
                          h('span', { style: { ...S.spacer, flex: 1 } }),
                          h('span', { style: S.muted }, formatTime(version.createdAt))
                        )
                      )
                    )
              ),
              selected && selected !== activeId
                ? h(
                    'div',
                    { style: S.section },
                    h('div', { style: S.sectionTitle }, `${t('section.diff')} · ${activeId} → ${selected}`),
                    diff.phase === 'loading'
                      ? h('div', { style: S.muted }, t('section.diffLoading'))
                      : diff.phase === 'error'
                        ? h('div', { style: S.muted }, `${t('section.diffFailed')}：${diff.message}`)
                        : h(DiffBlock, { t, diff: diff.payload })
                  )
                : activeId && data.versions.length > 1
                  ? h('div', { style: S.section }, h('div', { style: S.muted }, t('section.diffHint')))
                  : null,
              h(
                'div',
                { style: S.section },
                h('div', { style: S.sectionTitle }, t('section.tasks')),
                h('div', { style: S.small }, fill(t('section.taskLine'), data.tasks || {}))
              ),
              h(
                'div',
                { style: { ...S.section, borderBottom: 'none' } },
                h('div', { style: S.sectionTitle }, t('section.store')),
                h(Row, { label: '', value: data.storePath, mono: true })
              )
            )
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
            const current = ui && ui.current && typeof ui.current.getSnapshot === 'function' ? ui.current.getSnapshot() : undefined
            if (current && current.key) return current.key
          } catch {}
          try {
            const snapshot = ctx.sessions && ctx.sessions.list ? ctx.sessions.list.getSnapshot() : undefined
            if (snapshot && Array.isArray(snapshot.ids) && snapshot.ids.length > 0) {
              const main = snapshot.ids.find((id) => {
                const row = snapshot.byId ? snapshot.byId[id] : undefined
                return row && row.retainedBy && (row.retainedBy.mainView ?? 0) > 0
              })
              return main || snapshot.ids[0]
            }
          } catch {}
          return undefined
        }

        const callCommand = async (line) => {
          const commands = ctx.get('remote.commands')
          if (!commands || typeof commands.execute !== 'function') throw new Error(t('state.noSession'))
          const sessionId = currentSessionId()
          if (!sessionId) throw new Error(t('state.noSession'))
          const response = await commands.execute(sessionId, line, [])
          if (!response || !response.ok) throw new Error((response && response.error && response.error.message) || t('state.error'))
          const execution = response.value
          if (!execution || !execution.result) throw new Error(t('state.error'))
          if (execution.result.kind !== 'success') throw new Error(execution.result.text || t('state.error'))
          return JSON.parse(execution.result.text)
        }

        const load = (line) => callCommand(line || '/evo status --json')

        ctx.effect(
          () => ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: KIND,
            title: () => t('tab.title'),
            keepMounted: true,
            guide: {
              order: 40,
              title: () => t('tab.title'),
              description: () => t('tab.description')
            }
          }),
          'dsh-evoontology: sidebar tab definition'
        )

        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: NS,
          inject: () => ({ t, load })
        }, EvoPane))
      }
    }
  }
})
