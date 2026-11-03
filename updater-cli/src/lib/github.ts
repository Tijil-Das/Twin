/**
 * github.ts — Thin GitHub API client.
 * Uses native fetch, ETag conditional requests, rate-limit handling.
 * Auth order: GITHUB_TOKEN / GH_TOKEN env → friendly error.
 * Never prints the token.
 */

import { execSync } from 'node:child_process'
import { getStoredToken } from './config.js'

export interface GhRelease {
  id: number
  tag_name: string
  name: string
  draft: boolean
  prerelease: boolean
  published_at: string
  html_url: string
  assets: GhAsset[]
}

export interface GhAsset {
  id: number
  name: string
  browser_download_url: string
  size: number
  state: string
}

export interface WorkflowRun {
  id: number
  name: string
  status: 'queued' | 'in_progress' | 'completed' | string
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | null
  html_url: string
  run_number: number
  created_at: string
  updated_at: string
  head_sha: string
  head_branch?: string
  workflow_id: number
}

export interface WorkflowJob {
  id: number
  name: string
  status: 'queued' | 'in_progress' | 'completed' | string
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | null
  started_at: string | null
  completed_at: string | null
  steps: WorkflowStep[]
}

export interface WorkflowStep {
  name: string
  status: 'queued' | 'in_progress' | 'completed' | string
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | null
  number: number
}

interface ETagEntry {
  etag: string
  data: unknown
}

const etagCache = new Map<string, ETagEntry>()

let cachedToken: string | null | undefined = undefined

export function clearTokenCache(): void {
  cachedToken = undefined
}

export function getToken(): string | null {
  if (cachedToken !== undefined) return cachedToken
  
  // 1. Check local persistent config
  const stored = getStoredToken()
  if (stored) {
    cachedToken = stored
    return cachedToken
  }

  // 2. Check environment variables
  const envToken = process.env['GITHUB_TOKEN'] || process.env['GH_TOKEN']
  if (envToken) {
    cachedToken = envToken.trim()
    return cachedToken
  }

  // 3. Fall back to Git Credential Manager
  try {
    const out: string = execSync('git credential fill', {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const match = out.match(/^password=(.+)$/m)
    cachedToken = match ? match[1].trim() : null
  } catch {
    cachedToken = null
  }
  return cachedToken
}

export function hasToken(): boolean {
  return getToken() !== null
}

async function ghFetch<T>(
  url: string,
  options: { conditional?: boolean; retries?: number } = {}
): Promise<T> {
  const { conditional = true, retries = 3 } = options
  const token = getToken()

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'jiotv-max-updater-cli/1.0',
  }
  if (token) headers['Authorization'] = `token ${token}`

  const cached = conditional ? etagCache.get(url) : undefined
  if (cached) headers['If-None-Match'] = cached.etag

  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(url, { headers })

    // Rate limit handling
    if (res.status === 429 || res.status === 403) {
      const retryAfter = res.headers.get('retry-after')
      const resetAt = res.headers.get('x-ratelimit-reset')
      let waitMs = 60_000
      if (retryAfter) waitMs = parseInt(retryAfter, 10) * 1000
      else if (resetAt) waitMs = Math.max(0, parseInt(resetAt, 10) * 1000 - Date.now())
      if (attempt < retries - 1) {
        await sleep(Math.min(waitMs, 30_000))
        continue
      }
    }

    // Not modified — return cached
    if (res.status === 304 && cached) return cached.data as T

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new GhAuthError(
          'GitHub authentication failed. Set GITHUB_TOKEN or GH_TOKEN environment variable.'
        )
      }
      throw new Error(`GitHub API ${res.status}: ${url}`)
    }

    const data = (await res.json()) as T
    const etag = res.headers.get('etag')
    if (etag && conditional) etagCache.set(url, { etag, data })
    return data
  }

  throw new Error(`GitHub API request failed after ${retries} retries: ${url}`)
}

export class GhAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GhAuthError'
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function apiBase(owner: string, repo: string) {
  return `https://api.github.com/repos/${owner}/${repo}`
}

export async function getLatestRelease(
  owner: string,
  repo: string
): Promise<GhRelease | null> {
  try {
    return await ghFetch<GhRelease>(`${apiBase(owner, repo)}/releases/latest`)
  } catch (e) {
    if (e instanceof Error && e.message.includes('404')) return null
    throw e
  }
}

export async function getReleaseByTag(
  owner: string,
  repo: string,
  tag: string
): Promise<GhRelease | null> {
  try {
    return await ghFetch<GhRelease>(
      `${apiBase(owner, repo)}/releases/tags/${encodeURIComponent(tag)}`
    )
  } catch {
    // GitHub API returns 404 for draft releases or during tag propagation.
    // Fall back to checking recent releases list so draft/publishing releases can still be tracked.
    try {
      const releases = await ghFetch<GhRelease[]>(
        `${apiBase(owner, repo)}/releases?per_page=20`,
        { conditional: false }
      )
      const match = releases.find((r) => r.tag_name === tag)
      return match || null
    } catch {
      return null
    }
  }
}

