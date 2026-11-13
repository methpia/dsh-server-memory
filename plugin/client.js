/**
 * Browser half of `dsh-server-memory`.
 *
 * Adds one page to Settings → Plugins:
 *   - connection fields (service URL, token file, default project);
 *   - index/consolidation budgets;
 *   - a live project list where labels and aliases can be edited (the table that
 *     lets a conversation name a project instead of relying on a directory).
 *
 * All reads and writes go through the host's authenticated
 * `/api/dsh-server-memory` route, so the bearer token never reaches the browser.
 * Saving the configuration goes through the host config editor and restarts the
 * plugin; project edits apply immediately on the server.
 */

window.__ModuleLoader__.load({
  id: 'dsh-server-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'dshServerMemory'
    const ROUTE = '/api/dsh-server-memory'
    const TAB_ID = 'dsh-server-memory'

    const zh = {
      tab: '项目记忆',
      title: '项目记忆',
      subtitle: '自托管 memoryd 服务：索引注入、检索工具、每日聚合与项目别名。',
      statusUnknown: '未检查',
      statusChecking: '检查中…',
      statusOk: '服务已连接',
      statusError: '无法连接',
      refresh: '刷新',
      test: '测试连接',
      save: '保存配置',
      saving: '保存中…',
      connection: '连接',
      serverUrl: '记忆服务地址',
      serverUrlHint: '例如 http://192.168.5.5:8788，也可以填 Tailscale 的 https 地址。',
      tokenFile: 'token 文件',
      tokenHint: '留空表示不修改；token 文件建议 chmod 600。',
      token: '新的 token',
      tokenPlaceholder: '已配置则留空',
      defaultProject: '默认项目',
      defaultProjectHint: '工作目录和关键词都识别不出项目时使用。',
      budgets: '索引与聚合',
      indexMaxItems: '索引条数上限',
      indexMaxChars: '索引字符上限',
      claimIntervalHours: '聚合间隔（小时）',
      consolidationEnabled: '每天自动聚合',
      projects: '项目与别名',
      projectsHint: '在对话里提到项目名或别名（如「车易到」）即可定位到对应项目；WorkBuddy 每次新建目录也能命中。',
      pull: '拉取项目',
      projectId: '项目 id',
      label: '名称',
      aliases: '别名（逗号分隔）',
      items: '条记忆',
      saveRow: '保存',
      savedRow: '已保存',
      empty: '还没有项目。先让 agent 写入一条记忆，或直接在这里设置别名。',
      unavailable: '无法读取项目列表',
      saved: '配置已保存，插件正在重启；几秒后刷新即可看到新值。',
      loadError: '读取配置失败',
      tokenSet: '已配置 token',
      tokenUnset: '尚未配置 token',
      keywordHint: '别名建议 2–6 个高辨识度词，避免「结算」这类通用词。',
    }
    const en = {
      tab: 'Project memory',
      title: 'Project memory',
      subtitle: 'Self-hosted memoryd: prompt index, search tools, daily consolidation and project aliases.',
      statusUnknown: 'Not checked',
      statusChecking: 'Checking…',
      statusOk: 'Service connected',
      statusError: 'Unreachable',
      refresh: 'Refresh',
      test: 'Test connection',
      save: 'Save settings',
      saving: 'Saving…',
      connection: 'Connection',
      serverUrl: 'Service URL',
      serverUrlHint: 'For example http://192.168.5.5:8788 or a Tailscale HTTPS URL.',
      tokenFile: 'Token file',
      tokenHint: 'Leave empty to keep the current value; chmod 600 is recommended.',
      token: 'New token',
      tokenPlaceholder: 'Leave empty to keep',
      defaultProject: 'Default project',
      defaultProjectHint: 'Used when neither the working directory nor a keyword resolves a project.',
      budgets: 'Index and consolidation',
      indexMaxItems: 'Max index rows',
      indexMaxChars: 'Max index characters',
      claimIntervalHours: 'Consolidation interval (hours)',
      consolidationEnabled: 'Daily consolidation',
      projects: 'Projects and aliases',
      projectsHint: 'Mentioning a project name or alias (e.g. “cheyidao”) addresses that project even when WorkBuddy creates a new directory each session.',
      pull: 'Load projects',
      projectId: 'Project id',
      label: 'Label',
      aliases: 'Aliases (comma separated)',
      items: 'memories',
      saveRow: 'Save',
      savedRow: 'Saved',
      empty: 'No projects yet. Let the agent save one memory, or set an alias here.',
      unavailable: 'Could not load projects',
      saved: 'Settings saved. The plugin is restarting; reopen this page in a few seconds.',
      loadError: 'Could not load settings',
      tokenSet: 'A token is configured',
      tokenUnset: 'No token configured',
      keywordHint: 'Prefer 2–6 distinctive aliases; avoid generic words like “billing”.',
    }

    const CSS = `
.dsm-page{box-sizing:border-box;max-width:760px;padding:24px 0 48px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.dsm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}
.dsm-title{margin:0;font-size:18px;font-weight:600;line-height:26px}
.dsm-sub{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dsm-status{display:inline-flex;align-items:center;gap:6px;flex:none;padding:3px 10px;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsm-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.dsm-status[data-state=ok] .dsm-dot{background:var(--dsw-alias-state-success-primary)}
.dsm-status[data-state=error] .dsm-dot{background:var(--dsw-alias-state-error-primary)}
.dsm-status[data-state=checking] .dsm-dot{background:var(--dsw-alias-state-warn-primary)}
.dsm-card{border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1);padding:16px 18px;margin-bottom:14px}
.dsm-cardHead{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px}
.dsm-cardTitle{margin:0;font-size:14px;font-weight:600;line-height:22px}
.dsm-cardHint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsm-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px}
.dsm-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.dsm-field[data-span=full]{grid-column:1 / -1}
.dsm-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsm-input{box-sizing:border-box;width:100%;min-height:32px;padding:6px 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.dsm-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dsm-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}
.dsm-check{display:flex;align-items:center;gap:8px;padding-top:20px;color:var(--dsw-alias-label-secondary);font-size:13px}
.dsm-check input{accent-color:var(--dsw-alias-brand-primary);width:15px;height:15px}
.dsm-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:14px}
.dsm-btn{display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:4px 12px;border-radius:var(--dsw-radius-md,8px);border:0.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.dsm-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.dsm-btn:disabled{opacity:.5;cursor:default}
.dsm-btn[data-variant=primary]{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.dsm-btn[data-variant=primary]:hover{filter:brightness(1.05);background:var(--dsw-alias-brand-primary)}
.dsm-alert{margin:10px 0 0;padding:8px 10px;border-radius:var(--dsw-radius-md,8px);border:0.5px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.dsm-notice{margin:10px 0 0;padding:8px 10px;border-radius:var(--dsw-radius-md,8px);border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsm-projectList{display:flex;flex-direction:column;gap:10px;margin-top:12px}
.dsm-project{display:grid;grid-template-columns:130px minmax(0,1fr) minmax(0,1.3fr) auto;gap:10px;align-items:end;padding-top:10px;border-top:0.5px solid var(--dsw-alias-border-l1)}
.dsm-project:first-child{border-top:0;padding-top:0}
.dsm-projectId{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:13px;padding-bottom:7px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-projectMeta{display:flex;flex-direction:column;gap:2px;padding-bottom:4px}
.dsm-projectCount{color:var(--dsw-alias-label-caption);font-size:12px;line-height:16px;font-variant-numeric:tabular-nums}
.dsm-rowStatus{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:16px;min-height:16px}
.dsm-rowStatus[data-error=true]{color:var(--dsw-alias-state-error-primary)}
.dsm-empty{color:var(--dsw-alias-label-secondary);font-size:13px;padding:10px 0}
@media (max-width:640px){
  .dsm-grid{grid-template-columns:minmax(0,1fr)}
  .dsm-project{grid-template-columns:minmax(0,1fr);gap:6px}
  .dsm-projectId{padding-bottom:0}
}
`

    function splitAliases(value) {
      return String(value ?? '')
        .split(/[,，]/)
        .map((part) => part.trim())
        .filter((part) => part !== '')
    }

    // Replaced with the bound locale function in `apply`. Until then the Chinese
    // dictionary is a safe fallback so the component never renders raw keys.
    let translate = (key) => zh[key] ?? key

    async function api(body) {
      const response = await fetch(ROUTE, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers: body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let data
      try {
        data = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!response.ok || data.ok === false) {
        throw new Error(data.message ?? data.error ?? `HTTP ${response.status}`)
      }
      return data
    }

    function SettingsPage() {
      const t = (key) => translate(key)

      const [loading, setLoading] = useState(true)
      const [loadError, setLoadError] = useState('')
      const [form, setForm] = useState({
        serverUrl: '',
        tokenFile: '',
        token: '',
        defaultProject: '',
        indexMaxItems: 6,
        indexMaxChars: 900,
        claimIntervalHours: 24,
        consolidationEnabled: true,
      })
      const [hasToken, setHasToken] = useState(false)
      const [connection, setConnection] = useState({ state: 'unknown', message: '' })
      const [saving, setSaving] = useState(false)
      const [notice, setNotice] = useState('')
      const [saveError, setSaveError] = useState('')

      const [projects, setProjects] = useState([])
      const [projectsState, setProjectsState] = useState('idle')
      const [projectsError, setProjectsError] = useState('')
      const [drafts, setDrafts] = useState({})
      const [rowStatus, setRowStatus] = useState({})
      const mounted = useRef(true)
      useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
      }, [])

      const applySettings = useCallback((settings) => {
        setForm({
          serverUrl: settings.serverUrl ?? '',
          tokenFile: settings.tokenFile ?? '',
          token: '',
          defaultProject: settings.defaultProject ?? 'default',
          indexMaxItems: settings.indexMaxItems ?? 6,
          indexMaxChars: settings.indexMaxChars ?? 900,
          claimIntervalHours: settings.claimIntervalHours ?? 24,
          consolidationEnabled: settings.consolidationEnabled !== false,
        })
        setHasToken(settings.hasToken === true)
      }, [])

      const loadSettings = useCallback(async () => {
        try {
          const data = await api()
          if (!mounted.current) return
          applySettings(data.settings)
          setLoadError('')
        } catch (error) {
          if (mounted.current) setLoadError(`${t('loadError')}：${error.message}`)
        } finally {
          if (mounted.current) setLoading(false)
        }
      }, [applySettings])

      const checkHealth = useCallback(async () => {
        setConnection({ state: 'checking', message: '' })
        try {
          const data = await api({ action: 'health' })
          if (!mounted.current) return
          if (data.ok === true) {
            const health = data.health ?? {}
            setConnection({
              state: 'ok',
              message: `${t('statusOk')} · ${health.items ?? 0} 条记忆 / ${health.projects ?? 0} 个项目`,
            })
          } else {
            setConnection({ state: 'error', message: data.error ?? t('statusError') })
          }
        } catch (error) {
          if (mounted.current) setConnection({ state: 'error', message: error.message })
        }
      }, [])

      const loadProjects = useCallback(async () => {
        setProjectsState('loading')
        setProjectsError('')
        try {
          const data = await api({ action: 'projects' })
          if (!mounted.current) return
          if (data.ok !== true) {
            setProjectsState('error')
            setProjectsError(data.error ?? t('unavailable'))
            return
          }
          const list = Array.isArray(data.projects) ? data.projects : []
          setProjects(list)
          const nextDrafts = {}
          for (const project of list) {
            nextDrafts[project.id] = {
              label: project.label ?? project.id,
              aliases: Array.isArray(project.aliases) ? project.aliases.join(', ') : '',
            }
          }
          setDrafts(nextDrafts)
          setProjectsState('ready')
        } catch (error) {
          if (!mounted.current) return
          setProjectsState('error')
          setProjectsError(error.message)
        }
      }, [])

      useEffect(() => { void loadSettings() }, [loadSettings])
      useEffect(() => {
        if (loading) return
        void checkHealth()
        void loadProjects()
      }, [loading, checkHealth, loadProjects])

      const setField = (key, value) => setForm((current) => ({ ...current, [key]: value }))

      const saveSettings = async () => {
        setSaving(true)
        setSaveError('')
        setNotice('')
        const patch = {
          serverUrl: form.serverUrl,
          tokenFile: form.tokenFile,
          defaultProject: form.defaultProject,
          indexMaxItems: Number(form.indexMaxItems),
          indexMaxChars: Number(form.indexMaxChars),
          claimIntervalHours: Number(form.claimIntervalHours),
          consolidationEnabled: form.consolidationEnabled === true,
        }
        if (form.token.trim() !== '') patch.token = form.token.trim()
        try {
          await api({ action: 'save-settings', patch })
          if (!mounted.current) return
          setNotice(t('saved'))
          setForm((current) => ({ ...current, token: '' }))
          window.setTimeout(() => { void loadSettings(); void checkHealth() }, 1800)
        } catch (error) {
          if (mounted.current) setSaveError(error.message)
        } finally {
          if (mounted.current) setSaving(false)
        }
      }

      const saveProject = async (project) => {
        const draft = drafts[project.id] ?? { label: project.label, aliases: '' }
        setRowStatus((current) => ({ ...current, [project.id]: { text: '', error: false } }))
        try {
          const data = await api({
            action: 'save-project',
            project: project.id,
            label: draft.label,
            aliases: splitAliases(draft.aliases),
          })
          if (!mounted.current) return
          if (data.ok !== true) throw new Error(data.error ?? t('unavailable'))
          setRowStatus((current) => ({ ...current, [project.id]: { text: t('savedRow'), error: false } }))
          setProjects((current) =>
            current.map((entry) =>
              entry.id === project.id
                ? { ...entry, label: data.project?.label ?? entry.label, aliases: data.project?.aliases ?? entry.aliases }
                : entry,
            ),
          )
        } catch (error) {
          if (!mounted.current) return
          setRowStatus((current) => ({ ...current, [project.id]: { text: error.message, error: true } }))
        }
      }

      const state = connection.state
      const statusText =
        state === 'checking' ? t('statusChecking')
          : state === 'ok' ? (connection.message || t('statusOk'))
            : state === 'error' ? `${t('statusError')}：${connection.message}`
              : t('statusUnknown')

      const field = (key, label, options = {}) =>
        h('label', { className: 'dsm-field', 'data-span': options.full ? 'full' : undefined, htmlFor: `dsm-${key}` },
          h('span', { className: 'dsm-label' }, label),
          h('input', {
            id: `dsm-${key}`,
            className: 'dsm-input',
            type: options.type ?? 'text',
            value: form[key],
            placeholder: options.placeholder,
            min: options.min,
            autoComplete: 'off',
            spellCheck: false,
            onChange: (event) => setField(key, options.numeric ? event.target.value : event.target.value),
          }),
          options.hint ? h('span', { className: 'dsm-hint' }, options.hint) : null,
        )

      return h('section', { className: 'dsm-page', 'aria-label': t('title') },
        h('style', null, CSS),
        h('div', { className: 'dsm-head' },
          h('div', null,
            h('h2', { className: 'dsm-title' }, t('title')),
            h('p', { className: 'dsm-sub' }, t('subtitle')),
          ),
          h('span', { className: 'dsm-status', 'data-state': state, role: 'status', 'aria-live': 'polite' },
            h('span', { className: 'dsm-dot', 'aria-hidden': 'true' }),
            statusText,
          ),
        ),

        loading ? h('div', { className: 'dsm-empty' }, '…') : null,
        loadError !== '' ? h('p', { className: 'dsm-alert', role: 'alert' }, loadError) : null,

        !loading
          ? h('div', { className: 'dsm-card' },
              h('div', { className: 'dsm-cardHead' },
                h('h3', { className: 'dsm-cardTitle' }, t('connection')),
                h('span', { className: 'dsm-cardHint' }, hasToken ? t('tokenSet') : t('tokenUnset')),
              ),
              h('div', { className: 'dsm-grid' },
                field('serverUrl', t('serverUrl'), { full: true, hint: t('serverUrlHint') }),
                field('tokenFile', t('tokenFile'), { full: true, hint: t('tokenHint') }),
                field('token', t('token'), { type: 'password', placeholder: t('tokenPlaceholder') }),
                field('defaultProject', t('defaultProject'), { full: true, hint: t('defaultProjectHint') }),
              ),
              h('div', { className: 'dsm-actions' },
                h('button', { type: 'button', className: 'dsm-btn', onClick: () => void checkHealth(), disabled: state === 'checking' }, t('test')),
                h('button', { type: 'button', className: 'dsm-btn', onClick: () => void loadProjects() }, t('pull')),
                h('button', { type: 'button', className: 'dsm-btn', 'data-variant': 'primary', onClick: () => void saveSettings(), disabled: saving }, saving ? t('saving') : t('save')),
              ),
              saveError !== '' ? h('p', { className: 'dsm-alert', role: 'alert' }, saveError) : null,
              notice !== '' ? h('p', { className: 'dsm-notice', role: 'status' }, notice) : null,
            )
          : null,

        !loading
          ? h('div', { className: 'dsm-card' },
              h('div', { className: 'dsm-cardHead' }, h('h3', { className: 'dsm-cardTitle' }, t('budgets'))),
              h('div', { className: 'dsm-grid' },
                field('indexMaxItems', t('indexMaxItems'), { type: 'number', min: 1, numeric: true }),
                field('indexMaxChars', t('indexMaxChars'), { type: 'number', min: 200, numeric: true }),
                field('claimIntervalHours', t('claimIntervalHours'), { type: 'number', min: 0.25, numeric: true }),
                h('label', { className: 'dsm-check', htmlFor: 'dsm-consolidation' },
                  h('input', {
                    id: 'dsm-consolidation',
                    type: 'checkbox',
                    checked: form.consolidationEnabled === true,
                    onChange: (event) => setField('consolidationEnabled', event.target.checked),
                  }),
                  t('consolidationEnabled'),
                ),
              ),
            )
          : null,

        !loading
          ? h('div', { className: 'dsm-card' },
              h('div', { className: 'dsm-cardHead' },
                h('h3', { className: 'dsm-cardTitle' }, t('projects')),
                h('span', { className: 'dsm-cardHint' }, t('keywordHint')),
              ),
              h('p', { className: 'dsm-cardHint' }, t('projectsHint')),
              projectsError !== '' ? h('p', { className: 'dsm-alert', role: 'alert' }, projectsError) : null,
              projectsState === 'loading' ? h('div', { className: 'dsm-empty' }, '…') : null,
              projectsState !== 'loading' && projects.length === 0 && projectsError === ''
                ? h('div', { className: 'dsm-empty' }, t('empty'))
                : null,
              projects.length > 0
                ? h('div', { className: 'dsm-projectList' },
                    ...projects.map((project) => {
                      const draft = drafts[project.id] ?? { label: project.label ?? project.id, aliases: '' }
                      const status = rowStatus[project.id]
                      return h('div', { className: 'dsm-project', key: project.id },
                        h('div', null,
                          h('div', { className: 'dsm-projectId', title: project.id }, project.id),
                          h('div', { className: 'dsm-projectMeta' },
                            h('span', { className: 'dsm-projectCount' }, `${project.items ?? 0} ${t('items')}`),
                            status ? h('span', { className: 'dsm-rowStatus', 'data-error': status.error === true }, status.text) : null,
                          ),
                        ),
                        h('label', { className: 'dsm-field', htmlFor: `dsm-label-${project.id}` },
                          h('span', { className: 'dsm-label' }, t('label')),
                          h('input', {
                            id: `dsm-label-${project.id}`,
                            className: 'dsm-input',
                            value: draft.label,
                            onChange: (event) => setDrafts((current) => ({ ...current, [project.id]: { ...draft, label: event.target.value } })),
                          }),
                        ),
                        h('label', { className: 'dsm-field', htmlFor: `dsm-alias-${project.id}` },
                          h('span', { className: 'dsm-label' }, t('aliases')),
                          h('input', {
                            id: `dsm-alias-${project.id}`,
                            className: 'dsm-input',
                            value: draft.aliases,
                            placeholder: '车易到, cheyidao',
                            onChange: (event) => setDrafts((current) => ({ ...current, [project.id]: { ...draft, aliases: event.target.value } })),
                          }),
                        ),
                        h('button', { type: 'button', className: 'dsm-btn', onClick: () => void saveProject(project) }, t('saveRow')),
                      )
                    }),
                  )
                : null,
            )
          : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-server-memory: dictionaries')
        translate = ctx.locale.bind(NS)
        ctx.slots.inject('settings.plugins.tab', () =>
          ctx.slots.register(
            {
              name: 'settings.plugins.tab',
              id: TAB_ID,
              order: 45,
              label: () => translate('tab'),
            },
            SettingsPage,
          ),
        )
      },
    }
  },
})
