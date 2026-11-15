window.__ModuleLoader__.load({
  id: 'dsh-minecraft',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL = {
      position: 'fixed',
      right: 16,
      bottom: 72,
      width: 280,
      maxHeight: 340,
      overflow: 'auto',
      background: 'var(--dsh-surface, #1b1d21)',
      color: 'var(--dsh-text, #e6e6e6)',
      border: '1px solid rgba(255,255,255,0.15)',
      borderRadius: 12,
      boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
      padding: 12,
      zIndex: 9999,
      fontSize: 13,
    }

    const BUTTON = {
      position: 'fixed',
      right: 16,
      bottom: 16,
      width: 46,
      height: 46,
      borderRadius: 12,
      border: '1px solid rgba(255,255,255,0.18)',
      background: 'linear-gradient(#2a2d33, #1b1d21)',
      cursor: 'pointer',
      display: 'grid',
      placeItems: 'center',
      zIndex: 9999,
      padding: 0,
    }

    function GrassBlock() {
      return h(
        'svg',
        { viewBox: '0 0 32 32', width: 30, height: 30, 'aria-hidden': true },
        h('rect', { x: 2, y: 2, width: 28, height: 13, fill: '#6aa84f' }),
        h('rect', { x: 2, y: 2, width: 28, height: 4, fill: '#7fbf5f' }),
        h('rect', { x: 2, y: 12, width: 28, height: 3, fill: '#4f7a37' }),
        h('rect', { x: 2, y: 15, width: 28, height: 15, fill: '#8a5a33' }),
        h('rect', { x: 6, y: 18, width: 5, height: 4, fill: '#6f4526' }),
        h('rect', { x: 18, y: 17, width: 6, height: 5, fill: '#a06a3d' }),
        h('rect', { x: 12, y: 24, width: 7, height: 4, fill: '#6f4526' }),
      )
    }

    function Launcher() {
      const [open, setOpen] = React.useState(false)
      const [list, setList] = React.useState([])
      const [sessions, setSessions] = React.useState([])
      const [targetSession, setTargetSession] = React.useState('')
      const [status, setStatus] = React.useState('')
      const [active, setActive] = React.useState(0)

      const refresh = async () => {
        setStatus('正在搜索游戏内模组…')
        try {
          const [gameRes, sessionRes] = await Promise.all([
            fetch('/dsh-minecraft/discover'),
            fetch('/dsh-minecraft/sessions').catch(() => undefined),
          ])
          const data = await gameRes.json()
          setList(Array.isArray(data.list) ? data.list : [])
          setActive(Number(data.active) || 0)
          if (sessionRes) {
            const sessionData = await sessionRes.json().catch(() => ({}))
            const items = Array.isArray(sessionData.list) ? sessionData.list : []
            setSessions(items)
            setTargetSession((prev) => (items.some((s) => s.id === prev) ? prev : items.length ? items[0].id : ''))
          }
          setStatus((data.list || []).length ? '' : '没找到。确认游戏开着、装了 dsh_minecraft 模组。')
        } catch (error) {
          setStatus('搜索失败：' + String(error && error.message))
        }
      }

      const connect = async (port) => {
        try {
          const chosen = sessions.find((s) => s.id === targetSession)
          const res = await fetch('/dsh-minecraft/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ port, agentId: targetSession }),
          })
          const data = await res.json()
          if (data.ok) {
            setActive(port)
            setStatus('已接入 127.0.0.1:' + port + (chosen ? ' · 绑定：' + chosen.title : ''))
          } else {
            setStatus('连接失败：' + (data.error || 'unknown'))
          }
        } catch (error) {
          setStatus('连接失败：' + String(error && error.message))
        }
      }

      React.useEffect(() => {
        if (open) refresh()
      }, [open])

      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            style: BUTTON,
            title: '连接 Minecraft (dsh_minecraft)',
            onClick: () => setOpen((v) => !v),
          },
          h(GrassBlock),
        ),
        open
          ? h(
              'div',
              { style: PANEL },
              h('div', { style: { fontWeight: 600, marginBottom: 8 } }, 'Minecraft 实例'),
              h('div', { style: { fontWeight: 600, margin: '4px 0 6px' } }, '绑定的会话'),
              ...sessions.map((session) =>
                h(
                  'button',
                  {
                    key: session.id,
                    onClick: () => setTargetSession(session.id),
                    style: {
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '6px 10px',
                      marginBottom: 4,
                      borderRadius: 8,
                      border: session.id === targetSession ? '1px solid #6aa84f' : '1px solid rgba(255,255,255,0.12)',
                      background: session.id === targetSession ? 'rgba(106,168,79,0.18)' : 'rgba(255,255,255,0.04)',
                      color: 'inherit',
                      cursor: 'pointer',
                      fontSize: 12,
                    },
                  },
                  (session.id === targetSession ? '● ' : '○ ') + (session.title || session.id.slice(0, 8)),
                ),
              ),
              h('div', { style: { opacity: 0.5, margin: '8px 0 4px', fontSize: 12 } }, '———— 游戏实例 ————'),
              list.length === 0 && status ? h('div', { style: { opacity: 0.7, marginBottom: 8 } }, status) : null,
              ...list.map((item) =>
                h(
                  'button',
                  {
                    key: item.port,
                    onClick: () => connect(item.port),
                    style: {
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 10px',
                      marginBottom: 6,
                      borderRadius: 8,
                      border: item.port === active ? '1px solid #6aa84f' : '1px solid rgba(255,255,255,0.12)',
                      background: item.port === active ? 'rgba(106,168,79,0.18)' : 'rgba(255,255,255,0.04)',
                      color: 'inherit',
                      cursor: 'pointer',
                      fontSize: 13,
                    },
                  },
                  h('div', null, `127.0.0.1:${item.port}${item.port === active ? ' ✓' : ''}`),
                  h(
                    'div',
                    { style: { opacity: 0.65, fontSize: 12 } },
                    `查看 ${item.allowView ? '开' : '关'} · 控制 ${item.allowControl ? '开' : '关'}`,
                  ),
                ),
              ),
              h(
                'button',
                {
                  onClick: refresh,
                  style: {
                    width: '100%',
                    padding: '6px 10px',
                    marginTop: 4,
                    borderRadius: 8,
                    border: '1px solid rgba(255,255,255,0.12)',
                    background: 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                  },
                },
                '重新搜索',
              ),
              status && list.length ? h('div', { style: { opacity: 0.75, marginTop: 8 } }, status) : null,
            )
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'mc-bridge-launcher', order: 50 }, Launcher),
        )
      },
    }
  },
})
