/**
 * dashboard.ts — Live GitHub Actions run dashboard.
 * Uses log-update to render in-place. clack must NOT render at the same time.
 * Call startDashboard() AFTER clack's outro(). Restores cursor on exit/SIGINT.
 */

import logUpdate from 'log-update'
import {
  getWorkflowRun,
  getWorkflowJobs,
  listWorkflowRuns,
  getJobLog,
  getAverageRunDuration,
  getTagSha,
  WorkflowRun,
  WorkflowJob,
} from './github.js'
import {
  progressBar,
  fmtDuration,
  link,
  c,
  G,
  IS_TTY,
  termWidth,
  truncate,
  nextSpinnerFrame,
  showCursor,
  hideCursor,
} from './ui.js'

export interface DashboardOptions {
  owner: string
  repo: string
  workflowFile: string
  tag: string
  runId?: number
  simulate?: boolean
}

export interface DashboardResult {
  success: boolean
  runUrl: string
  runId: number
  durationMs: number
}

// ─── Simulation fixtures ──────────────────────────────────────────────────────

function makeSimulatedRun(tag: string): WorkflowRun {
  return {
    id: 99999,
    name: 'Release',
    status: 'in_progress',
    conclusion: null,
    html_url: `https://github.com/OWNER/REPO/actions/runs/99999`,
    run_number: 42,
    created_at: new Date(Date.now() - 30_000).toISOString(),
    updated_at: new Date().toISOString(),
    head_sha: 'abc1234',
    workflow_id: 1,
  }
}

let simStep = 0
const SIM_STEPS = ['queued', 'install', 'typecheck', 'test', 'build', 'publish', 'done', 'done']

function makeSimulatedJobs(scenarioStep: number): WorkflowJob[] {
  const phase = SIM_STEPS[Math.min(scenarioStep, SIM_STEPS.length - 1)]

  const jobs: WorkflowJob[] = [
    {
      id: 1,
      name: 'release',
      status: phase === 'queued' ? 'queued' : phase === 'done' ? 'completed' : 'in_progress',
      conclusion: phase === 'done' ? 'success' : null,
      started_at: phase !== 'queued' ? new Date(Date.now() - 60_000).toISOString() : null,
      completed_at: phase === 'done' ? new Date().toISOString() : null,
      steps: [
        {
          name: 'Install dependencies',
          number: 1,
          status:
            ['queued'].includes(phase)
              ? 'queued'
              : 'completed',
          conclusion: ['queued'].includes(phase) ? null : 'success',
        },
        {
          name: 'Verify tag matches package.json version',
          number: 2,
          status:
            ['queued', 'install'].includes(phase)
              ? 'queued'
              : 'completed',
          conclusion: ['queued', 'install'].includes(phase) ? null : 'success',
        },
        {
          name: 'Run TypeScript typecheck',
          number: 3,
          status: ['queued', 'install'].includes(phase)
            ? 'queued'
            : phase === 'typecheck'
            ? 'in_progress'
            : 'completed',
          conclusion: ['queued', 'install', 'typecheck'].includes(phase) ? null : 'success',
        },
        {
          name: 'Run test suite',
          number: 4,
          status: ['queued', 'install', 'typecheck'].includes(phase)
            ? 'queued'
            : phase === 'test'
            ? 'in_progress'
            : 'completed',
          conclusion: ['queued', 'install', 'typecheck', 'test'].includes(phase) ? null : 'success',
        },
        {
          name: 'Build and publish release',
          number: 5,
          status: ['queued', 'install', 'typecheck', 'test'].includes(phase)
            ? 'queued'
            : phase === 'build'
            ? 'in_progress'
            : 'completed',
          conclusion: ['queued', 'install', 'typecheck', 'test', 'build'].includes(phase)
            ? null
            : 'success',
        },
        {
          name: 'Publish release notes',
          number: 6,
          status: ['queued', 'install', 'typecheck', 'test', 'build'].includes(phase)
            ? 'queued'
            : phase === 'publish'
            ? 'in_progress'
            : 'completed',
          conclusion: ['queued', 'install', 'typecheck', 'test', 'build', 'publish'].includes(phase)
            ? null
            : 'success',
        },
      ],
    },
  ]
  return jobs
}

// ─── Render ───────────────────────────────────────────────────────────────────

function jobIcon(job: WorkflowJob, spinFrame: string): string {
  if (job.status === 'queued') return c.gray(G.queued)
  if (job.status === 'in_progress') return c.cyan(spinFrame)
  if (job.conclusion === 'success') return c.green(G.tick)
  if (job.conclusion === 'failure') return c.red(G.cross)
  if (job.conclusion === 'cancelled' || job.conclusion === 'skipped')
    return c.gray(G.skipped)
  return c.gray(G.queued)
}

