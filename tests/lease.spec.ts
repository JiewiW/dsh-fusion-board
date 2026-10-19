import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { OperationId, SessionId, TaskId } from '../src/contracts.js'
import { LEASE_BUSY, LEASE_GENERATION } from '../src/errors.js'
import { canonicalWorkspace, classifyEffect, leasePath, WorkspaceWriteLease } from '../src/execution/write-lease.js'
import { expectCode } from './helpers.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

describe('WorkspaceWriteLease', () => {
  it('allows only one writer generation on a workspace', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dmf-lease-'))
    dirs.push(cwd)
    const gate = new WorkspaceWriteLease(join(cwd, 'lease-registry'))
    const first = gate.acquire({
      cwd,
      holder: SessionId('worker-1'),
      taskId: TaskId('task-1'),
      operationId: OperationId('op-1'),
    })
    expect(first.generation).toBe(1)
    expectCode(() => gate.acquire({
      cwd,
      holder: SessionId('lead-1'),
      taskId: TaskId('task-1'),
      operationId: OperationId('op-2'),
    }), LEASE_BUSY)
    gate.assertGeneration(first, 1)
    expectCode(() => gate.assertGeneration(first, 0), LEASE_GENERATION)
    gate.release(first)
    const second = gate.acquire({
      cwd,
      holder: SessionId('lead-1'),
      taskId: TaskId('task-1'),
      operationId: OperationId('op-3'),
    })
    expect(second.generation).toBe(2)
    expectCode(() => gate.assertGeneration(first, first.generation), LEASE_GENERATION)
    gate.release(first)
    expect(gate.stillHeld(second)).toBe(true)
    gate.release(second)
  })

  it('coordinates independent handles and canonical symlink paths', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dmf-lease-')); dirs.push(cwd)
    const alias = join(cwd, 'alias'); const nested = mkdtempSync(join(cwd, 'target-')); symlinkSync(nested, alias)
    const first = new WorkspaceWriteLease(join(cwd, 'lease-registry')); const second = new WorkspaceWriteLease(join(cwd, 'lease-registry'))
    const input = { cwd: alias, holder: SessionId('worker'), taskId: TaskId('task'), operationId: OperationId('op') }
    const held = first.acquire(input)
    expect(second.current(nested)).toEqual(held)
    expectCode(() => second.acquire({ ...input, cwd: nested }), LEASE_BUSY)
    second.release(held)
    const next = first.acquire(input)
    expect(next.generation).toBe(2)
    first.release(next)
  })

  it('refuses incomplete legacy locks instead of racing to unlink them', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dmf-lease-')); dirs.push(cwd)
    const root = join(cwd, 'lease-registry')
    const lock = leasePath(canonicalWorkspace(cwd), root); mkdirSync(dirname(lock), { recursive: true })
    writeFileSync(lock, '')
    try {
      expectCode(() => new WorkspaceWriteLease(root).acquire({ cwd, holder: SessionId('worker'), taskId: TaskId('task'), operationId: OperationId('op') }), LEASE_BUSY)
      expect(existsSync(lock)).toBe(true)
    } finally { rmSync(lock) }
  })

  it('treats unknown shell as writable', () => {
    expect(classifyEffect('unknown-shell')).toBe('write')
    expect(classifyEffect('read-tool')).toBe('read')
  })

  it('renews (heartbeat) a lease only when owned, pushing expiresAt forward', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dmf-lease-')); dirs.push(cwd)
    const gate = new WorkspaceWriteLease(join(cwd, 'lease-registry'))
    const held = gate.acquire({ cwd, holder: SessionId('worker'), taskId: TaskId('task'), operationId: OperationId('op') })
    expect(held.expiresAt).toBeTruthy()
    const renewed = gate.renew(held)
    expect(renewed.generation).toBe(held.generation)
    expect(renewed.owner).toBe(held.owner)
    expect(Date.parse(renewed.expiresAt!)).toBeGreaterThan(Date.parse(held.expiresAt!))
    // 非持有者 renew 必须被拒（owner/generation 不匹配）
    const stranger = { ...held, owner: '999:stranger', generation: 999 }
    expectCode(() => gate.renew(stranger as never), LEASE_GENERATION)
  })

  it('auto-clears a lease whose liveProcessRefs PIDs are all dead', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dmf-lease-')); dirs.push(cwd)
    const gate = new WorkspaceWriteLease(join(cwd, 'lease-registry'))
    const held = gate.acquire({ cwd, holder: SessionId('worker'), taskId: TaskId('task'), operationId: OperationId('op') })
    // acquire 总把当前进程 PID 并入 liveProcessRefs，直接改写记录为全死 PID
    const lock = leasePath(canonicalWorkspace(cwd), join(cwd, 'lease-registry'))
    const db = new DatabaseSync(`${lock}.sqlite`)
    const stale = { ...held, liveProcessRefs: [2147483647], expiresAt: new Date(Date.now() + 3600_000).toISOString() }
    db.prepare('UPDATE lease SET record=? WHERE id=1').run(JSON.stringify(stale))
    db.close()
    // current() 发现全死 PID → 自动清锁
    expect(gate.current(cwd)).toBeUndefined()
    // 清锁后新持有者可以直接 acquire（不再 LEASE_BUSY）
    const next = gate.acquire({ cwd, holder: SessionId('lead'), taskId: TaskId('task'), operationId: OperationId('op2') })
    expect(next.generation).toBe(2)
    gate.release(next)
  })

  it('auto-clears a TTL-expired lease and lets a new holder acquire', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dmf-lease-')); dirs.push(cwd)
    const gate = new WorkspaceWriteLease(join(cwd, 'lease-registry'))
    const held = gate.acquire({ cwd, holder: SessionId('worker'), taskId: TaskId('task'), operationId: OperationId('op') })
    // 改写 expiresAt 为过去时间，模拟 TTL 过期（进程 PID 仍活着，但 TTL 判定优先）
    const lock = leasePath(canonicalWorkspace(cwd), join(cwd, 'lease-registry'))
    const db = new DatabaseSync(`${lock}.sqlite`)
    const stale = { ...held, expiresAt: new Date(Date.now() - 60_000).toISOString() }
    db.prepare('UPDATE lease SET record=? WHERE id=1').run(JSON.stringify(stale))
    db.close()
    // current() 发现 TTL 过期 → 自动清锁
    expect(gate.current(cwd)).toBeUndefined()
    const next = gate.acquire({ cwd, holder: SessionId('lead'), taskId: TaskId('task'), operationId: OperationId('op2') })
    expect(next.generation).toBe(2)
    gate.release(next)
  })

  it('refuses renew for a lease that was cleared or reassigned', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dmf-lease-')); dirs.push(cwd)
    const gate = new WorkspaceWriteLease(join(cwd, 'lease-registry'))
    const held = gate.acquire({ cwd, holder: SessionId('worker'), taskId: TaskId('task'), operationId: OperationId('op') })
    gate.release(held)
    // 释放后 renew 旧 lease：owner/generation 对不上 → LEASE_GENERATION
    expectCode(() => gate.renew(held), LEASE_GENERATION)
  })
})
