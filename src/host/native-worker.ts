import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import type { PhysicalRoute } from '../contracts.js'

/** Poll interval for checking whether the child session is still producing events. */
const WORKER_ACTIVITY_POLL_MS = 20 * 1000
/** No new session event for this long → Worker is truly hung, interrupt it. */
const WORKER_IDLE_TIMEOUT_MS = 5 * 60 * 1000
/** Absolute ceiling even if activity keeps coming; safety net against infinite work. */
const WORKER_TOTAL_TIMEOUT_MS = 30 * 60 * 1000

export interface NativeWorkerRequest {
  readonly childId: string
  readonly label: string
  /** Model-authored brief from the Lead's native tool call. */
  readonly brief: string
  readonly route: PhysicalRoute
  readonly persona: string
  readonly allowedTools: readonly string[]
}

export interface NativeWorkerAcceptance {
  readonly childId: string
  readonly messageId: MessageId
}

/** Version-pinned public API adapter. It never calls an LLM adapter or runs a shell itself. */
export class NativeWorkerTransport {
  readonly #flushed = new WeakMap<Agent, number>()
  constructor(private readonly ctx: Context, private readonly provider = 'spawn') {}

  assertAvailable(): void {
    const provider = this.ctx.subagents.getProvider(this.provider)
    if (!provider?.prepareContinuable || provider.inheritsParentContext !== false) {
      throw new Error(`Fusion requires an independent continuable provider: ${this.provider}`)
    }
  }

