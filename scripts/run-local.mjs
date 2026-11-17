import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const target = process.argv[2]
if (!['api', 'web', 'web-build', 'web-start'].includes(target)) throw new Error('Use api / web / web-build / web-start')
const web = target.startsWith('web')
const env = Object.fromEntries(readFileSync(resolve(root, '.local', web ? 'web.env' : 'api.env'), 'utf8').trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)] }))
const child = spawn(web ? 'npm' : 'go', web ? ['run', target === 'web-build' ? 'build' : target === 'web-start' ? 'start' : 'dev'] : ['run', '.'], { cwd: resolve(root, web ? 'web' : 'api'), env: { ...process.env, ...env }, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', code => process.exit(code ?? 1))
