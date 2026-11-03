/**
 * config.ts — Manages persistent local machine configuration (GitHub token).
 * Stored in user's home directory: ~/.jiotv-max-updater.json
 * Never committed to git.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as p from '@clack/prompts'
import { c, G } from './ui.js'

export interface LocalConfig {
  githubToken?: string
  lastUpdated?: string
}

const CONFIG_PATH = path.join(os.homedir(), '.jiotv-max-updater.json')

export function getLocalConfig(): LocalConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
      return JSON.parse(raw)
    }
  } catch {}
  return {}
}

export function saveLocalConfig(cfg: LocalConfig): void {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 })
  } catch (err: any) {
    p.log.warn(`Could not save local config: ${err.message}`)
  }
}

export function getStoredToken(): string | null {
  const cfg = getLocalConfig()
  return cfg.githubToken?.trim() || null
}

export function setStoredToken(token: string): void {
  const cfg = getLocalConfig()
  cfg.githubToken = token.trim()
  cfg.lastUpdated = new Date().toISOString()
  saveLocalConfig(cfg)
}

export function clearStoredToken(): void {
  const cfg = getLocalConfig()
  delete cfg.githubToken
  saveLocalConfig(cfg)
}

export function maskToken(token: string): string {
  if (!token) return 'none'
  if (token.length <= 10) return '***'
  return `${token.slice(0, 7)}…${token.slice(-4)}`
}

export async function validateToken(token: string): Promise<{ valid: boolean; username?: string; error?: string }> {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `token ${token.trim()}`,
        'User-Agent': 'jiotv-max-updater-cli/1.0',
      },
    })
    if (res.ok) {
      const data = (await res.json()) as { login: string }
      return { valid: true, username: data.login }
    }
    if (res.status === 401) {
      return { valid: false, error: 'Invalid or expired GitHub token (401 Unauthorized)' }
    }
    return { valid: false, error: `GitHub API returned ${res.status}: ${res.statusText}` }
  } catch (err: any) {
    return { valid: false, error: err.message }
  }
}

export async function promptConfigureToken(): Promise<void> {
  const currentToken = getStoredToken() || process.env['GITHUB_TOKEN'] || process.env['GH_TOKEN']
  const source = getStoredToken() ? 'Saved locally' : process.env['GITHUB_TOKEN'] ? 'Env GITHUB_TOKEN' : process.env['GH_TOKEN'] ? 'Env GH_TOKEN' : 'None'

  p.intro(c.cyan('GitHub Token Configuration'))

  if (currentToken) {
    p.log.info(`Current Token: ${c.bold(maskToken(currentToken))} (${c.dim(source)})`)
  } else {
    p.log.warn('No GitHub token currently saved or detected.')
  }

  const choice = await p.select({
    message: 'What would you like to do?',
    options: [
      { value: 'set', label: currentToken ? 'Update / Replace Token' : 'Enter GitHub Token' },
      { value: 'test', label: 'Test Current Token Connection' },
      { value: 'clear', label: 'Clear Stored Token' },
      { value: 'back', label: 'Back to Main Menu' },
    ],
  })

  if (p.isCancel(choice) || choice === 'back') return

  if (choice === 'test') {
    if (!currentToken) {
      p.log.error('No token to test. Please save a token first.')
      return
    }
    const sp = p.spinner()
    sp.start('Testing token with GitHub API…')
    const result = await validateToken(currentToken)
    if (result.valid) {
      sp.stop(c.green(`${G.tick} Token is valid! Authenticated as: ${c.bold(result.username!)}`))
    } else {
      sp.stop(c.red(`${G.cross} ${result.error}`))
    }
    return
  }

  if (choice === 'clear') {
    clearStoredToken()
    p.log.success('Stored token cleared from local machine configuration.')
    return
  }

  if (choice === 'set') {
    const input = await p.password({
      message: 'Paste your GitHub Personal Access Token (PAT):',
    })

    if (p.isCancel(input)) {
      p.cancel('Operation cancelled.')
      return
    }

    const token = (input as string).trim()
    if (!token) {
      p.log.error('Token cannot be empty.')
      return
    }

    const sp = p.spinner()
    sp.start('Validating token with GitHub…')
    const result = await validateToken(token)

    if (!result.valid) {
      sp.stop(c.red(`${G.cross} ${result.error}`))
      const saveAnyway = await p.confirm({
        message: 'Token verification failed. Do you want to save it anyway?',
        initialValue: false,
      })
      if (!saveAnyway || p.isCancel(saveAnyway)) return
    } else {
      sp.stop(c.green(`${G.tick} Validated successfully as: ${c.bold(result.username!)}`))
    }

    setStoredToken(token)
    p.log.success(`Token saved locally to ${c.dim(CONFIG_PATH)}`)
  }
}