export async function listWorkflowRuns(
  owner: string,
  repo: string,
  workflowFile: string,
  filter?: { headSha?: string; branch?: string } | string
): Promise<WorkflowRun[]> {
  const fileName = workflowFile.split('/').pop() || workflowFile
  let url = `${apiBase(owner, repo)}/actions/workflows/${encodeURIComponent(fileName)}/runs?per_page=10`
  if (typeof filter === 'string') {
    url += `&head_sha=${encodeURIComponent(filter)}`
  } else if (filter) {
    if (filter.branch) url += `&branch=${encodeURIComponent(filter.branch)}`
    if (filter.headSha) url += `&head_sha=${encodeURIComponent(filter.headSha)}`
  }
  const res = await ghFetch<{ workflow_runs: WorkflowRun[] }>(url, { conditional: false })
  return res.workflow_runs || []
}

export async function getWorkflowRun(
  owner: string,
  repo: string,
  runId: number
): Promise<WorkflowRun> {
  return ghFetch<WorkflowRun>(`${apiBase(owner, repo)}/actions/runs/${runId}`, {
    conditional: false,
  })
}

export async function getWorkflowJobs(
  owner: string,
  repo: string,
  runId: number
): Promise<WorkflowJob[]> {
  const res = await ghFetch<{ jobs: WorkflowJob[] }>(
    `${apiBase(owner, repo)}/actions/runs/${runId}/jobs`,
    { conditional: false }
  )
  return res.jobs || []
}

export async function getJobLog(
  owner: string,
  repo: string,
  jobId: number
): Promise<string> {
  const token = getToken()
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'jiotv-max-updater-cli/1.0',
  }
  if (token) headers['Authorization'] = `token ${token}`

  const res = await fetch(`${apiBase(owner, repo)}/actions/jobs/${jobId}/logs`, { headers })
  if (!res.ok) return ''
  return res.text()
}

/** Get average duration of the last N successful runs (for ETA). */
export async function getAverageRunDuration(
  owner: string,
  repo: string,
  workflowFile: string,
  n = 5
): Promise<number | null> {
  try {
    const fileName = workflowFile.split('/').pop() || workflowFile
    const url = `${apiBase(owner, repo)}/actions/workflows/${encodeURIComponent(fileName)}/runs?status=success&per_page=${n}`
    const res = await ghFetch<{ workflow_runs: WorkflowRun[] }>(url)
    const runs = res.workflow_runs || []
    if (runs.length === 0) return null
    const durations = runs
      .filter((r) => r.created_at && r.updated_at)
      .map((r) => new Date(r.updated_at).getTime() - new Date(r.created_at).getTime())
    if (durations.length === 0) return null
    return Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
  } catch {
    return null
  }
}

/** Get the commit SHA of a tag (peeling annotated tags so it matches workflow head_sha). */
export async function getTagSha(
  owner: string,
  repo: string,
  tag: string
): Promise<string | null> {
  try {
    const res = await ghFetch<{ object: { sha: string; type?: string } }>(
      `${apiBase(owner, repo)}/git/refs/tags/${encodeURIComponent(tag)}`
    )
    if (!res.object?.sha) return null
    if (res.object.type === 'tag') {
      try {
        const tagObj = await ghFetch<{ object: { sha: string } }>(
          `${apiBase(owner, repo)}/git/tags/${res.object.sha}`
        )
        return tagObj.object?.sha || res.object.sha
      } catch {
        return res.object.sha
      }
    }
    return res.object.sha
  } catch {
    return null
  }
}

/** Download a manifest file and return its text. */
export async function downloadManifest(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return res.text()
  } catch {
    return null
  }
}

/** Upload an asset to a GitHub release. */
export async function uploadReleaseAsset(
  owner: string,
  repo: string,
  releaseId: number,
  assetName: string,
  data: Buffer,
  contentType = 'application/octet-stream'
): Promise<GhAsset> {
  const token = getToken()
  if (!token) throw new GhAuthError('GitHub token required to upload release assets.')
  const url = `https://uploads.github.com/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `token ${token}`,
      'Content-Type': contentType,
      'Content-Length': String(data.length),
      'User-Agent': 'jiotv-max-updater-cli/1.0',
    },
    body: data as unknown as BodyInit,
  })
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Failed to upload asset ${assetName} (${res.status}): ${errText}`)
  }
  return (await res.json()) as GhAsset
}

/** Delete an asset from a GitHub release by asset ID. */
export async function deleteReleaseAsset(
  owner: string,
  repo: string,
  assetId: number
): Promise<void> {
  const token = getToken()
  if (!token) throw new GhAuthError('GitHub token required to delete release assets.')
  const url = `${apiBase(owner, repo)}/releases/assets/${assetId}`
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `token ${token}`,
      'User-Agent': 'jiotv-max-updater-cli/1.0',
    },
  })
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to delete asset ${assetId} (${res.status})`)
  }
}

