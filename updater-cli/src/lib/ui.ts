/**
 * ui.ts — Terminal rendering utilities.
 * Handles: Unicode/ASCII fallback, NO_COLOR, progress bars, clickable links (OSC-8),
 * non-TTY plain output, narrow-terminal truncation.
 */

import isUnicodeSupported from 'is-unicode-supported'
import stringWidth from 'string-width'
import stripAnsi from 'strip-ansi'
import pc from 'picocolors'

// ─── Environment ─────────────────────────────────────────────────────────────

export const IS_TTY = Boolean(process.stdout.isTTY)
export const UNICODE =
  process.env['TERM'] !== 'dumb' &&
  !Boolean(process.env['NO_UNICODE']) &&
  !process.argv.includes('--no-unicode')
export const NO_COLOR = Boolean(process.env['NO_COLOR']) || process.argv.includes('--no-color')
export const FORCE_COLOR =
  Boolean(process.env['FORCE_COLOR']) || process.argv.includes('--force-color')
export const USE_COLOR = FORCE_COLOR || (!NO_COLOR && IS_TTY)

// ─── Glyphs ──────────────────────────────────────────────────────────────────

export const G = {
  tick: UNICODE ? '✔' : '√',
  cross: UNICODE ? '✖' : '×',
  arrow: UNICODE ? '→' : '->',
  dot: UNICODE ? '·' : '.',
  bar_full: '█',
  bar_empty: '░',
  spinner_frames: ['◐', '◓', '◑', '◒'],
  queued: '○',
  skipped: '⊘',
  bullet: '•',
  dash: '─',
}

// ─── Color helpers ───────────────────────────────────────────────────────────

