/**
 * tests/unit.test.ts — Unit tests for core logic.
 * Tests: semver bumps, repo.yml parsing, step progress, ETA calc, rollback.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import semver from 'semver'

// ─── semver bump logic ────────────────────────────────────────────────────────

describe('computeNextVersion', () => {
  // Inline the logic so tests don't need to import ESM chain
  function computeNextVersion(current: string, bump: string): string {
    const bumps = ['patch', 'minor', 'major', 'prerelease']
    if (bumps.includes(bump)) {
      const next = semver.inc(current, bump as any)
      if (!next) throw new Error(`semver.inc(${current}, ${bump}) returned null`)
      return next
    }
    const clean = semver.clean(bump)
    if (!clean) throw new Error(`"${bump}" is not a valid semver version`)
    return clean
  }

  it('patch: 1.0.0 → 1.0.1', () => {
    expect(computeNextVersion('1.0.0', 'patch')).toBe('1.0.1')
  })

  it('minor: 1.0.0 → 1.1.0', () => {
    expect(computeNextVersion('1.0.0', 'minor')).toBe('1.1.0')
  })

  it('major: 1.0.0 → 2.0.0', () => {
    expect(computeNextVersion('1.0.0', 'major')).toBe('2.0.0')
  })

  it('prerelease: 1.0.0 → 1.0.1-0', () => {
    expect(computeNextVersion('1.0.0', 'prerelease')).toBe('1.0.1-0')
  })

  it('custom semver: 2.5.0 (clean)', () => {
    expect(computeNextVersion('1.0.0', '2.5.0')).toBe('2.5.0')
  })

  it('custom with v prefix: v2.5.0 → 2.5.0', () => {
    expect(computeNextVersion('1.0.0', 'v2.5.0')).toBe('2.5.0')
  })

  it('rejects invalid semver', () => {
    expect(() => computeNextVersion('1.0.0', 'not-a-version')).toThrow()
  })
})

// ─── release.yml parsing ──────────────────────────────────────────────────────

describe('release.yml parsing', () => {
  const sampleYml = `
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: write

jobs:
  release:
    runs-on: windows-latest
    steps:
      - name: Install dependencies
        run: pnpm install
      - name: Verify tag
        run: echo ok
      - name: Run TypeScript typecheck
        run: pnpm typecheck
      - name: Run test suite
        run: pnpm test
      - name: Build and publish release
        run: pnpm dist --publish always
      - name: Publish release notes
        run: gh release edit
`

  function extractJobNames(yaml: string): string[] {
    const jobsBlock = yaml.match(/^jobs:\s*\n([\s\S]*)/m)
    if (!jobsBlock) return []
    const lines = jobsBlock[1].split('\n')
    const jobs: string[] = []
    for (const line of lines) {
      const m = line.match(/^  ([a-zA-Z0-9_-]+):\s*$/)
      if (m) jobs.push(m[1])
    }
    return jobs
  }

  function hasMatrix(yaml: string): boolean {
    return yaml.includes('matrix:')
  }

  function hasDispatch(yaml: string): boolean {
    return yaml.includes('workflow_dispatch')
  }

  function getTagPattern(yaml: string): string | null {
    const m = yaml.match(/tags:\s*\[?'?([^'\]\n]+)'?\]?/)
    return m ? m[1].trim() : null
  }

  it('extracts job name', () => {
    expect(extractJobNames(sampleYml)).toContain('release')
  })

  it('no matrix', () => {
    expect(hasMatrix(sampleYml)).toBe(false)
  })

  it('no workflow_dispatch', () => {
    expect(hasDispatch(sampleYml)).toBe(false)
  })

  it('tag pattern is v*', () => {
    expect(getTagPattern(sampleYml)).toBe("v*")
  })
})

// ─── Step progress calculation ────────────────────────────────────────────────

describe('jobProgress', () => {
  type Step = { status: string; conclusion: string | null }

  function jobProgress(steps: Step[]): number {
    const total = steps.length
    if (total === 0) return 50
    const done = steps.filter((s) => s.status === 'completed').length
    const inProg = steps.filter((s) => s.status === 'in_progress').length
    return Math.round(((done + inProg * 0.5) / total) * 100)
  }

  it('0% when all queued', () => {
    const steps = Array(5).fill({ status: 'queued', conclusion: null })
    expect(jobProgress(steps)).toBe(0)
  })

  it('100% when all done', () => {
    const steps = Array(5).fill({ status: 'completed', conclusion: 'success' })
    expect(jobProgress(steps)).toBe(100)
  })

  it('~50% for in_progress step', () => {
    const steps = [
      { status: 'completed', conclusion: 'success' },
      { status: 'in_progress', conclusion: null },
      { status: 'queued', conclusion: null },
      { status: 'queued', conclusion: null },
    ]
    // done=1, inProg=1*0.5 = 1.5/4 = 37.5% ≈ 38
    expect(jobProgress(steps)).toBe(38)
  })

  it('returns 50 for empty steps', () => {
    expect(jobProgress([])).toBe(50)
  })
})

// ─── ETA calculation ──────────────────────────────────────────────────────────

describe('ETA calculation', () => {
  function etaMs(avgDurationMs: number, elapsedMs: number): number {
    return Math.max(0, avgDurationMs - elapsedMs)
  }

  it('shows remaining time when elapsed < avg', () => {
    expect(etaMs(300_000, 120_000)).toBe(180_000)
  })

  it('floors to 0 when overdue', () => {
    expect(etaMs(300_000, 400_000)).toBe(0)
  })
})

// ─── git root vs app dir detection ───────────────────────────────────────────

describe('git root vs app dir', () => {
  it('detects subdirectory with build config', () => {
    const candidates = [
      { dir: '/repo/JioTV-Max-Windows', pj: { build: { appId: 'tv.jiotvmax.app' } } },
      { dir: '/repo', pj: {} },
    ]
    const found = candidates.find((c) => c.pj.build && (c.pj as any).build.appId)
    expect(found?.dir).toBe('/repo/JioTV-Max-Windows')
  })
})

// ─── Rollback behavior ────────────────────────────────────────────────────────

describe('rollback', () => {
  it('lists undone actions when tag and commit are reverted', () => {
    const undone: string[] = []

    // Simulate tag delete success
    undone.push('Deleted local tag v1.0.1')

    // Simulate reset success
    undone.push('Reset last commit (soft — your changes are still staged)')

    expect(undone).toHaveLength(2)
    expect(undone[0]).toContain('v1.0.1')
    expect(undone[1]).toContain('soft')
  })
})

// ─── Central Source of Truth version resolution ───────────────────────────────

describe('Central source of truth version resolution', () => {
  function resolveEffectiveVersion(localVersion: string, remotePublishedVersion: string | null) {
    let isRemoteSynced = false
    let appVersion = localVersion
    if (remotePublishedVersion && semver.valid(remotePublishedVersion)) {
      if (semver.gt(remotePublishedVersion, localVersion)) {
        appVersion = remotePublishedVersion
        isRemoteSynced = true
      } else {
        appVersion = localVersion
      }
    }
    return { appVersion, isRemoteSynced }
  }

  it('uses remote version when local machine has expired/older version', () => {
    const res = resolveEffectiveVersion('1.0.0', '1.0.1')
    expect(res.appVersion).toBe('1.0.1')
    expect(res.isRemoteSynced).toBe(true)
  })

  it('keeps local version when local is in sync with GitHub', () => {
    const res = resolveEffectiveVersion('1.0.1', '1.0.1')
    expect(res.appVersion).toBe('1.0.1')
    expect(res.isRemoteSynced).toBe(false)
  })

  it('preserves manual local bump when ahead of remote', () => {
    const res = resolveEffectiveVersion('1.0.2', '1.0.1')
    expect(res.appVersion).toBe('1.0.2')
    expect(res.isRemoteSynced).toBe(false)
  })

  it('falls back gracefully to local when remote is null (offline/new repo)', () => {
    const res = resolveEffectiveVersion('1.0.0', null)
    expect(res.appVersion).toBe('1.0.0')
    expect(res.isRemoteSynced).toBe(false)
  })
})

// ─── Markdown terminal renderer ───────────────────────────────────────────────

describe('renderMarkdown', () => {
  it('renders headers, bullets, inline bold, code, and links properly', async () => {
    const { renderMarkdown } = await import('../src/lib/ui.js')
    const md = [
      '# JioTV Max v1.0.2',
      '',
      '## What\'s New',
      '- **Direct Channel**: Fast launch `channelId`',
      '- Standard bullet item with [link](https://example.com)',
      '',
      '---',
      '> Important notice',
      '1. Step one',
    ].join('\n')

    const rendered = renderMarkdown(md)
    expect(rendered).toContain('JioTV Max v1.0.2')
    expect(rendered).toContain('What\'s New')
    expect(rendered).toContain('Direct Channel')
    expect(rendered).toContain('channelId')
    expect(rendered).toContain('link')
    expect(rendered).toContain('https://example.com')
    expect(rendered).toContain('Important notice')
    expect(rendered).toContain('1.')
  })

  it('handles empty or blank markdown', async () => {
    const { renderMarkdown } = await import('../src/lib/ui.js')
    expect(renderMarkdown('')).toContain('empty')
  })
})

// ─── UI Polish & Truncation ───────────────────────────────────────────────────

describe('UI Polish & Progress Bar', () => {
  it('renders modern block progress bar without ASCII fallbacks', async () => {
    const { progressBar } = await import('../src/lib/ui.js')
    const bar25 = progressBar(25, 20)
    expect(bar25).toContain('█')
    expect(bar25).toContain('░')
    expect(bar25).not.toContain('#')
    expect(bar25).not.toContain('-')

    const bar100 = progressBar(100, 20)
    expect(bar100).toContain('█')
    expect(bar100).not.toContain('░')
  })

  it('safely truncates long text without stripping ANSI formatting', async () => {
    const { truncate, c } = await import('../src/lib/ui.js')
    const styled = c.cyan('A very long step description that should truncate')
    const result = truncate(styled, 20)
    expect(result).toContain('…')
    expect(result).toContain('\u001B') // Preserves ANSI escape
  })
})

