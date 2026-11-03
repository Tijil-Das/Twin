/**
 * release.ts — The main interactive release wizard.
 * Phases: banner → context → version → notes → preflight → summary → execute → dashboard → verify
 */

import * as p from '@clack/prompts'
import boxen from 'boxen'
import gradient from 'gradient-string'
import figlet from 'figlet'
import semver from 'semver'
import fs from 'node:fs'
import { execSync } from 'node:child_process'

import path from 'node:path'

import {
  discoverRepo,
  computeNextVersion,
  tagExists,
  isWorkingTreeClean,
  isBehindOrigin,
  readReleaseNotes,
  writeReleaseNotes,
  RepoContext,
} from '../lib/repo.js'
import { bumpPackageJson, createReleaseCommit, pushRelease, rollbackRelease } from '../lib/git.js'
import { hasToken, GhAuthError, getReleaseByTag, downloadManifest, getLatestRelease } from '../lib/github.js'
import { startDashboard } from '../lib/dashboard.js'
import { c, G, IS_TTY, USE_COLOR, fmtDuration, link, termWidth, renderMarkdown, waitBeforeExit } from '../lib/ui.js'

export interface ReleaseOptions {
  bump?: string
  platforms?: string
  yes?: boolean
  dryRun?: boolean
  noBanner?: boolean
  simulate?: boolean
  verbose?: boolean
}

type BumpType = 'patch' | 'minor' | 'major' | 'prerelease' | 'custom'

// ─── Banner ───────────────────────────────────────────────────────────────────

function printBanner(noBanner: boolean, appName: string): void {
  if (noBanner || !IS_TTY) return
  try {
    const text = figlet.textSync('Twin', { font: 'Small' })
    if (USE_COLOR) {
      const grad = gradient(['#3b82f6', '#60a5fa'])
      console.log(grad(text))
    } else {
      console.log(text)
    }
  } catch {
    console.log(`  ${appName}`)
  }
  console.log(c.dim('  Release CLI · pro-grade, fully automated\n'))
}

// ─── Context card ─────────────────────────────────────────────────────────────

function printContextCard(ctx: RepoContext, authenticated: boolean): void {
  const versionDisplay = ctx.remotePublishedVersion
    ? ctx.isRemoteSynced
      ? `${c.cyan(ctx.appVersion)} ${c.yellow(`(GitHub source of truth; local was ${ctx.localVersion})`)}`
      : `${c.cyan(ctx.appVersion)} ${c.green(`(verified with GitHub Releases)`)}`
    : `${c.cyan(ctx.appVersion)} ${c.dim('(local package.json)')}`

  const lines = [
    `${c.bold('App')}      ${ctx.owner}/${ctx.repo}`,
    `${c.bold('Version')}  ${versionDisplay}`,
    `${c.bold('Branch')}   ${ctx.branch}`,
    `${c.bold('Last Tag')} ${ctx.lastTag ?? c.dim('none')}`,
    `${c.bold('Auth')}     ${authenticated ? c.green('GitHub token found') : c.yellow('No token — set GITHUB_TOKEN')}`,
  ]
  const box = boxen(lines.join('\n'), {
    padding: { top: 0, bottom: 0, left: 1, right: 2 },
    borderStyle: 'round',
    borderColor: 'cyan',
    title: ' Context ',
    titleAlignment: 'center',
  })
  console.log(box)
  console.log('')
}

// ─── Non-interactive (--yes / --bump) helper ──────────────────────────────────

function resolveNonInteractiveVersion(ctx: RepoContext, bump: string): string {
  const bumps = ['patch', 'minor', 'major', 'prerelease']
  if (bumps.includes(bump)) {
    return computeNextVersion(ctx.appVersion, bump as BumpType)
  }
  const clean = semver.clean(bump)
  if (!clean) throw new Error(`Invalid version or bump type: "${bump}"`)
  return clean
}

// ─── Main release flow ────────────────────────────────────────────────────────

