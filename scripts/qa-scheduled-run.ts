#!/usr/bin/env npx tsx
/**
 * Scheduled QA Runner — Runs every 2-3 days
 *
 * This script:
 * 1. Runs all local checks (typecheck, lint, unit tests)
 * 2. Captures baseline metrics
 * 3. Compares against previous run
 * 4. Updates QA-COMPARISON-LOG.md with findings
 * 5. Reports regressions (not aspirational)
 */

import fs from 'fs/promises'
import path from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(__dirname, '..')

interface QARun {
  date: string
  timestamp: number
  metrics: {
    typecheck: 'pass' | 'fail'
    lint: 'pass' | 'fail'
    unitTests: {
      status: 'pass' | 'fail' | 'running'
      passed?: number
      failed?: number
      output?: string
    }
    durationSeconds: number
  }
  regressions: string[]
  newIssues: string[]
}

async function runCommand(cmd: string, label: string): Promise<{ status: 'pass' | 'fail'; output: string }> {
  try {
    console.log(`\n[QA] Running: ${label}...`)
    const output = execSync(cmd, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024, // 10MB
    })
    console.log(`[QA] ✅ ${label} PASSED`)
    return { status: 'pass', output }
  } catch (err: any) {
    console.log(`[QA] ❌ ${label} FAILED`)
    return { status: 'fail', output: err.stdout?.toString() || err.message }
  }
}

async function getTestMetrics(): Promise<{
  passed: number
  failed: number
  status: 'pass' | 'fail'
  output: string
}> {
  try {
    console.log('[QA] Running unit tests (this may take a few minutes)...')
    const output = execSync('npm test 2>&1', {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 20 * 1024 * 1024,
      timeout: 600000, // 10 minutes
    })

    // Parse text output for vitest format
    let passed = 0
    let failed = 0

    const passMatch = output.match(/(\d+) passed/)
    const failMatch = output.match(/(\d+) failed/)
    passed = passMatch ? parseInt(passMatch[1]) : 0
    failed = failMatch ? parseInt(failMatch[1]) : 0

    return { passed, failed, status: failed === 0 ? 'pass' : 'fail', output }
  } catch (err: any) {
    // execSync throws on non-zero exit; parse stderr
    const output = err.stdout?.toString() || err.message
    const passMatch = output.match(/(\d+) passed/)
    const failMatch = output.match(/(\d+) failed/)
    const passed = passMatch ? parseInt(passMatch[1]) : 0
    const failed = failMatch ? parseInt(failMatch[1]) : -1

    return { passed, failed, status: 'fail', output }
  }
}

async function loadPreviousRun(): Promise<QARun | null> {
  try {
    const logPath = path.join(projectRoot, 'docs/qa/QA-COMPARISON-LOG.md')
    const content = await fs.readFile(logPath, 'utf-8')

    // Extract last run date from log
    const runMatch = content.match(/## QA Run #\d+ — (\d{4}-\d{2}-\d{2})/m)
    if (!runMatch) return null

    const date = runMatch[1]

    // Extract metrics from the baseline metrics table
    // Format: | **TypeScript Compilation** | ✅ PASS | All packages compile |
    const typeCheckMatch = content.match(/\| \*\*TypeScript Compilation\*\* \| (✅ PASS|❌ FAIL)/)
    const lintMatch = content.match(/\| \*\*ESLint.*?\*\* \| (✅ PASS|❌ FAIL)/)
    const unitTestMatch = content.match(/\| \*\*Unit Tests\*\* \| (✅ PASS|❌ FAIL) \| (\d+) passed/)

    const typecheck = typeCheckMatch ? (typeCheckMatch[1].includes('✅') ? 'pass' : 'fail') : 'pass'
    const lint = lintMatch ? (lintMatch[1].includes('✅') ? 'pass' : 'fail') : 'pass'
    const unitTestsPassed = unitTestMatch ? parseInt(unitTestMatch[2]) : 0
    const unitTestsStatus = unitTestMatch ? (unitTestMatch[1].includes('✅') ? 'pass' : 'fail') : 'pass'

    return {
      date,
      timestamp: new Date(date).getTime(),
      metrics: {
        typecheck: typecheck as 'pass' | 'fail',
        lint: lint as 'pass' | 'fail',
        unitTests: { status: unitTestsStatus as 'pass' | 'fail', passed: unitTestsPassed },
        durationSeconds: 0,
      },
      regressions: [],
      newIssues: [],
    }
  } catch {
    return null
  }
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0]
}