function stepIcon(step: WorkflowJob['steps'][0]): string {
  if (step.status === 'queued') return c.gray(G.queued)
  if (step.status === 'in_progress') return c.cyan(nextSpinnerFrame())
  if (step.conclusion === 'success') return c.green(G.tick)
  if (step.conclusion === 'failure') return c.red(G.cross)
  if (step.conclusion === 'skipped') return c.gray(G.skipped)
  return c.gray(G.queued)
}

function jobProgress(job: WorkflowJob): number {
  if (job.status === 'queued') return 0
  if (job.status === 'completed') return 100
  const total = job.steps.length
  if (total === 0) return 50
  const done = job.steps.filter((s) => s.status === 'completed').length
  const inProg = job.steps.filter((s) => s.status === 'in_progress').length
  return Math.round(((done + inProg * 0.5) / total) * 100)
}

function currentStepName(job: WorkflowJob): string {
  const inProg = job.steps.find((s) => s.status === 'in_progress')
  if (inProg) return inProg.name
  const lastDone = [...job.steps].reverse().find((s) => s.status === 'completed')
  if (lastDone && job.status !== 'completed') return lastDone.name
  if (job.status === 'queued') return 'waiting…'
  return 'done'
}

function jobElapsed(job: WorkflowJob): string {
  if (!job.started_at) return ''
  const end = job.completed_at ? new Date(job.completed_at) : new Date()
  const ms = end.getTime() - new Date(job.started_at).getTime()
  return fmtDuration(ms)
}

export function renderDashboard(
  tag: string,
  run: WorkflowRun,
  jobs: WorkflowJob[],
  startMs: number,
  avgDurationMs: number | null,
  spinFrame: string
): string {
  const width = Math.max(70, termWidth() - 1)
  const elapsed = Date.now() - startMs
  const elapsedStr = fmtDuration(elapsed)

  let etaStr = 'estimating…'
  if (avgDurationMs !== null) {
    const remaining = Math.max(0, avgDurationMs - elapsed)
    etaStr = `~${fmtDuration(remaining)}`
  }

  const runUrl = run.html_url
  const header = `  ${c.bold('Release')} ${c.cyan(tag)} ${c.dim('·')} ${c.bold(`run #${run.run_number}`)} ${c.dim('·')} ${c.cyan(elapsedStr + ' elapsed')} ${c.dim('·')} ETA ${c.yellow(etaStr)}`
  const urlLine = `  ${c.dim('Action Run:')} ${link(runUrl, runUrl)}`

  const lines: string[] = [header, urlLine, '']

  // Per-job rows
  let totalSteps = 0
  let doneSteps = 0

  // Dynamically calculate available step name width so steps are never unnecessarily truncated:
  // Layout: "  " (2) + icon (2) + name (14) + " " (1) + bar (20) + " " (1) + pct (4) + "  " (2) = 46 chars
  // Suffix: "  " (2) + elapsed (6) = 8 chars
  const maxStepWidth = Math.max(25, width - 56)

  for (const job of jobs) {
    const icon = jobIcon(job, spinFrame)
    const pct = jobProgress(job)
    const bar = progressBar(pct, 20)
    const pctStr = String(pct).padStart(3) + '%'
    const rawStep = currentStepName(job)
    const stepName = truncate(rawStep, maxStepWidth)
    const elapsed = jobElapsed(job)
    const namePadded = job.name.padEnd(14)

    lines.push(`  ${icon} ${c.bold(namePadded)} ${bar} ${c.dim(pctStr)}  ${c.dim(stepName)}  ${c.gray(elapsed)}`)

    totalSteps += job.steps.length
    doneSteps += job.steps.filter((s) => s.status === 'completed').length
  }

  // Overall bar
  const overallPct = totalSteps === 0 ? 0 : Math.round((doneSteps / totalSteps) * 100)
  const overallBar = progressBar(overallPct, 20)
  lines.push('')
  lines.push(`    ${c.dim('Overall'.padEnd(14))} ${overallBar} ${c.dim(String(overallPct).padStart(3) + '%')}`)

  // Status line
  const allDone = jobs.length > 0 && jobs.every((j) => j.status === 'completed')
  if (!allDone && IS_TTY) {
    lines.push('')
    lines.push(c.dim('  Watching… Ctrl+C to detach (the run continues on GitHub)'))
  }

  return lines.map((l) => truncate(l, width)).join('\n')
}

// ─── Main dashboard ───────────────────────────────────────────────────────────