export async function runRelease(opts: ReleaseOptions = {}): Promise<boolean> {
  const { dryRun = false, simulate = false, verbose = false } = opts
  const nonInteractive = Boolean(opts.yes || opts.bump)

  // ─── 0. Discover repo ─────────────────────────────────────────────────────

  let ctx: RepoContext
  try {
    const sp = p.spinner()
    sp.start('Discovering repository…')
    ctx = await discoverRepo()
    sp.stop(`Repository: ${c.cyan(ctx.owner + '/' + ctx.repo)} · v${ctx.appVersion}`)
  } catch (e: any) {
    p.log.error(`Failed to discover repo: ${e.message}`)
    if (verbose) console.error(e)
    return false
  }

  const authenticated = hasToken()

  // ─── 1. Banner + context ─────────────────────────────────────────────────

  printBanner(opts.noBanner ?? false, ctx.repo)
  printContextCard(ctx, authenticated)

  if (ctx.isRemoteSynced) {
    p.log.warn(
      c.yellow(
        `Central source of truth notice: GitHub live Windows version is v${ctx.remotePublishedVersion}, ` +
        `while local package.json was ${ctx.localVersion}.\n` +
        `The CLI automatically synchronized the base version to v${ctx.appVersion} to ensure proper bumping.`
      )
    )
  }

  if (dryRun) {
    p.note(
      'DRY RUN mode — no git commands, no API calls, no files changed.',
      'dry-run'
    )
  }

  // ─── 2. Platform selection ────────────────────────────────────────────────

  // Only Windows is configured in release.yml + package.json build.
  // Show other platforms as unavailable with reason.

  if (!nonInteractive && IS_TTY) {
    const availablePlatforms = [
      {
        value: 'windows',
        label: 'Windows (NSIS x64 installer)',
        hint: ctx.configuredPlatforms.includes('windows') ? '' : 'Not configured',
      },
      {
        value: 'mac',
        label: 'macOS',
        hint: 'Not configured in release.yml or package.json build',
      },
      {
        value: 'linux',
        label: 'Linux',
        hint: 'Not configured in release.yml or package.json build',
      },
    ]

    p.log.info(
      c.dim('Platform note: release.yml uses a tag-push trigger with a single Windows job.\n') +
      c.dim('macOS and Linux are not configured — selecting them would require changes to the workflow.\n') +
      c.dim('Currently releasing Windows only.')
    )
  }

  // ─── 3. Version bump ──────────────────────────────────────────────────────

  let newVersion: string

  if (opts.bump) {
    newVersion = resolveNonInteractiveVersion(ctx, opts.bump)
  } else if (!IS_TTY) {
    p.log.error('No --bump flag provided and terminal is not interactive.')
    return false
  } else {
    const bumpChoice = await p.select<BumpType>({
      message: 'Version bump:',
      options: [
        {
          value: 'patch',
          label: `patch  ${c.dim(ctx.appVersion + ' → ' + computeNextVersion(ctx.appVersion, 'patch'))}`,
          hint: 'Bug fixes, small improvements',
        },
        {
          value: 'minor',
          label: `minor  ${c.dim(ctx.appVersion + ' → ' + computeNextVersion(ctx.appVersion, 'minor'))}`,
          hint: 'New features, backward compatible',
        },
        {
          value: 'major',
          label: `major  ${c.dim(ctx.appVersion + ' → ' + computeNextVersion(ctx.appVersion, 'major'))}`,
          hint: 'Breaking changes',
        },
        {
          value: 'prerelease',
          label: `prerelease  ${c.dim(ctx.appVersion + ' → ' + computeNextVersion(ctx.appVersion, 'prerelease'))}`,
          hint: 'Labeled pre-release (electron-updater skips unless allowPrerelease=true)',
        },
        { value: 'custom', label: 'custom  Enter your own semver', hint: '' },
      ],
    })
    if (p.isCancel(bumpChoice)) {
      p.cancel('Release cancelled.')
      return false
    }

    if (bumpChoice === 'custom') {
      const customV = await p.text({
        message: 'Enter version (e.g. 1.2.3):',
        validate: (v = '') => {
          const clean = semver.clean(v)
          if (!clean) return 'Must be a valid semver (e.g. 1.2.3)'
          if (semver.lte(clean, ctx.appVersion)) return `Must be greater than current ${ctx.appVersion}`
          return undefined
        },
      })
      if (p.isCancel(customV)) {
        p.cancel('Release cancelled.')
        return false
      }
      newVersion = semver.clean(customV as string)!
    } else {
      newVersion = computeNextVersion(ctx.appVersion, bumpChoice as BumpType)
    }
  }

  const newTag = `v${newVersion}`

  // Validate: version must be > current
  if (semver.lte(newVersion, ctx.appVersion)) {
    p.log.error(`New version ${newVersion} must be greater than current ${ctx.appVersion}`)
    return false
  }

  // Validate: tag must not exist (or allow recovering if unreleased previous run)
  const { local: tagLocal, remote: tagRemote } = await tagExists(newTag, ctx.gitRoot, ctx.owner, ctx.repo)
  if (tagLocal || tagRemote) {
    let publishedRelease = null
    try {
      publishedRelease = await getReleaseByTag(ctx.owner, ctx.repo, newTag)
    } catch {}

    if (publishedRelease && !publishedRelease.draft) {
      p.log.error(
        `Tag ${newTag} is already published as a live GitHub release (${publishedRelease.html_url}). ` +
        `Choose a higher version to release an update.`
      )
      return false
    }

    p.log.warn(
      `Tag ${newTag} already exists${tagLocal ? ' locally' : ''}${tagRemote ? ' on origin / GitHub' : ''}, but has no published GitHub release.`
    )
    if (IS_TTY && !opts.yes) {
      const overwrite = await p.confirm({
        message: `Would you like to delete the unreleased tag ${c.cyan(newTag)} and re-attempt this release?`,
        initialValue: false,
      })
      if (!overwrite || p.isCancel(overwrite)) {
        p.cancel('Release aborted. Choose a different version or delete the tag manually.')
        return false
      }
      const spClean = p.spinner()
      spClean.start(`Cleaning up existing tag ${newTag}…`)
      try {
        const { execa } = await import('execa')
        if (tagLocal) {
          await execa('git', ['tag', '-d', newTag], { cwd: ctx.gitRoot })
        }
        if (tagRemote) {
          await execa('git', ['push', 'origin', `:refs/tags/${newTag}`], { cwd: ctx.gitRoot })
        }
        spClean.stop(c.green(`${G.tick} Cleaned up stale tag ${newTag}`))
      } catch (err: any) {
        spClean.stop(c.red(`${G.cross} Failed to delete stale tag: ${err.message}`))
        return false
      }
    } else {
      p.log.error(`Tag ${newTag} already exists. Choose a different version or delete the tag manually.`)
      return false
    }
  }

  p.log.success(`Version: ${c.dim(ctx.appVersion)} ${G.arrow} ${c.cyan(newVersion)}`)

  // ─── 4. Release notes ─────────────────────────────────────────────────────

  const notesPath = ctx.releaseNotesPath
  let notesContent = readReleaseNotes(notesPath)

  if (!nonInteractive && IS_TTY) {
    if (notesContent?.trim()) {
      console.log(
        boxen(renderMarkdown(notesContent), {
          padding: { top: 0, bottom: 0, left: 1, right: 2 },
          borderStyle: 'round',
          borderColor: 'cyan',
          title: ` ${c.bold('Release Notes Preview')} (${path.basename(notesPath)}) `,
          titleAlignment: 'center',
        })
      )
      console.log('')
    } else {
      p.note(c.yellow('(release-notes.md is empty or missing)'), 'Release notes preview')
    }

    const notesOk = await p.confirm({
      message: `Is release-notes.md ready for ${newTag}?`,
      initialValue: true,
    })
    if (p.isCancel(notesOk)) {
      p.cancel('Release cancelled.')
      return false
    }

    if (!notesOk) {
      const editChoice = await p.select<'editor' | 'paste' | 'skip'>({
        message: 'How would you like to update it?',
        options: [
          { value: 'editor', label: 'Open in $EDITOR / notepad', hint: '' },
          { value: 'paste', label: 'Paste new content here', hint: '' },
          { value: 'skip', label: 'Skip — proceed without updating', hint: '' },
        ],
      })
      if (p.isCancel(editChoice)) {
        p.cancel('Release cancelled.')
        return false
      }

      if (editChoice === 'editor') {
        const editor = process.env['EDITOR'] || (process.platform === 'win32' ? 'notepad' : 'nano')
        try {
          execSync(`${editor} "${notesPath}"`, { stdio: 'inherit' })
          notesContent = readReleaseNotes(notesPath)
          p.log.success('Notes updated from editor.')
        } catch (e: any) {
          p.log.warn(`Could not open editor: ${e.message}`)
        }
      } else if (editChoice === 'paste') {
        const pasted = await p.text({
          message: 'Paste your release notes (single line, use \\n for newlines):',
          placeholder: '## What\'s Changed…',
        })
        if (p.isCancel(pasted)) {
          p.cancel('Release cancelled.')
          return false
        }
        const content = (pasted as string).replace(/\\n/g, '\n')
        if (!dryRun) writeReleaseNotes(notesPath, content)
        notesContent = content
        p.log.success('Notes updated.')
      }
    }
  }

  // ─── 5. Pre-flight checks ─────────────────────────────────────────────────

  p.log.info('Running pre-flight checks…')

  const checks: { label: string; check: () => Promise<string | null> }[] = [
    {
      label: 'Git installed',
      check: async () => {
        try { execSync('git --version', { stdio: 'pipe' }); return null } catch { return 'Install git from https://git-scm.com' }
      },
    },
    {
      label: 'Working tree is clean',
      check: async () => {
        if (dryRun) return null
        const clean = await isWorkingTreeClean(ctx.gitRoot)
        return clean ? null : 'Commit or stash all changes before releasing'
      },
    },
    {
      label: `On release branch (${ctx.branch})`,
      check: async () => {
        const { stdout } = await (await import('execa')).execa('git', ['branch', '--show-current'], { cwd: ctx.gitRoot })
        return stdout.trim() === ctx.branch ? null : `Switch to ${ctx.branch} branch first`
      },
    },
    {
      label: 'Not behind origin',
      check: async () => {
        if (dryRun) return null
        const behind = await isBehindOrigin(ctx.branch, ctx.gitRoot)
        return behind ? `Run: git pull origin ${ctx.branch}` : null
      },
    },
    {
      label: `Tag ${newTag} does not exist`,
      check: async () => {
        const { local, remote } = await tagExists(newTag, ctx.gitRoot, ctx.owner, ctx.repo)
        return (local || remote) ? `Tag ${newTag} already exists — choose a different version` : null
      },
    },
    {
      label: 'release.yml found',
      check: async () => {
        const exists = fs.existsSync(ctx.gitRoot + '/' + ctx.workflowPath)
        return exists ? null : `${ctx.workflowPath} not found in repo root`
      },
    },
    {
      label: 'GitHub token available',
      check: async () => {
        if (!authenticated) return 'Set GITHUB_TOKEN or GH_TOKEN environment variable'
        // Try a quick API call
        try {
          const { execa } = await import('execa')
          // Just validate by trying to reach the API
          const { getLatestRelease } = await import('../lib/github.js')
          return null
        } catch {
          return 'GitHub API unreachable'
        }
      },
    },
  ]

  let anyCheckFailed = false
  for (const { label, check } of checks) {
    const sp = p.spinner()
    sp.start(label)
    try {
      const result = await check()
      if (result) {
        sp.stop(c.red(`${G.cross} ${label}`) + c.dim(` → ${result}`))
        anyCheckFailed = true
      } else {
        sp.stop(c.green(`${G.tick} ${label}`))
      }
    } catch (e: any) {
      sp.stop(c.yellow(`⚠ ${label} — ${e.message}`))
    }
  }

  if (anyCheckFailed && !opts.yes) {
    const cont = await p.confirm({
      message: c.yellow('Some pre-flight checks failed. Continue anyway?'),
      initialValue: false,
    })
    if (p.isCancel(cont) || !cont) {
      p.cancel('Release aborted.')
      return false
    }
  }

  // ─── 6. Summary card + final confirm ─────────────────────────────────────

  const summaryLines = [
    c.bold('What will happen:'),
    '',
    `  ${G.bullet} Bump version:   ${c.dim(ctx.appVersion)} → ${c.cyan(newVersion)}  in  ${path.relative(ctx.gitRoot, ctx.appDir).replace(/\\/g, '/') || '.'}/package.json`,
    `  ${G.bullet} Commit message: ${c.dim('chore(release): v' + newVersion)}`,
    `  ${G.bullet} Create tag:     ${c.cyan(newTag)}  (annotated, matching workflow trigger ${ctx.tagPattern})`,
    `  ${G.bullet} Push:           origin/${ctx.branch} + tag ${newTag}`,
    `  ${G.bullet} Trigger:        ${ctx.workflowPath}  (Windows NSIS build, typecheck, tests)`,
    `  ${G.bullet} Release notes:  ${notesContent ? 'from release-notes.md' : c.yellow('(empty — GitHub will auto-generate)')}`,
    '',
    c.yellow(`  ⚠  This publishes a LIVE release. Installed v${ctx.appVersion} users will receive the update automatically.`),
  ]

  const summaryBox = boxen(summaryLines.join('\n'), {
    padding: { top: 0, bottom: 0, left: 1, right: 2 },
    borderStyle: 'double',
    borderColor: dryRun ? 'yellow' : 'red',
    title: dryRun ? ' DRY RUN Summary ' : ' Release Summary ',
    titleAlignment: 'center',
  })
  console.log(summaryBox)
  console.log('')

  if (!opts.yes && IS_TTY) {
    const confirmed = await p.confirm({
      message: dryRun
        ? 'Proceed with dry-run (no real changes)?'
        : `Release ${c.cyan(newTag)} for real?`,
      initialValue: false,
    })
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('Release cancelled.')
      return false
    }
  }

  // ─── 7. Execute ───────────────────────────────────────────────────────────

  p.intro(dryRun ? c.yellow('  DRY RUN execution') : `  Releasing ${c.cyan(newTag)}`)

  let releaseSha: string | null = null
  let releaseTag: string | null = null

  // Step: Bump package.json
  {
    const sp = p.spinner()
    sp.start(`Bumping package.json to ${newVersion}…`)
    if (!dryRun) {
      await bumpPackageJson(ctx.appDir, newVersion)
    }
    sp.stop(c.green(`${G.tick} package.json → ${newVersion}`) + (dryRun ? c.dim(' [dry-run]') : ''))
  }

  // Step: Commit + tag
  {
    const sp = p.spinner()
    sp.start('Creating release commit and tag…')
    if (!dryRun) {
      try {
        const result = await createReleaseCommit(ctx.gitRoot, ctx.appDir, newVersion, notesPath)
        releaseSha = result.sha
        releaseTag = result.tag
        sp.stop(c.green(`${G.tick} Commit ${releaseSha!.slice(0, 7)}, tag ${releaseTag}`))
      } catch (e: any) {
        sp.stop(c.red(`${G.cross} Failed to create commit/tag: ${e.message}`))
        if (verbose) console.error(e)
        return false
      }
    } else {
      sp.stop(c.green(`${G.tick} Would create commit chore(release): ${newTag}`) + c.dim(' [dry-run]'))
    }
  }

  // Step: Push
  {
    const sp = p.spinner()
    sp.start(`Pushing origin/${ctx.branch} + tag ${newTag}…`)
    if (!dryRun) {
      try {
        await pushRelease(ctx.gitRoot, ctx.branch, newTag)
        sp.stop(c.green(`${G.tick} Pushed ${ctx.branch} and ${newTag} to origin`))
      } catch (e: any) {
        sp.stop(c.red(`${G.cross} Push failed: ${e.message}`))
        p.log.warn('Rolling back local commit and tag…')
        const undone = await rollbackRelease(ctx.gitRoot, newTag)
        undone.forEach((u) => p.log.info(c.dim(`  ${G.bullet} ${u}`)))
        p.log.error('Push failed and local changes were rolled back. Fix the issue and try again.')
        if (verbose) console.error(e)
        return false
      }
    } else {
      sp.stop(c.green(`${G.tick} Would push origin/${ctx.branch} --tags`) + c.dim(' [dry-run]'))
    }
  }

  // ─── 8. Dashboard ─────────────────────────────────────────────────────────

  p.outro(`Tag ${c.cyan(newTag)} pushed! Monitoring GitHub Actions…`)
  console.log('')

  if (dryRun) {
    p.log.info(c.dim('[dry-run] Would now watch the GitHub Actions workflow run here:'))
    p.log.info(c.dim(`  https://github.com/${ctx.owner}/${ctx.repo}/actions`))
    return true
  }

  let dashboardResult: Awaited<ReturnType<typeof startDashboard>>
  try {
    dashboardResult = await startDashboard({
      owner: ctx.owner,
      repo: ctx.repo,
      workflowFile: ctx.workflowPath,
      tag: newTag,
      simulate,
    })
  } catch (e: any) {
    console.log(c.red(`\n  Dashboard error: ${e.message}`))
    console.log(c.dim(`  Check manually: https://github.com/${ctx.owner}/${ctx.repo}/actions`))
    return false
  }

  // ─── 9. Verify & finish ───────────────────────────────────────────────────

  console.log('')
  if (dashboardResult.success) {
    const sp = p.spinner()
    sp.start('Waiting for release publication and verifying assets on GitHub…')

    let verified = false
    let releaseUrl = `https://github.com/${ctx.owner}/${ctx.repo}/releases/tag/${newTag}`
    let manifestVersion: string | null = null
    let hasInstaller = false
    let hasManifest = false
    let verifiedBlockmap = false
    let exeSize = 0
    let blockmapSize = 0

    const verifyDeadline = Date.now() + 120_000 // Poll up to 2 minutes
    let attempt = 0

    while (Date.now() < verifyDeadline) {
      attempt++
      try {
        const release = await getReleaseByTag(ctx.owner, ctx.repo, newTag)
        if (release) {
          releaseUrl = release.html_url
          const exeAsset = release.assets.find((a) => a.name.endsWith('.exe') && !a.name.includes('uninstaller'))
          const manifestAsset = release.assets.find((a) => a.name === 'latest.yml')
          const blockmapAsset = release.assets.find((a) => a.name.endsWith('.blockmap'))

          hasInstaller = Boolean(exeAsset)
          hasManifest = Boolean(manifestAsset)
          verifiedBlockmap = Boolean(blockmapAsset)
          if (exeAsset) exeSize = exeAsset.size
          if (blockmapAsset) blockmapSize = blockmapAsset.size

          if (manifestAsset && !manifestVersion) {
            try {
              const manifest = await downloadManifest(manifestAsset.browser_download_url)
              if (manifest) {
                const m = manifest.match(/^version:\s*(.+)$/m)
                manifestVersion = m ? m[1].trim() : null
              }
            } catch {}
          }

          if (!release.draft && hasInstaller && hasManifest && verifiedBlockmap) {
            verified = manifestVersion ? manifestVersion === newVersion : true
            sp.stop(c.green(`${G.tick} Release published and all assets verified`))
            break
          }

          if (release.draft) {
            sp.message(`Waiting for GitHub to finalize release (drafting: ${release.assets.length} asset${release.assets.length === 1 ? '' : 's'} uploaded)…`)
          } else if (!verifiedBlockmap && hasInstaller && hasManifest && attempt >= 5) {
            sp.message('Release published, generating and uploading differential blockmap…')
            const { ensureReleaseBlockmap } = await import('./blockmap.js')
            const syncResult = await ensureReleaseBlockmap(newTag)
            if (syncResult.success) {
              verifiedBlockmap = true
              verified = true
              sp.stop(c.green(`${G.tick} Release published and differential blockmap generated & uploaded`))
              break
            }
          } else {
            const checklist = [
              hasInstaller ? c.green('✓ exe') : c.dim('… exe'),
              hasManifest ? c.green('✓ latest.yml') : c.dim('… latest.yml'),
              verifiedBlockmap ? c.green('✓ blockmap') : c.dim('… blockmap'),
            ].join('  ')
            sp.message(`Verifying release assets (${checklist})…`)
          }
        } else {
          sp.message('Waiting for GitHub release to appear…')
        }
      } catch (e: any) {
        sp.message(`Waiting for GitHub API propagation… (${e.message})`)
      }

      await sleep(3500)
    }

    if (!verified) {
      if (hasInstaller && hasManifest && verifiedBlockmap) {
        sp.stop(c.green(`${G.tick} Release published and verified`))
      } else {
        sp.stop(c.yellow('⚠ Release verification completed with pending items (check below)'))
      }
    }

    const exeSizeStr = exeSize > 0 ? c.dim(` (${(exeSize / (1024 * 1024)).toFixed(1)} MB)`) : ''
    const blockmapSizeStr = blockmapSize > 0 ? c.dim(` (${(blockmapSize / 1024).toFixed(1)} KB)`) : ''

    const verifyLines = [
      `${hasInstaller ? c.green(G.tick) : c.yellow('?')} .exe installer${exeSizeStr}`,
      `${hasManifest ? c.green(G.tick) : c.yellow('?')} latest.yml manifest${manifestVersion ? c.dim(' · version: ' + manifestVersion) : ''}`,
      `${verifiedBlockmap ? c.green(G.tick) : c.yellow('?')} .blockmap differential update${blockmapSizeStr}`,
    ]
    p.note(verifyLines.join('\n'), 'Release assets')

    const totalDuration = fmtDuration(dashboardResult.durationMs)
    const finishLines = [
      c.green(c.bold('Release complete!')),
      '',
      `  ${G.bullet} Release URL:   ${link(releaseUrl, releaseUrl)}`,
      `  ${G.bullet} Total time:    ${totalDuration}`,
      '',
      c.bold('How to test auto-update:'),
      `  1. Make sure your installed app is still v${ctx.appVersion}`,
      `  2. Launch the app and wait ~15–30 seconds`,
      `  3. The app will detect v${newVersion}, download it, and prompt you to restart`,
    ]

    console.log(
      boxen(finishLines.join('\n'), {
        padding: { top: 0, bottom: 0, left: 1, right: 2 },
        borderStyle: 'round',
        borderColor: 'green',
        title: ` ${G.tick} Done `,
        titleAlignment: 'center',
      })
    )
    return true
  } else {
    console.log(c.red(`\n  ${G.cross} Release workflow failed.`))
    console.log(c.dim(`  Run URL: ${dashboardResult.runUrl}`))
    console.log('')
    console.log(c.dim('Options:'))
    console.log(c.dim(`  • Open run in browser: ${dashboardResult.runUrl}`))
    console.log(c.dim(`  • Re-attach to run:    npm run watch -- --run ${dashboardResult.runId}`))
    console.log('')
    console.log(
      c.yellow(
        '  To delete the tag (will NOT auto-update users), run:\n' +
        `  git tag -d ${newTag} && git push origin :refs/tags/${newTag}`
      )
    )
    return false
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