async function updateComparisonLog(run: QARun, previous: QARun | null): Promise<void> {
  const logPath = path.join(projectRoot, 'docs/qa/QA-COMPARISON-LOG.md')
  let content = await fs.readFile(logPath, 'utf-8')

  // Check for regressions vs. previous run
  const regressions: string[] = []
  if (previous) {
    if (previous.metrics.typecheck === 'pass' && run.metrics.typecheck === 'fail') {
      regressions.push('TypeScript compilation broke')
    }
    if (previous.metrics.lint === 'pass' && run.metrics.lint === 'fail') {
      regressions.push('Linting failed')
    }
    if (
      previous.metrics.unitTests.status === 'pass' &&
      run.metrics.unitTests.status === 'fail'
    ) {
      regressions.push('Unit tests regressed')
    }
  }

  // Create metrics table for this run
  const metricsTable = `| Check | Status | Details |
|---|---|---|
| **TypeScript Compilation** | ${run.metrics.typecheck === 'pass' ? '✅ PASS' : '❌ FAIL'} | All 3 packages ${run.metrics.typecheck === 'pass' ? 'compile without error' : 'have compilation errors'} |
| **ESLint / Code Quality** | ${run.metrics.lint === 'pass' ? '✅ PASS' : '❌ FAIL'} | ${run.metrics.lint === 'pass' ? 'All lint rules passing' : 'Lint failures detected'} |
| **Unit Tests** | ${run.metrics.unitTests.status === 'pass' ? '✅ PASS' : '❌ FAIL'} | ${run.metrics.unitTests.passed || 0} tests passed${run.metrics.unitTests.failed ? '; ' + run.metrics.unitTests.failed + ' failed' : ''} |
| **Build Artifacts** | ⏸️ SKIPPED | Requires docker build (railway.toml); deferred to manual full-build |
| **Database Schema** | ⏸️ SKIPPED | Requires live DB connection; included in matrix run |
| **E2E Test Matrix** | ⏸️ SKIPPED | Requires Railway dev URLs + CLERK_HMAC env; blocked without creds |`

  // Insert new run section after "## QA Run #1" line
  const runSection = `## QA Run #1 — ${run.date}

**Date/Time:** ${run.date} @ ${new Date().getHours().toString().padStart(2, '0')}:${new Date().getMinutes().toString().padStart(2, '0')} UTC
**Environment:** Local dev environment
**Duration:** ${run.metrics.durationSeconds}s

### Baseline Metrics

${metricsTable}

${regressions.length > 0 ? `### ⚠️ Regressions Detected

${regressions.map(r => `- ${r}`).join('\n')}

` : ''}`

  // Replace the existing QA Run #1 section with new one
  const sectionPattern = /## QA Run #1 — \d{4}-\d{2}-\d{2}[\s\S]*?(?=## QA Run #|## Feature Set|$)/
  if (sectionPattern.test(content)) {
    content = content.replace(sectionPattern, runSection + '\n')
  } else {
    // If no existing run found, insert after the header
    content = content.replace(
      /---\n\n## QA Run #1/,
      `---\n\n${runSection}\n\n---\n\n## QA Run (Previous)`,
    )
  }

  // Add regression tracking entry
  if (regressions.length > 0) {
    const regressionLine = `| ${run.date} | ${previous?.date || 'baseline'} | ${regressions[0]} | ${run.metrics.unitTests.passed || '?'} | ⚠️ NEEDS INVESTIGATION |\n`
    content = content.replace(
      '| (none yet) | N/A | N/A | N/A | N/A |',
      regressionLine + '| (none yet) | N/A | N/A | N/A | N/A |',
    )
  }

  await fs.writeFile(logPath, content)
  console.log(`[QA] Updated comparison log: ${logPath}`)
}

