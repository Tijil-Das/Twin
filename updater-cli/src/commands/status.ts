/**
 * status.ts — Print current version, last tag, last release run result.
 */

import * as p from '@clack/prompts'
import boxen from 'boxen'
import { discoverRepo } from '../lib/repo.js'
import { getLatestRelease, listWorkflowRuns, hasToken } from '../lib/github.js'
import { c, G, link, fmtDuration } from '../lib/ui.js'

export async function runStatus(): Promise<void> {
  const sp = p.spinner()
  sp.start('Fetching status…')

  let ctx
  try {
    ctx = await discoverRepo()
  } catch (e: any) {
    sp.stop(c.red(`Failed: ${e.message}`))
    return
  }

  const lines: string[] = [
    `${c.bold('Repo')}            ${ctx.owner}/${ctx.repo}`,
    `${c.bold('Live App (GitHub)')} ${ctx.remotePublishedVersion ? c.cyan('v' + ctx.remotePublishedVersion) : c.dim('none published')}`,
    `${c.bold('Local package.json')} ${c.dim(ctx.localVersion)}${ctx.isRemoteSynced ? c.yellow(' (behind GitHub — auto-synced)') : c.green(' (in sync)')}`,
    `${c.bold('Effective Bump')}  ${c.cyan(ctx.appVersion)}`,
    `${c.bold('Branch')}          ${ctx.branch}`,
    `${c.bold('Last Tag')}        ${ctx.lastTag ?? c.dim('none')}`,
    `${c.bold('Auth')}            ${hasToken() ? c.green('GitHub token found') : c.yellow('No token — configure in main menu')}`,
  ]

  // GitHub release status
  try {
    const release = await getLatestRelease(ctx.owner, ctx.repo)
    if (release) {
      const assetNames = release.assets.map((a) => a.name)
      const hasInstaller = assetNames.some((n) => n.endsWith('.exe'))
      const hasManifest = assetNames.some((n) => n === 'latest.yml')
      const hasBlockmap = assetNames.some((n) => n.endsWith('.blockmap'))

      lines.push('')
      lines.push(
        `${c.bold('Latest release')} ${c.cyan(release.tag_name)} · ` +
        `${release.draft ? c.yellow('DRAFT') : c.green('Published')} · ` +
        `${link('Open', release.html_url)}`
      )
      lines.push(
        `  Assets: ${hasInstaller ? c.green('✓ exe') : c.red('✗ exe')}  ` +
        `${hasManifest ? c.green('✓ latest.yml') : c.red('✗ latest.yml')}  ` +
        `${hasBlockmap ? c.green('✓ .blockmap') : c.yellow('⚠ missing .blockmap (run: updater-cli blockmap)')}`
      )
    }
  } catch {}

  // Latest workflow run
  try {
    const runs = await listWorkflowRuns(ctx.owner, ctx.repo, ctx.workflowPath)
    if (runs.length > 0) {
      const run = runs[0]
      const conclusionIcon =
        run.conclusion === 'success'
          ? c.green(G.tick)
          : run.conclusion === 'failure'
          ? c.red(G.cross)
          : run.status === 'in_progress'
          ? c.cyan('◐')
          : c.gray(G.queued)
      const dur =
        run.created_at && run.updated_at
          ? fmtDuration(new Date(run.updated_at).getTime() - new Date(run.created_at).getTime())
          : ''
      lines.push('')
      lines.push(
        `${c.bold('Last run')}   ${conclusionIcon} #${run.run_number} · ${run.status}${run.conclusion ? '/' + run.conclusion : ''} · ${dur} · ${link('View', run.html_url)}`
      )
    }
  } catch {}

  sp.stop('')

  console.log(
    boxen(lines.join('\n'), {
      padding: { top: 0, bottom: 0, left: 1, right: 2 },
      borderStyle: 'round',
      borderColor: 'cyan',
      title: ' Status ',
      titleAlignment: 'center',
    })
  )
}