export async function startDashboard(opts: DashboardOptions): Promise<DashboardResult> {
  const { owner, repo, workflowFile, tag, simulate = false } = opts

  const startMs = Date.now()

  // Restore cursor on Ctrl+C
  let sigintFired = false
  const onSigint = () => {
    sigintFired = true
    logUpdate.clear()
    showCursor()
    console.log('')
    console.log(c.yellow(`  Detached from dashboard. The run continues on GitHub.`))
    console.log(c.dim(`  Check status: npm run status`))
    process.exit(0)
  }
  process.on('SIGINT', onSigint)

  hideCursor()

  let run: WorkflowRun | null = null
  let runId: number | undefined = opts.runId

  // ── Step 1: Find the run ──────────────────────────────────────────────────

  if (!simulate) {
    if (!runId) {
      console.log(c.dim('  Waiting for GitHub to start the workflow run…'))
      const tagSha = await getTagSha(owner, repo, tag).catch(() => null)
      const deadline = Date.now() + 90_000
      while (Date.now() < deadline) {
        let runs: WorkflowRun[] = []
        if (tagSha) {
          runs = await listWorkflowRuns(owner, repo, workflowFile, tagSha).catch(() => [])
        }
        if (runs.length === 0) {
          const branchRuns = await listWorkflowRuns(owner, repo, workflowFile, { branch: tag }).catch(() => [])
          runs = branchRuns.filter((r) => {
            if (tagSha && r.head_sha === tagSha) return true
            // Avoid picking stale completed runs from previous attempts
            return r.status !== 'completed' || (new Date(r.created_at).getTime() > startMs - 60_000)
          })
        }
        if (runs.length > 0) {
          const matched = tagSha ? runs.find((r) => r.head_sha === tagSha) : null
          run = matched || runs[0]
          runId = run.id
          break
        }
        await sleep(3000)
        process.stdout.write('.')
      }
      console.log('')
      if (!run || !runId) {
        showCursor()
        process.removeListener('SIGINT', onSigint)
        throw new Error(
          `Timed out waiting for the workflow run for "${tag}" to appear on GitHub. Check manually: https://github.com/${owner}/${repo}/actions`
        )
      }
    }
  } else {
    run = makeSimulatedRun(tag)
    runId = run.id
  }

  // ── Step 2: Fetch average duration for ETA ──────────────────────────────

  const avgDurationMs = simulate
    ? 240_000
    : await getAverageRunDuration(owner, repo, workflowFile).catch(() => null)

  // ── Step 3: Poll loop ─────────────────────────────────────────────────────

  let lastJobs: WorkflowJob[] = []
  let spinIdx = 0
  const spinFrames = ['◐', '◓', '◑', '◒']

  const POLL_INTERVAL = 3000
  let failedJob: WorkflowJob | null = null

  while (true) {
    if (sigintFired) break

    const spinFrame = IS_TTY ? spinFrames[spinIdx++ % spinFrames.length] : '?'

    if (simulate) {
      run = makeSimulatedRun(tag)
      lastJobs = makeSimulatedJobs(simStep)

      // Auto-advance simulation
      if (simStep < SIM_STEPS.length - 1) simStep++

      const allDone = lastJobs.every((j) => j.status === 'completed')
      if (allDone) {
        if (IS_TTY) logUpdate(renderDashboard(tag, run, lastJobs, startMs, avgDurationMs, spinFrame))
        break
      }
    } else {
      try {
        run = await getWorkflowRun(owner, repo, runId!)
        lastJobs = await getWorkflowJobs(owner, repo, runId!)
      } catch (e) {
        // Rate limit or network error — keep showing old data
      }

      const allDone = lastJobs.every((j) => j.status === 'completed')
      failedJob = lastJobs.find((j) => j.conclusion === 'failure') ?? null

      if (IS_TTY) {
        logUpdate(renderDashboard(tag, run!, lastJobs, startMs, avgDurationMs, spinFrame))
      } else {
        // Non-TTY: print a summary line periodically
        const running = lastJobs.filter((j) => j.status === 'in_progress').map((j) => j.name)
        if (running.length > 0)
          console.log(`[${fmtDuration(Date.now() - startMs)}] Running: ${running.join(', ')}`)
      }

      if (allDone) break
    }

    await sleep(POLL_INTERVAL)
  }

  // Final render
  if (IS_TTY) {
    logUpdate(renderDashboard(tag, run!, lastJobs, startMs, avgDurationMs, G.tick))
    logUpdate.done()
  }
  showCursor()
  process.removeListener('SIGINT', onSigint)

  const durationMs = Date.now() - startMs
  const success = !failedJob && lastJobs.every((j) => j.conclusion !== 'failure')

  // ── Failure handling ──────────────────────────────────────────────────────

  if (failedJob) {
    console.log('')
    console.log(c.red(`  ${G.cross} Job failed: ${failedJob.name}`))
    const failedStep = failedJob.steps.find((s) => s.conclusion === 'failure')
    if (failedStep) console.log(c.dim(`    Failed step: ${failedStep.name}`))

    if (!simulate) {
      console.log(c.dim('  Fetching last 30 lines of job log…'))
      try {
        const log = await getJobLog(owner, repo, failedJob.id)
        const lines = log.split('\n').slice(-30).join('\n')
        console.log(c.dim(lines))
      } catch {}
    }
  }

  return {
    success,
    runUrl: run?.html_url ?? `https://github.com/${owner}/${repo}/actions`,
    runId: runId ?? 0,
    durationMs,
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
