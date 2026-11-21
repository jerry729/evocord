/** Speech-to-text via tools/transcribe.py (faster-whisper in ROOT/.venv). */
import { existsSync } from 'fs'
import { join } from 'path'
import { type Config, ROOT } from './config'
import { run } from './proc'

export type Transcript = { text: string; language: string; duration: number; device: string; model: string }

const AUDIO_EXT = /\.(ogg|oga|opus|mp3|m4a|aac|wav|flac|webm|weba|mp4|mov|mkv|amr|wma)$/i

export function isAudioLike(name: string, contentType: string | null | undefined): boolean {
  const ct = contentType ?? ''
  return ct.startsWith('audio/') || ct.startsWith('video/') || AUDIO_EXT.test(name)
}

export function pythonBin(): string {
  const venv = join(ROOT, '.venv', 'bin', 'python')
  return existsSync(venv) ? venv : 'python3'
}

// One transcription at a time: the GPU model is ~1.6GB and a burst of voice
// messages should queue rather than OOM.
let tail: Promise<unknown> = Promise.resolve()

export function transcribe(path: string, cfg: Config): Promise<Transcript> {
  const job = tail.then(() => transcribeNow(path, cfg))
  tail = job.catch(() => {})
  return job
}

async function transcribeNow(path: string, cfg: Config): Promise<Transcript> {
  const v = cfg.voice
  const args = [join(ROOT, 'tools', 'transcribe.py'), '--model', v.model, '--device', v.device,
    '--compute-type', v.computeType, '--max-seconds', String(v.maxSeconds)]
  if (v.language) args.push('--language', v.language)
  if (v.initialPrompt) args.push('--initial-prompt', v.initialPrompt)
  args.push(path)
  const r = await run(pythonBin(), args, { timeoutMs: v.timeoutSec * 1000 })
  let parsed: any
  try {
    parsed = JSON.parse(r.stdout.trim().split('\n').pop() ?? '')
  } catch {
    throw new Error(`transcriber failed (exit ${r.code}${r.timedOut ? ', timed out' : ''}): ${r.stderr.slice(-500)}`)
  }
  if (parsed.error) throw new Error(parsed.error)
  return parsed as Transcript
}