async function main() {
  console.log('╔════════════════════════════════════════════════╗')
  console.log('║  ServiceOS — Automated QA Runner                ║')
  console.log('║  Running every 2-3 days for regression tracking  ║')
  console.log('╚════════════════════════════════════════════════╝\n')

  const startTime = Date.now()
  const todayDate = formatDate(new Date())

  console.log(`[QA] Run Date: ${todayDate}`)
  console.log(`[QA] Environment: ${process.env.NODE_ENV || 'development'}`)

  // Run checks
  const typecheck = await runCommand('npm run typecheck', 'TypeScript Compilation')
  const lint = await runCommand('npm run lint', 'Linting')
  const tests = await getTestMetrics()

  const durationSeconds = Math.round((Date.now() - startTime) / 1000)

  const currentRun: QARun = {
    date: todayDate,
    timestamp: Date.now(),
    metrics: {
      typecheck: typecheck.status,
      lint: lint.status,
      unitTests: {
        status: tests.status,
        passed: tests.passed,
        failed: tests.failed,
        output: tests.output,
      },
      durationSeconds,
    },
    regressions: [],
    newIssues: [],
  }

  // Load and compare against previous run
  const previous = await loadPreviousRun()

  if (previous) {
    console.log(`\n[QA] Comparing against previous run: ${previous.date}`)

    // Check for regressions
    if (previous.metrics.typecheck === 'pass' && currentRun.metrics.typecheck === 'fail') {
      currentRun.regressions.push('❌ REGRESSION: TypeScript compilation broke')
    } else if (previous.metrics.typecheck === 'fail' && currentRun.metrics.typecheck === 'pass') {
      currentRun.newIssues.push('✅ FIXED: TypeScript compilation restored')
    }

    if (previous.metrics.lint === 'pass' && currentRun.metrics.lint === 'fail') {
      currentRun.regressions.push('❌ REGRESSION: Linting failed')
    } else if (previous.metrics.lint === 'fail' && currentRun.metrics.lint === 'pass') {
      currentRun.newIssues.push('✅ FIXED: Linting restored')
    }

    if (previous.metrics.unitTests.status === 'pass' && currentRun.metrics.unitTests.status === 'fail') {
      currentRun.regressions.push('❌ REGRESSION: Unit tests failed')
    } else if (previous.metrics.unitTests.status === 'fail' && currentRun.metrics.unitTests.status === 'pass') {
      currentRun.newIssues.push('✅ FIXED: Unit tests restored')
    }
  } else {
    console.log('[QA] No previous run found; establishing baseline')
  }

  // Update comparison log
  await updateComparisonLog(currentRun, previous)

  // Print summary
  console.log('\n╔════════════════════════════════════════════════╗')
  console.log('║  QA Run Summary                                 ║')
  console.log('╚════════════════════════════════════════════════╝')
  console.log(`Date:        ${currentRun.date}`)
  console.log(`Duration:    ${durationSeconds}s`)
  console.log(`TypeCheck:   ${typecheck.status === 'pass' ? '✅ PASS' : '❌ FAIL'}`)
  console.log(`Lint:        ${lint.status === 'pass' ? '✅ PASS' : '❌ FAIL'}`)
  console.log(`Unit Tests:  ${tests.status === 'pass' ? '✅ PASS' : '❌ FAIL'} (${tests.passed} passed${tests.failed > 0 ? ', ' + tests.failed + ' failed' : ''})`)

  if (currentRun.regressions.length > 0) {
    console.log('\n⚠️  REGRESSIONS DETECTED:')
    currentRun.regressions.forEach(r => console.log(`   ${r}`))
    process.exit(1) // Exit with error if regressions found
  }

  if (currentRun.newIssues.length > 0) {
    console.log('\n✅ FIXES VALIDATED:')
    currentRun.newIssues.forEach(f => console.log(`   ${f}`))
  }

  console.log('\n[QA] Run complete. Comparison log updated.')
}

main().catch(err => {
  console.error('[QA] FATAL ERROR:', err)
  process.exit(1)
})
