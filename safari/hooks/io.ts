// The engine capabilities the helper modules use, handed over as plain functions.
// The engine's validator follows `$` only inside the file that received it, so
// register.ts builds this object from `$` and the other modules take `Io`.

export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type FetchResult = { status: number; ok: boolean; text: string; headers: Record<string, string> }

export type Io = {
  pluginRoot: string
  run: (argv: readonly string[], init?: { stdin?: string; timeoutMs?: number }) => Promise<RunResult>
  spawn: (argv: readonly string[]) => AsyncIterable<unknown>
  fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; socketPath?: string }) => Promise<FetchResult>
  home: () => Promise<string | undefined>
  readBytes: (path: string) => Promise<string>
  readText: (path: string) => Promise<string>
  writeText: (path: string, text: string) => Promise<void>
  fileSize: (path: string) => Promise<number>
  after: (ms: number) => Promise<void>
}
