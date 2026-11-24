#!/usr/bin/env node
// Copies the app's pure shared code (src/shared/ai) into functions/src/shared/ai before every build,
// so the web app and Cloud Functions use one contract (collections, types, monitoring rules).
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const from = join(here, '..', '..', 'src', 'shared', 'ai')
const to = join(here, '..', 'src', 'shared', 'ai')
rmSync(to, { recursive: true, force: true })
mkdirSync(to, { recursive: true })
cpSync(from, to, { recursive: true, filter: (p) => !p.endsWith('.test.ts') })
console.log(`copied ${from} -> ${to}`)
