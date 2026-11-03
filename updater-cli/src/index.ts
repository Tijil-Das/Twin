#!/usr/bin/env node
/**
 * index.ts — Centralized CLI updater & release dashboard for JioTv Max.
 * Provides a single unified interactive dashboard hub or non-interactive flag execution.
 */

import { cac } from 'cac'
import * as p from '@clack/prompts'
import figlet from 'figlet'
import gradient from 'gradient-string'
import { c, G, IS_TTY, showCursor, waitBeforeExit } from './lib/ui.js'

// Always restore cursor on unhandled errors
process.on('uncaughtException', async (err: any) => {
  showCursor()
  console.error('\n  Unexpected error:', err?.message ?? err)
  await waitBeforeExit(1, 'CLI encountered an unexpected error.')
  process.exit(1)
})
process.on('unhandledRejection', async (err: any) => {
  showCursor()
  console.error('\n  Unexpected error:', err?.message ?? err)
  await waitBeforeExit(1, 'CLI encountered an unexpected rejection.')
  process.exit(1)
})

async function runCentralHub(): Promise<void> {
  const { runRelease } = await import('./commands/release.js')
  const { runStatus } = await import('./commands/status.js')
  const { promptConfigureToken, maskToken } = await import('./lib/config.js')
  const { getToken, clearTokenCache } = await import('./lib/github.js')

  while (true) {
    if (IS_TTY) console.clear()

    try {
      const text = figlet.textSync('Twin', { font: 'Small' })
      const grad = gradient(['#3b82f6', '#60a5fa'])
      console.log(grad(text))
    } catch {
      console.log('  Twin Desktop')
    }
    console.log(c.dim('  Central Release Hub & Dashboard\n'))

    const activeToken = getToken()
    const tokenDisplay = activeToken
      ? c.green(`${G.tick} Authenticated (${maskToken(activeToken)})`)
      : c.yellow('⚠ No token set — choose "Configure GitHub Token" to save one')

    console.log(`  Auth: ${tokenDisplay}\n`)

    const choice = await p.select<'release' | 'status' | 'token' | 'exit'>({
      message: 'Select an action:',
      options: [
        {
          value: 'release',
          label: '🚀  Start Full Release',
          hint: 'Automated end-to-end: Bump → Push → Live Progress → Delta Blockmap → Verify',
        },
        {
          value: 'status',
          label: '📊  View Release Status',
          hint: 'Current version, published release assets, and update health',
        },
        {
          value: 'token',
          label: '🔑  Configure GitHub Token',
          hint: 'Save, test, change, or remove persistent local token',
        },
        { value: 'exit', label: '🚪  Exit' },
      ],
    })

    if (p.isCancel(choice) || choice === 'exit') {
      p.outro(c.dim('Goodbye!'))
      await waitBeforeExit(0, 'Updater CLI closed.')
      process.exit(0)
    }

    if (choice === 'release') {
      const success = await runRelease({ noBanner: true })
      console.log('')
      if (success) {
        p.log.success('Release workflow completed.')
      } else {
        p.log.warn('Release process finished with warnings or cancellation.')
      }
      const back = await p.confirm({ message: 'Return to main menu?', initialValue: true })
      if (!back || p.isCancel(back)) {
        p.outro(c.dim('Goodbye!'))
        await waitBeforeExit(0, 'Release process finished.')
        process.exit(0)
      }
    } else if (choice === 'status') {
      await runStatus()
      const back = await p.confirm({ message: 'Return to main menu?', initialValue: true })
      if (!back || p.isCancel(back)) {
        p.outro(c.dim('Goodbye!'))
        await waitBeforeExit(0, 'Status check finished.')
        process.exit(0)
      }
    } else if (choice === 'token') {
      await promptConfigureToken()
      clearTokenCache()
      const back = await p.confirm({ message: 'Return to main menu?', initialValue: true })
      if (!back || p.isCancel(back)) {
        p.outro(c.dim('Goodbye!'))
        await waitBeforeExit(0, 'Configuration finished.')
        process.exit(0)
      }
    }
  }
}

const cli = cac('updater-cli')

// ─── Default command ──────────────────────────────────────────────────────────

cli
  .command('', 'Interactive release wizard or central dashboard hub')
  .option('--bump <type>', 'Version bump: patch | minor | major | prerelease | <semver>')
  .option('--platforms <list>', 'Platforms (info only; workflow is Windows-only)')
  .option('--yes', 'Skip confirmation prompts')
  .option('--dry-run', 'Print all actions without executing')
  .option('--no-banner', 'Skip the ASCII banner')
  .option('--simulate', 'Simulate a fake GitHub Actions run (for demo/testing)')
  .option('--verbose', 'Show full stack traces on errors')
  .action(async (opts) => {
    const isDirectRun = Boolean(
      opts.bump ||
      opts.yes ||
      opts.dryRun ||
      opts['dry-run'] ||
      opts.simulate ||
      opts.platforms
    )

    if (isDirectRun) {
      const { runRelease } = await import('./commands/release.js')
      const success = await runRelease({
        bump: opts.bump,
        platforms: opts.platforms,
        yes: opts.yes,
        dryRun: Boolean(opts.dryRun ?? opts['dry-run']),
        noBanner: Boolean(opts.banner === false || opts.noBanner || opts['no-banner']),
        simulate: opts.simulate,
        verbose: opts.verbose,
      })
      await waitBeforeExit(
        success ? 0 : 1,
        success ? 'Release process completed.' : 'Release process ended with errors.'
      )
      return
    }

    // Default interactive mode: open the central dashboard hub
    await runCentralHub()
  })

// ─── Shortcut commands (also available directly) ──────────────────────────────

cli
  .command('watch', 'Attach live dashboard to the latest (or given) workflow run')
  .option('--run <id>', 'Attach to a specific run ID')
  .option('--simulate', 'Simulate a fake run (demo)')
  .action(async (opts) => {
    const { runWatch } = await import('./commands/watch.js')
    await runWatch({ runId: opts.run ? parseInt(opts.run, 10) : undefined, simulate: opts.simulate })
    await waitBeforeExit(0, 'Watch monitoring finished.')
  })

cli
  .command('status', 'Show current version, last release, and last run status')
  .action(async () => {
    const { runStatus } = await import('./commands/status.js')
    await runStatus()
    await waitBeforeExit(0, 'Status check finished.')
  })

cli
  .command('blockmap [tag]', 'Check and auto-generate/upload missing differential update blockmap')
  .action(async (tag?: string) => {
    const { ensureReleaseBlockmap } = await import('./commands/blockmap.js')
    const result = await ensureReleaseBlockmap(tag)
    if (!result.success) {
      await waitBeforeExit(1, `Blockmap generation failed: ${result.message}`)
      process.exit(1)
    }
    await waitBeforeExit(0, 'Blockmap check finished.')
  })

cli
  .command('token', 'Configure or change the stored GitHub token')
  .action(async () => {
    const { promptConfigureToken } = await import('./lib/config.js')
    await promptConfigureToken()
    await waitBeforeExit(0, 'Configuration finished.')
  })

cli.help()
cli.version('1.0.0')

try {
  cli.parse(process.argv, { run: false })
  await cli.runMatchedCommand()
} catch (err: any) {
  showCursor()
  p.log.error(err.message)
  if (process.argv.includes('--verbose')) console.error(err)
  await waitBeforeExit(1, 'Command execution failed.')
  process.exit(1)
}
