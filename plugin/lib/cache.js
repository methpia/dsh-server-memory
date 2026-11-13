/**
 * Background context cache.
 *
 * `systemPrompt.section` is evaluated on every model step and must never touch
 * the network (DESIGN.md 7.1). This cache holds the last `/api/context` payload
 * per project and refreshes it on a timer; readers only ever read memory.
 *
 * Failure policy:
 *   - the service being down never throws into the host;
 *   - stale rows are kept when a refresh fails (better than losing memory);
 *   - a failing project is not retried before `contextPollMs` elapses.
 *
 * @module dsh-memory/cache
 */

import { describeMemoryError } from './client.js'

/** @typedef {import('./config.js').MemorySettings} MemorySettings */
/** @typedef {import('./client.js').MemoryClient} MemoryClient */

/**
 * @typedef {object} ContextSnapshot
 * @property {string} project
 * @property {Array<{id: number, kind: string, text: string, tags?: string, created_at: string}>} items
 * @property {{last_consolidated?: string, last_run_at?: string, last_status?: string}} watermark
 * @property {{due?: boolean, since?: string|null, reason?: string, next_at?: string|null}} consolidation
 * @property {number} fetchedAt Epoch ms of the last successful fetch (0 = never).
 * @property {string} [error] Last failure, kept so tools can explain degradation.
 */

export class ContextCache {
  /**
   * @param {{client: MemoryClient, settings: MemorySettings, clock?: () => number,
   *          onError?: (message: string) => void}} options
   */
  constructor(options) {
    this.client = options.client
    this.settings = options.settings
    this.clock = options.clock ?? (() => Date.now())
    this.onError = options.onError
    /** @type {Map<string, ContextSnapshot>} */
    this.entries = new Map()
    /** @type {Map<string, Promise<ContextSnapshot>>} */
    this.inflight = new Map()
    this.timer = undefined
  }

  /** Whether the cached snapshot is older than the poll interval or absent. */
  isStale(project) {
    const entry = this.entries.get(project)
    if (entry === undefined) return true
    return this.clock() - entry.fetchedAt >= this.settings.contextPollMs
  }

  /** Mark a project as interesting so the sweep refreshes it. */
  touch(project) {
    if (!this.entries.has(project)) {
      this.entries.set(project, {
        project,
        items: [],
        watermark: {},
        consolidation: {},
        fetchedAt: 0,
      })
    }
  }

  /**
   * Read the cached snapshot, scheduling a refresh when stale.
   * Never throws and never blocks.
   * @param {string} project
   * @returns {ContextSnapshot | undefined}
   */
  snapshot(project) {
    this.touch(project)
    if (this.isStale(project)) void this.refresh(project)
    return this.entries.get(project)
  }

  /** Invalidate after a write so the next prompt assembly reflects it. */
  invalidate(project) {
    const entry = this.entries.get(project)
    if (entry !== undefined) entry.fetchedAt = 0
    void this.refresh(project)
  }

  /**
   * Refresh one project.
   * @param {string} project
   * @param {{force?: boolean}} [options]
   * @returns {Promise<ContextSnapshot>}
   */
  refresh(project, options = {}) {
    const existing = this.inflight.get(project)
    if (existing !== undefined) return existing
    if (!options.force && !this.isStale(project)) {
      return Promise.resolve(this.entries.get(project))
    }

    const run = this.fetchSnapshot(project).finally(() => {
      this.inflight.delete(project)
    })
    this.inflight.set(project, run)
    return run
  }

  /**
   * @param {string} project
   * @returns {Promise<ContextSnapshot>}
   */
  async fetchSnapshot(project) {
    const previous = this.entries.get(project) ?? {
      project,
      items: [],
      watermark: {},
      consolidation: {},
      fetchedAt: 0,
    }
    try {
      const payload = await this.client.getContext(project, {
        limit: this.settings.indexMaxItems,
        maxChars: 1500,
      })
      const snapshot = {
        project,
        items: Array.isArray(payload?.items) ? payload.items : [],
        watermark: payload?.watermark ?? {},
        consolidation: payload?.consolidation ?? {},
        fetchedAt: this.clock(),
        error: undefined,
      }
      this.entries.set(project, snapshot)
      return snapshot
    } catch (error) {
      const snapshot = {
        ...previous,
        error: describeMemoryError(error),
        fetchedAt: this.clock(),
      }
      this.entries.set(project, snapshot)
      if (this.onError !== undefined) this.onError(snapshot.error)
      return snapshot
    }
  }

  /**
   * Start the background sweep (immediate refresh + poll interval).
   * @returns {() => void} disposer
   */
  start() {
    const refreshAll = () => {
      for (const project of this.entries.keys()) {
        if (this.isStale(project)) void this.refresh(project)
      }
    }
    refreshAll()
    this.timer = setInterval(refreshAll, this.settings.contextPollMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
    return () => {
      if (this.timer !== undefined) clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** Stop timers and drop pending work references. */
  stop() {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.inflight.clear()
  }
}