export const c = {
  green: (s: string) => (USE_COLOR ? pc.green(s) : s),
  red: (s: string) => (USE_COLOR ? pc.red(s) : s),
  yellow: (s: string) => (USE_COLOR ? pc.yellow(s) : s),
  blue: (s: string) => (USE_COLOR ? pc.blue(s) : s),
  cyan: (s: string) => (USE_COLOR ? pc.cyan(s) : s),
  magenta: (s: string) => (USE_COLOR ? pc.magenta(s) : s),
  gray: (s: string) => (USE_COLOR ? pc.gray(s) : s),
  bold: (s: string) => (USE_COLOR ? pc.bold(s) : s),
  dim: (s: string) => (USE_COLOR ? pc.dim(s) : s),
  white: (s: string) => (USE_COLOR ? pc.white(s) : s),
  bgRed: (s: string) => (USE_COLOR ? pc.bgRed(s) : s),
  bgGreen: (s: string) => (USE_COLOR ? pc.bgGreen(s) : s),
  italic: (s: string) => (USE_COLOR ? pc.italic(s) : s),
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

/**
 * Render a sleek, modern progress bar.
 * @param pct   0–100
 * @param width Total width of bar in chars (default 20)
 */
export function progressBar(pct: number, width = 20): string {
  const clamped = Math.min(100, Math.max(0, pct))
  const filled = Math.round((clamped / 100) * width)
  const empty = width - filled

  if (clamped >= 100) {
    return c.green(G.bar_full.repeat(width))
  }

  return c.cyan(G.bar_full.repeat(filled)) + c.dim(c.gray(G.bar_empty.repeat(empty)))
}

// ─── OSC-8 Clickable Links ───────────────────────────────────────────────────

/**
 * Return a clickable terminal link (OSC-8). Falls back to text if terminal doesn't support it.
 */
export function link(text: string, url: string): string {
  if (!IS_TTY) return text === url ? url : `${text} (${url})`
  // OSC-8 hyperlink escape sequence
  return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`
}

// ─── Truncation ───────────────────────────────────────────────────────────────

/**
 * Safely truncate a string to `maxWidth` visible characters without stripping ANSI colors.
 */
export function truncate(str: string, maxWidth: number, ellipsis = '…'): string {
  const raw = stripAnsi(str)
  if (stringWidth(raw) <= maxWidth) return str

  const targetWidth = Math.max(0, maxWidth - stringWidth(ellipsis))
  let currentWidth = 0
  let truncated = ''
  let inEscape = false

  for (let i = 0; i < str.length; i++) {
    const char = str[i]

    if (char === '\u001B') {
      inEscape = true
      truncated += char
      continue
    }

    if (inEscape) {
      truncated += char
      if (char === 'm') inEscape = false
      continue
    }

    const charWidth = stringWidth(char)
    if (currentWidth + charWidth > targetWidth) {
      break
    }

    truncated += char
    currentWidth += charWidth
  }

  return truncated + ellipsis + '\u001B[0m'
}

// ─── Duration formatting ──────────────────────────────────────────────────────

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return `${String(m).padStart(1, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function fmtDurationSec(sec: number): string {
  return fmtDuration(sec * 1000)
}

// ─── Non-TTY plain logger ─────────────────────────────────────────────────────

/** Plain print for non-TTY environments. */
export function plainLog(msg: string): void {
  if (IS_TTY) return
  console.log(stripAnsi(msg))
}

// ─── Cursor management ───────────────────────────────────────────────────────

export function hideCursor(): void {
  if (IS_TTY) process.stdout.write('\u001B[?25l')
}

export function showCursor(): void {
  if (IS_TTY) process.stdout.write('\u001B[?25h')
}

// ─── Terminal width ───────────────────────────────────────────────────────────

export function termWidth(): number {
  return Math.max(40, process.stdout.columns || 80)
}

// ─── Spinner frame ───────────────────────────────────────────────────────────

let _spinnerTick = 0
export function nextSpinnerFrame(): string {
  return G.spinner_frames[_spinnerTick++ % G.spinner_frames.length]
}

// ─── Markdown terminal renderer ───────────────────────────────────────────────

function formatInlineMarkdown(text: string): string {
  // Bold: **text**
  let res = text.replace(/\*\*([^*]+)\*\*/g, (_, p1) => c.bold(p1))
  // Italic: *text*
  res = res.replace(/(^|[^*])\*([^*]+)\*/g, (_, p0, p1) => `${p0}${c.italic(p1)}`)
  // Inline code: `code`
  res = res.replace(/`([^`]+)`/g, (_, p1) => c.cyan(p1))
  // Links: [label](url)
  res = res.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => `${c.bold(label)} (${c.dim(url)})`)
  return res
}

/**
 * Render GitHub-flavored markdown into polished, colored terminal output.
 */
export function renderMarkdown(markdown: string): string {
  if (!markdown?.trim()) return c.dim('  (release notes are empty)')

  const lines = markdown.split(/\r?\n/)
  const output: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    const trimmed = rawLine.trim()

    // Title 1: # Title
    if (/^#\s+(.+)$/.test(rawLine)) {
      const title = rawLine.replace(/^#\s+/, '').trim()
      output.push('')
      output.push(c.bold(c.cyan(`=== ${title} ===`)))
      output.push('')
      continue
    }

    // Title 2: ## Section
    if (/^##\s+(.+)$/.test(rawLine)) {
      const title = rawLine.replace(/^##\s+/, '').trim()
      output.push('')
      output.push(c.bold(c.red(`● ${title}`)))
      continue
    }

    // Title 3: ### Subsection
    if (/^###\s+(.+)$/.test(rawLine)) {
      const title = rawLine.replace(/^###\s+/, '').trim()
      output.push('')
      output.push(c.bold(c.yellow(`  ▸ ${title}`)))
      continue
    }

    // Horizontal divider: --- or *** or ___
    if (/^\s*[-*_]{3,}\s*$/.test(trimmed)) {
      output.push(c.dim('  ' + '─'.repeat(48)))
      continue
    }

    // Blockquote: > text
    if (/^\s*>\s*(.+)$/.test(rawLine)) {
      const m = rawLine.match(/^\s*>\s*(.+)$/)!
      output.push(`  ${c.dim('│')} ${c.italic(formatInlineMarkdown(m[1]))}`)
      continue
    }

    // Bullet with bold key: - **Key**: description
    if (/^\s*[-*]\s+\*\*([^*]+)\*\*:(.*)$/.test(rawLine)) {
      const m = rawLine.match(/^\s*[-*]\s+\*\*([^*]+)\*\*:(.*)$/)!
      const itemTitle = m[1].trim()
      const itemDesc = formatInlineMarkdown(m[2])
      output.push(`    ${c.green(G.bullet)} ${c.bold(c.white(itemTitle))}:${itemDesc}`)
      continue
    }

    // Numbered list: 1. Item
    if (/^\s*(\d+)\.\s+(.+)$/.test(rawLine)) {
      const m = rawLine.match(/^\s*(\d+)\.\s+(.+)$/)!
      output.push(`    ${c.yellow(m[1] + '.')} ${formatInlineMarkdown(m[2])}`)
      continue
    }

    // Standard list item: - Item
    if (/^\s*[-*]\s+(.+)$/.test(rawLine)) {
      const itemText = rawLine.replace(/^\s*[-*]\s+/, '')
      output.push(`    ${c.cyan(G.bullet)} ${formatInlineMarkdown(itemText)}`)
      continue
    }

    // Empty line
    if (!trimmed) {
      if (output.length > 0 && output[output.length - 1] !== '') {
        output.push('')
      }
      continue
    }

    // General text (e.g. footer notes)
    output.push(`  ${formatInlineMarkdown(rawLine)}`)
  }

  return output.join('\n')
}

/**
 * Informs the user of completion or error and waits for user confirmation (Enter key)
 * before terminating the process, preventing command prompt windows from closing abruptly.
 */
export async function waitBeforeExit(code = 0, message?: string): Promise<void> {
  showCursor()
  if (message) {
    if (code === 0) {
      console.log(`\n  ${c.green(G.tick)} ${message}`)
    } else {
      console.log(`\n  ${c.red(G.cross)} ${message}`)
    }
  }

  // If in interactive terminal and not running inside CI / automated test runner
  const isInteractive = Boolean(process.stdin.isTTY && !process.env.CI && !process.env.VITEST)
  if (isInteractive) {
    console.log(c.dim('\n  Operation complete. Press Enter to close this window...'))
    await new Promise<void>((resolve) => {
      try {
        if (process.stdin.isPaused()) {
          process.stdin.resume()
        }
        if (typeof process.stdin.setRawMode === 'function') {
          process.stdin.setRawMode(false)
        }
        process.stdin.setEncoding('utf8')
        const onData = () => {
          process.stdin.removeListener('data', onData)
          resolve()
        }
        process.stdin.once('data', onData)
      } catch {
        resolve()
      }
    })
  }
}

/**
 * Convenience wrapper to announce status, wait for user input, and exit.
 */
export async function exitGracefully(code = 0, message?: string): Promise<void> {
  await waitBeforeExit(code, message)
  process.exit(code)
}
