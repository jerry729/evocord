// Run by evolve.test.ts in a subprocess with BOT_ROOT etc. pointing at a temp dir.
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ROOT } from '../config'
import { applyJob, commitAndDiff, createJob, ensureRepo, headCommit, loadJob, resetTo, runAgent, saveJob } from '../evolve'

await ensureRepo()
const before = await headCommit()
const job = await createJob({ request: 'change a', notes: '', requester: { id: '1', name: 'admin' }, chatId: '2', requestMessageId: '3' })
const actions: string[] = []
const r = await runAgent(job, 'prompt', null, 1, null, a => actions.push(a))
job.sessionId = r.sessionId
const changed = await commitAndDiff(job, 'evolve test')
job.status = 'ready'
saveJob(job)
const applied = await applyJob(job)
const aAfterApply = readFileSync(join(ROOT, 'a.txt'), 'utf8').trim()
writeFileSync(join(ROOT, 'manual.txt'), 'hand edit')
writeFileSync(join(ROOT, 'memory', 'note.md'), 'remember me')
const rb = await resetTo(before)
console.log(JSON.stringify({
  ok: r.ok, text: r.text, sessionId: r.sessionId, cost: r.costUsd, actions, changed, files: job.files,
  status: loadJob(job.id)?.status, applied: !!applied.next && applied.prev === before,
  aAfterApply, aAfterRollback: readFileSync(join(ROOT, 'a.txt'), 'utf8').trim(),
  manualAfterRollback: existsSync(join(ROOT, 'manual.txt')),
  memoryAfterRollback: existsSync(join(ROOT, 'memory', 'note.md')),
  worktreeLeft: existsSync(job.worktree), rollbackTo: rb.to === before,
  postUpdateLog: readFileSync(join(ROOT, 'state', 'post.log'), 'utf8').trim().split('\n').length,
}))
