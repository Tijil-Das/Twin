/**
 * git.ts — Git operations used during release execution.
 * All operations are reversible; rollback is explicit.
 */

import { execa } from 'execa'
import path from 'node:path'
import fs from 'node:fs'

export interface ReleaseCommitResult {
  sha: string
  tag: string
}

/**
 * Bump version in package.json WITHOUT letting npm create a commit or tag.
 * We manage the commit ourselves to handle the subdirectory case correctly.
 */
export async function bumpPackageJson(
  appDir: string,
  newVersion: string
): Promise<void> {
  const pjPath = path.join(appDir, 'package.json')
  if (fs.existsSync(pjPath)) {
    const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'))
    pj.version = newVersion
    fs.writeFileSync(pjPath, JSON.stringify(pj, null, 2) + '\n', 'utf8')
  }

  // Also bump tauri.conf.json
  const tauriConfPath = path.join(appDir, 'src-tauri', 'tauri.conf.json')
  if (fs.existsSync(tauriConfPath)) {
    try {
      const tc = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'))
      tc.version = newVersion
      fs.writeFileSync(tauriConfPath, JSON.stringify(tc, null, 2) + '\n', 'utf8')
    } catch {}
  }

  // Also bump Cargo.toml
  const cargoPath = path.join(appDir, 'src-tauri', 'Cargo.toml')
  if (fs.existsSync(cargoPath)) {
    try {
      let cargo = fs.readFileSync(cargoPath, 'utf8')
      cargo = cargo.replace(/^version\s*=\s*"[^"]+"/m, `version = "${newVersion}"`)
      fs.writeFileSync(cargoPath, cargo, 'utf8')
    } catch {}
  }
}

/**
 * Stage files, commit, and create an annotated tag.
 * Returns the commit SHA and tag string.
 */
export async function createReleaseCommit(
  gitRoot: string,
  appDir: string,
  newVersion: string,
  releaseNotesPath: string
): Promise<ReleaseCommitResult> {
  const tag = `v${newVersion}`
  const commitMsg = `chore(release): v${newVersion}`

  // Stage package.json in app dir
  const relAppDir = path.relative(gitRoot, appDir).replace(/\\/g, '/')
  await execa('git', ['add', path.join(relAppDir, 'package.json')], { cwd: gitRoot })

  // Stage tauri.conf.json and Cargo.toml if present
  const tauriConf = path.join(relAppDir, 'src-tauri', 'tauri.conf.json')
  if (fs.existsSync(path.join(gitRoot, tauriConf))) {
    await execa('git', ['add', tauriConf], { cwd: gitRoot })
  }
  const cargoToml = path.join(relAppDir, 'src-tauri', 'Cargo.toml')
  if (fs.existsSync(path.join(gitRoot, cargoToml))) {
    await execa('git', ['add', cargoToml], { cwd: gitRoot })
  }

  // Stage pnpm-lock if it changed
  const lockFile = path.join(relAppDir, 'pnpm-lock.yaml')
  if (fs.existsSync(path.join(gitRoot, lockFile))) {
    await execa('git', ['add', lockFile], { cwd: gitRoot })
  }

  // Stage release-notes if it exists
  if (fs.existsSync(releaseNotesPath)) {
    const relNotes = path.relative(gitRoot, releaseNotesPath).replace(/\\/g, '/')
    await execa('git', ['add', relNotes], { cwd: gitRoot })
  }

  // Commit (supports --allow-empty if package.json was already at newVersion)
  const { stdout: stagedDiff } = await execa('git', ['diff', '--cached'], { cwd: gitRoot })
  if (stagedDiff.trim().length > 0) {
    await execa('git', ['commit', '-m', commitMsg], { cwd: gitRoot })
  } else {
    await execa('git', ['commit', '--allow-empty', '-m', commitMsg], { cwd: gitRoot })
  }

  // Get SHA
  const { stdout: sha } = await execa('git', ['rev-parse', 'HEAD'], { cwd: gitRoot })

  // Annotated tag
  await execa('git', ['tag', '-a', tag, '-m', `Release ${tag}`], { cwd: gitRoot })

  return { sha: sha.trim(), tag }
}

/** Push branch and tag to origin. Throws on failure (caller handles rollback). */
export async function pushRelease(
  gitRoot: string,
  branch: string,
  tag: string
): Promise<void> {
  await execa('git', ['push', 'origin', branch], { cwd: gitRoot })
  await execa('git', ['push', 'origin', tag], { cwd: gitRoot })
}

/** Rollback: delete the local tag and reset the last commit. */
export async function rollbackRelease(
  gitRoot: string,
  tag: string
): Promise<string[]> {
  const undone: string[] = []
  try {
    await execa('git', ['tag', '-d', tag], { cwd: gitRoot })
    undone.push(`Deleted local tag ${tag}`)
  } catch {}
  try {
    await execa('git', ['reset', '--soft', 'HEAD~1'], { cwd: gitRoot })
    undone.push('Reset last commit (soft — your changes are still staged)')
  } catch {}
  return undone
}

/** Get the HEAD SHA. */
export async function getHeadSha(gitRoot: string): Promise<string> {
  const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: gitRoot })
  return stdout.trim()
}
