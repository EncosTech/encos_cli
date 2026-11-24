// SPDX-License-Identifier: MIT

export function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, Math.max(0, milliseconds))
  })
}

export function nowMs(): number {
  return performance.now()
}

export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true
}

/** Ctrl-C 停止标志；第二次 Ctrl-C 直接退出。 */
export class Interrupt {
  #stopped = false
  #count = 0
  readonly #onSignal: () => void

  constructor() {
    this.#onSignal = () => {
      this.#count += 1
      if (this.#count >= 2) {
        process.exit(130)
      }
      this.#stopped = true
    }
    process.on('SIGINT', this.#onSignal)
    process.on('SIGTERM', this.#onSignal)
  }

  get stopped(): boolean {
    return this.#stopped
  }

  /** 由命令内部主动停止（例如完成固定采样次数）。 */
  stop(): void {
    this.#stopped = true
  }

  dispose(): void {
    process.off('SIGINT', this.#onSignal)
    process.off('SIGTERM', this.#onSignal)
  }
}

/**
 * 以固定周期执行 tick；用下一 tick 的绝对时间纠正漂移。
 * tick 自身耗时超过周期时立即开始下一 tick（与旧实现一致）。
 */
export async function periodic(
  periodMs: number,
  tick: () => Promise<void> | void,
  interrupt: Interrupt,
): Promise<void> {
  let next = nowMs()
  while (!interrupt.stopped) {
    await tick()
    next += periodMs
    const current = nowMs()
    if (next > current) {
      await sleep(next - current)
    } else {
      next = current
    }
  }
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

/**
 * 串行化 native 调用。
 *
 * 驱动的 native runtime 同一时刻只允许一个异步操作；同步的 commit()/getStatus()
 * 不能在异步调用未完成时执行。JS 单线程仍会因 await 交错而违反该约束，因此用一个
 * FIFO 队列把“发送 + commit”“采样”等整段操作串起来。
 */
export class SerialQueue {
  #tail: Promise<void> = Promise.resolve()

  run<T>(task: () => Promise<T> | T): Promise<T> {
    const next = this.#tail.then(task, task)
    this.#tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}
