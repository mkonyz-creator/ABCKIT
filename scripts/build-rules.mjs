#!/usr/bin/env node
// Concatenates firebase/rules/*.rules (sorted by name) into firestore.rules
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'firebase', 'rules')
const parts = readdirSync(dir).filter((f) => f.endsWith('.rules')).sort()
const out = parts.map((f) => readFileSync(join(dir, f), 'utf8').replace(/\s+$/, '')).join('\n') + '\n'
writeFileSync(join(root, 'firestore.rules'), out)
console.log(`firestore.rules built from ${parts.length} fragments: ${parts.join(', ')}`)