  /** Caller durably reserves the child and operation before entering this method. */
  async start(parent: Agent, request: NativeWorkerRequest, signal: AbortSignal): Promise<NativeWorkerAcceptance> {
    this.assertAvailable()
    signal.throwIfAborted()
    if (this.ctx.agents.get(SessionId(request.childId))) throw new Error('Reserved Worker already exists; reconcile before retrying')
    const accepted = await this.ctx.subagents.startContinuable({
      provider: this.provider,
      label: request.label,
      childId: SessionId(request.childId),
      request: {
        parent,
        prompt: [{ type: 'text', text: request.brief }],
        persona: request.persona,
        agentOptions: {
          provider: request.route.provider,
          model: request.route.model,
          ...(request.route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(request.route.reasoningEffort) }),
        },
        toolFilter: { allow: [...request.allowedTools] },
        maxDepth: (parent.session.header.delegationDepth ?? 0) + 1,
      },
      signal,
    })
    if (accepted.childId !== request.childId) throw new Error('Native Worker identity changed during creation')
    return accepted
  }

  /** Only Lead-authored feedback is sent through this public model-message API. */
  async continue(parent: Agent, childId: string, feedback: string, signal: AbortSignal): Promise<NativeWorkerAcceptance> {
    signal.throwIfAborted()
    const messageId = await this.ctx.subagents.sendMessage(
      parent, SessionId(childId), [{ type: 'text', text: feedback }], { signal },
    )
    return { childId, messageId }
  }

  /**
   * Replace an in-flight generation through public cancellation, then deliver
   * to the same durable child. The caller must first exclude live/unknown
   * effectful tools. Otherwise use continue(), which steers at a step boundary.
   */
  async interruptAndContinue(parent: Agent, childId: string, feedback: string, signal: AbortSignal): Promise<NativeWorkerAcceptance> {
    signal.throwIfAborted()
    await this.stop(parent, childId)
    signal.throwIfAborted()
    return this.continue(parent, childId, feedback, signal)
  }

  /** Interrupt acceptance is insufficient: wait for the exact native Agent to settle and flush. */
  settle(parent: Agent, childId: string, signal: AbortSignal): Promise<Agent>
  /** Yield a blocking tool to native user steering without canceling or releasing the Worker. */
  settle(parent: Agent, childId: string, signal: AbortSignal, yieldToSteering: true): Promise<Agent | undefined>
  async settle(parent: Agent, childId: string, signal: AbortSignal, yieldToSteering = false): Promise<Agent | undefined> {
    const child = this.#requireChild(parent, childId)
    let interruptError: unknown
    let removeSteering = () => {}
    const interrupt = () => {
      try { this.ctx.subagents.interrupt(child.id, { kind: 'ancestor', agent: parent }) }
      catch (error) { interruptError = error }
    }
    signal.addEventListener('abort', interrupt, { once: true })
    if (signal.aborted) interrupt()
    try {
      if (yieldToSteering && !signal.aborted) {
        const steering = new Promise<true>(resolve => {
          const check = () => {
            // Queue/next-turn and plugin context keep their native semantics.
            if (parent.inbox.nextStep.some(message => message.source.kind === 'user')) resolve(true)
          }
          removeSteering = parent.ctx.on('agent/inbox/inserted', ({ agent }) => { if (agent === parent) check() })
          check() // A message may already have arrived during delegation setup.
        })
        const settledOrTimeout = this.#settleWithActivityTimeout(child, child.whenIdle())
        const yielded = await Promise.race([settledOrTimeout.then(() => false), steering])
        // Cancellation still owns full settlement; an already idle Worker can
        // be flushed normally. The Lead alone authors any revised Worker brief.
        if (yielded && !signal.aborted && child.status !== 'idle') return undefined
      }
      await this.#settleWithActivityTimeout(child, child.whenIdle())
      if (interruptError) throw interruptError
      if (this.ctx.agents.get(child.id) !== child) throw new Error('Worker residency changed; quiescence requires reconciliation')
      if (!await this.ctx.sessions.flush(child.session)) throw new Error('Worker log persistence unavailable')
      this.#flushed.set(child, child.session.snapshotEvents().at(-1)?.seq ?? 0)
      return child
    } finally { removeSteering(); signal.removeEventListener('abort', interrupt) }
  }

  /**
   * Wait for child.whenIdle() to settle, but with a two-tier timeout that
   * distinguishes "still working" from "truly hung":
   *   - IDLE:  no new session event for WORKER_IDLE_TIMEOUT_MS → hung
   *   - TOTAL: absolute WORKER_TOTAL_TIMEOUT_MS ceiling (safety net)
   * We poll the latest session seq every WORKER_ACTIVITY_POLL_MS. A seq
   * bump resets the idle clock, so a Worker producing tokens/tool calls
   * (even a 20-minute deep-think) never gets killed. Only a Worker that
   * stops producing events entirely — crashed, dead-locked, or lost
   * network — gets interrupted.
   */
  async #settleWithActivityTimeout(child: Agent, inner: Promise<void>): Promise<void> {
    return await new Promise<void>((resolve, reject) => {
      const startTs = Date.now()
      let lastProgressSeq = child.session.snapshotEvents().at(-1)?.seq ?? 0
      let idleSince = startTs

      const interval = setInterval(() => {
        const now = Date.now()
        const currentSeq = child.session.snapshotEvents().at(-1)?.seq ?? 0
        if (currentSeq > lastProgressSeq) {
          lastProgressSeq = currentSeq
          idleSince = now
        }
        const idleFor = now - idleSince
        const totalFor = now - startTs
        if (idleFor >= WORKER_IDLE_TIMEOUT_MS) {
          clearInterval(interval)
          reject(new Error(`FUSION_INTERRUPTED: Worker produced no new event for ${Math.round(idleFor / 60000)}m; timed out during fusion_wait`))
        } else if (totalFor >= WORKER_TOTAL_TIMEOUT_MS) {
          clearInterval(interval)
          reject(new Error(`FUSION_INTERRUPTED: Worker exceeded total ${Math.round(totalFor / 60000)}m safety ceiling during fusion_wait`))
        }
      }, WORKER_ACTIVITY_POLL_MS)

      inner.then(() => {
        clearInterval(interval)
        resolve()
      }).catch(err => {
        clearInterval(interval)
        reject(err)
      })
    })
  }

  async stop(parent: Agent, childId: string): Promise<Agent> {
    const child = this.#requireChild(parent, childId)
    // Native continuation teardown may already be closing this idle handle.
    // Reuse only our exact prior quiescence+flush proof at the unchanged log seq.
    if (child.status === 'idle' && this.#flushed.get(child) === (child.session.snapshotEvents().at(-1)?.seq ?? 0)) return child
    this.ctx.subagents.interrupt(child.id, { kind: 'ancestor', agent: parent })
    await this.#settleWithActivityTimeout(child, child.whenIdle())
    if (this.ctx.agents.get(child.id) !== child) throw new Error('Worker residency changed during stop')
    if (!await this.ctx.sessions.flush(child.session)) throw new Error('Worker log persistence unavailable')
    this.#flushed.set(child, child.session.snapshotEvents().at(-1)?.seq ?? 0)
    return child
  }

  /** Native release owns quiescence, persistence and handle disposal across HMR. */
  async release(parent: Agent, childId: string): Promise<void> {
    const child = this.ctx.agents.get(SessionId(childId))
    if (child && child.session.header.parentSession !== parent.id) throw new Error('Cannot release another Lead’s child')
    await this.ctx.subagents.drainContinuableChildren(parent, [SessionId(childId)])
    if (this.ctx.agents.get(SessionId(childId))) throw new Error('Native Worker release did not prove absence')
  }

  #requireChild(parent: Agent, childId: string): Agent {
    const child = this.ctx.agents.get(SessionId(childId))
    if (!child || child.session.header.parentSession !== parent.id) {
      throw new Error('Worker is absent or is not this Lead’s child; reconcile its persisted session')
    }
    return child
  }
}

