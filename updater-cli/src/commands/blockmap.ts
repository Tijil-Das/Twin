/**
 * blockmap.ts — Ensure differential update blockmap (.blockmap) is published.
 * Usage:
 *   updater-cli blockmap          (checks/syncs latest release)
 *   updater-cli blockmap v1.0.1   (checks/syncs specific release tag)
 */

import * as p from '@clack/prompts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { discoverRepo } from '../lib/repo.js'
import { getLatestRelease, getReleaseByTag, uploadReleaseAsset, deleteReleaseAsset, hasToken, GhRelease } from '../lib/github.js'
import { c, G } from '../lib/ui.js'

export async function ensureReleaseBlockmap(tag?: string): Promise<{ success: boolean; message: string }> {
  let ctx
  try {
    ctx = await discoverRepo()
  } catch (e: any) {
    return { success: false, message: `Could not discover repository: ${e.message}` }
  }

  const sp = p.spinner()
  sp.start(tag ? `Fetching release ${tag}…` : 'Fetching latest release…')

  let release: GhRelease | null = null
  try {
    release = tag
      ? await getReleaseByTag(ctx.owner, ctx.repo, tag)
      : await getLatestRelease(ctx.owner, ctx.repo)
  } catch (e: any) {
    sp.stop(c.red(`Failed: ${e.message}`))
    return { success: false, message: e.message }
  }

  if (!release) {
    sp.stop(c.yellow(`Release ${tag ?? 'latest'} not found on GitHub.`))
    return { success: false, message: 'Release not found' }
  }

  const targetTag = release.tag_name
  const assetNames = release.assets.map((a) => a.name)
  const exeAsset = release.assets.find(
    (a) => a.name.toLowerCase().endsWith('.exe') && !a.name.toLowerCase().includes('uninstaller')
  )

  if (!exeAsset) {
    sp.stop(c.red(`Release ${targetTag} does not contain an .exe installer.`))
    return { success: false, message: 'No installer found in release' }
  }

  const expectedBlockmapName = `${exeAsset.name}.blockmap`
  const hasBlockmap = assetNames.includes(expectedBlockmapName)

  if (hasBlockmap) {
    sp.stop(c.green(`${G.tick} Blockmap ${expectedBlockmapName} is already published on ${targetTag}`))
    return { success: true, message: 'Already published' }
  }

  sp.stop(c.yellow(`Blockmap ${expectedBlockmapName} is missing from release ${targetTag}`))

  if (!hasToken()) {
    p.log.error('GitHub authentication token is required to upload assets. Set GITHUB_TOKEN or authenticate git.')
    return { success: false, message: 'Missing token' }
  }

  const tmpDir = path.join(os.tmpdir(), `jiotv-max-blockmap-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const tmpExe = path.join(tmpDir, exeAsset.name)
  const tmpBlockmap = path.join(tmpDir, expectedBlockmapName)

  const sp2 = p.spinner()
  try {
    sp2.start(`Downloading ${exeAsset.name} (~${Math.round(exeAsset.size / (1024 * 1024))}MB)…`)
    const dlRes = await fetch(exeAsset.browser_download_url)
    if (!dlRes.ok) throw new Error(`Download failed with status ${dlRes.status}`)
    if (!dlRes.body) throw new Error('No response body received')

    await pipeline(Readable.fromWeb(dlRes.body as any), fs.createWriteStream(tmpExe))
    sp2.stop(c.green(`${G.tick} Downloaded ${exeAsset.name}`))

    sp2.start('Generating Rabin chunk blockmap…')
    // Dynamic import from app-builder-lib in workspace
    const blockmapModulePath = path.join(
      ctx.gitRoot,
      'JioTV-Max-Windows',
      'node_modules',
      'app-builder-lib',
      'out',
      'targets',
      'blockmap',
      'blockmap.js'
    )

    let buildBlockMap: any
    if (fs.existsSync(blockmapModulePath)) {
      const mod = await import('file://' + blockmapModulePath.replace(/\\/g, '/'))
      buildBlockMap = mod.buildBlockMap
    } else {
      // Fallback search in .pnpm
      const pnpmDir = path.join(ctx.gitRoot, 'JioTV-Max-Windows', 'node_modules', '.pnpm')
      if (fs.existsSync(pnpmDir)) {
        const entries = fs.readdirSync(pnpmDir)
        const match = entries.find((e) => e.startsWith('app-builder-lib@'))
        if (match) {
          const fallbackPath = path.join(pnpmDir, match, 'node_modules', 'app-builder-lib', 'out', 'targets', 'blockmap', 'blockmap.js')
          if (fs.existsSync(fallbackPath)) {
            const mod = await import('file://' + fallbackPath.replace(/\\/g, '/'))
            buildBlockMap = mod.buildBlockMap
          }
        }
      }
    }

    if (!buildBlockMap) {
      throw new Error('Could not locate buildBlockMap in app-builder-lib dependencies')
    }

    await buildBlockMap(tmpExe, 'gzip', tmpBlockmap)
    const blockmapSize = fs.statSync(tmpBlockmap).size
    sp2.stop(c.green(`${G.tick} Generated ${expectedBlockmapName} (${(blockmapSize / 1024).toFixed(1)} KB)`))

    sp2.start(`Uploading ${expectedBlockmapName} to GitHub release ${targetTag}…`)
    // Delete any existing corrupted/partial asset with this name first to prevent 422 conflicts
    const existingAsset = release.assets.find((a) => a.name === expectedBlockmapName)
    if (existingAsset) {
      try {
        await deleteReleaseAsset(ctx.owner, ctx.repo, existingAsset.id)
      } catch {}
    }
    const blockmapData = fs.readFileSync(tmpBlockmap)
    await uploadReleaseAsset(ctx.owner, ctx.repo, release.id, expectedBlockmapName, blockmapData, 'application/gzip')
    sp2.stop(c.green(`${G.tick} Successfully published ${expectedBlockmapName} to ${targetTag}`))

    return { success: true, message: 'Blockmap uploaded successfully' }
  } catch (err: any) {
    sp2.stop(c.red(`Failed to generate/upload blockmap: ${err.message}`))
    return { success: false, message: err.message }
  } finally {
    try {
      if (fs.existsSync(tmpExe)) fs.unlinkSync(tmpExe)
      if (fs.existsSync(tmpBlockmap)) fs.unlinkSync(tmpBlockmap)
      if (fs.existsSync(tmpDir)) fs.rmdirSync(tmpDir)
    } catch {}
  }
}
