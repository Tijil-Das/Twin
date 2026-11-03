/**
 * watch.ts — Attach the live dashboard to an existing or latest run.
 * Usage: npm run watch  /  npm run watch -- --run 12345
 */

import * as p from '@clack/prompts'
import { discoverRepo } from '../lib/repo.js'
import { listWorkflowRuns } from '../lib/github.js'
import { startDashboard } from '../lib/dashboard.js'
import { c, G } from '../lib/ui.js'

export async function runWatch(opts: { runId?: number; simulate?: boolean } = {}): Promise<void> {
  const sp = p.spinner()
  sp.start('Discovering repository…')
  let ctx
  try {
    ctx = await discoverRepo()
    sp.stop(`Watching ${c.cyan(ctx.owner + '/' + ctx.repo)}`)
  } catch (e: any) {
    sp.stop(c.red(`Failed: ${e.message}`))
    return
  }

  let runId = opts.runId
  if (!runId && !opts.simulate) {
    const sp2 = p.spinner()
    sp2.start('Finding latest workflow run…')
    const runs = await listWorkflowRuns(ctx.owner, ctx.repo, ctx.workflowPath).catch(() => [])
    if (runs.length === 0) {
      sp2.stop(c.yellow('No workflow runs found.'))
      return
    }
    const latest = runs[0]
    runId = latest.id
    sp2.stop(`Attaching to run #${latest.run_number} (${latest.status})`)
    console.log('')
  }

  const lastTag = ctx.lastTag ?? 'latest'

  try {
    const result = await startDashboard({
      owner: ctx.owner,
      repo: ctx.repo,
      workflowFile: ctx.workflowPath,
      tag: lastTag,
      runId,
      simulate: opts.simulate,
    })
    console.log('')
    if (result.success) {
      p.log.success(`Run completed successfully in ${Math.round(result.durationMs / 1000)}s`)
    } else {
      p.log.error(`Run failed. Open: ${result.runUrl}`)
    }
  } catch (e: any) {
    p.log.error(`Dashboard error: ${e.message}`)
  }
}
