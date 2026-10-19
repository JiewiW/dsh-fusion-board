import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { OperationId, SessionId, TaskId, WriteLease } from '../contracts.js'
import { FusionError, LEASE_BUSY, LEASE_GENERATION } from '../errors.js'

/** Lease TTL: 30 minutes. A lease whose expiresAt has passed is stale. */
export const LEASE_TTL_MS = 30 * 60 * 1000

/** Heartbeat interval: 20 seconds. Worker calls renew() at this cadence. */
export const LEASE_HEARTBEAT_MS = 20 * 1000

export interface LeaseRecord extends WriteLease {
  readonly owner: string
  readonly pid: number
  readonly acquiredAt: string
  /** ISO timestamp; lease expires at this point unless renewed. Absent on legacy records. */
  readonly expiresAt?: string
  readonly liveProcessRefs: readonly number[]
}

export function canonicalWorkspace(cwd: string): string {
  return fs.realpathSync.native(cwd)
}

const DURABLE_LEASE_ROOT = path.join(os.homedir(), '.local', 'state', 'dsh-fusion-board', 'leases')

export function leasePath(workspaceId: string, root = DURABLE_LEASE_ROOT): string {
  const key = createHash('sha256').update(workspaceId).digest('hex').slice(0, 24)
  return path.join(root, `${key}.lock`)
}

/** Check whether a PID is alive. Returns false on ESRCH (PID not found = dead). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    // EPERM = PID exists but we lack permission to signal it — still alive
    if (code === 'EPERM') return true
    // Unknown error: assume alive to avoid false-positive cleanup
    return true
  }
}

export class WorkspaceWriteLease {
  constructor(private readonly root = DURABLE_LEASE_ROOT) {
    if (!path.isAbsolute(root)) throw new TypeError('lease registry directory must be absolute')
  }

  acquire(input: {
    cwd: string
    holder: SessionId
    taskId: TaskId
    operationId: OperationId
    liveProcessRefs?: readonly number[]
  }): LeaseRecord {
    const workspaceId = canonicalWorkspace(input.cwd)
    return this.#transaction(workspaceId, db => {
      const row = this.#row(db)
      const prior = this.#record(row, workspaceId)
      if (prior) {
        // Auto-recover stale lease before throwing LEASE_BUSY
        if (this.#isStale(prior)) {
          db.prepare('UPDATE lease SET record=NULL WHERE id=1').run()
        } else {
          throw new FusionError(LEASE_BUSY, `workspace is held by ${prior.holder}; reconcile before handoff`)
        }
      }
      if (row.generation === Number.MAX_SAFE_INTEGER) throw new FusionError(LEASE_GENERATION, 'lease generation exhausted')
      const refs = [...new Set([process.pid, ...(input.liveProcessRefs ?? [])])]
      if (refs.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new FusionError(LEASE_BUSY, 'invalid process reference')
      const now = new Date()
      const record: LeaseRecord = {
        workspaceId, holder: input.holder, taskId: input.taskId, generation: row.generation + 1,
        activeOperationIds: [input.operationId], owner: `${process.pid}:${randomUUID()}`, pid: process.pid,
        acquiredAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + LEASE_TTL_MS).toISOString(),
        liveProcessRefs: refs,
      }
      db.prepare('UPDATE lease SET generation=?, record=? WHERE id=1').run(record.generation, JSON.stringify(record))
      return record
    })
  }

  assertGeneration(lease: WriteLease, generation: number): void {
    const current = this.current(lease.workspaceId)
    if (lease.generation !== generation || current?.generation !== generation
      || current.holder !== lease.holder || current.taskId !== lease.taskId) {
      throw new FusionError(LEASE_GENERATION, `stale write generation ${generation}`)
    }
  }

  stillHeld(lease: LeaseRecord): boolean {
    const current = this.current(lease.workspaceId)
    return current?.owner === lease.owner && current.generation === lease.generation
  }

  /** Caller must prove native Worker/tool quiescence before releasing. */
  release(lease: LeaseRecord): void {
    this.#transaction(lease.workspaceId, db => {
      const current = this.#record(this.#row(db), lease.workspaceId)
      if (current?.owner === lease.owner && current.generation === lease.generation) {
        db.prepare('UPDATE lease SET record=NULL WHERE id=1 AND generation=?').run(lease.generation)
      }
    })
  }

  /**
   * Renew (heartbeat) the lease — push expiresAt forward by TTL.
   * Called by Worker every LEASE_HEARTBEAT_MS to prevent premature TTL expiry.
   * No-op if lease is not owned by caller.
   */
  renew(lease: LeaseRecord): LeaseRecord {
    return this.#transaction(lease.workspaceId, db => {
      const row = this.#row(db)
      const current = this.#record(row, lease.workspaceId)
      if (!current || current.owner !== lease.owner || current.generation !== lease.generation) {
        throw new FusionError(LEASE_GENERATION, 'cannot renew lease we do not own')
      }
      const renewed: LeaseRecord = {
        ...current,
        expiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString(),
      }
      db.prepare('UPDATE lease SET record=? WHERE id=1 AND generation=?').run(JSON.stringify(renewed), current.generation)
      return renewed
    })
  }

  /**
   * Read the current lease, auto-clearing stale ones:
   *   (a) TTL expired (expiresAt < now), OR
   *   (b) all liveProcessRefs PIDs are dead.
   * Legacy records without expiresAt fall back to process-liveness only.
   * Returns undefined if no lease OR lease was stale and cleared.
   */
  current(cwd: string): LeaseRecord | undefined {
    const workspaceId = canonicalWorkspace(cwd)
    return this.#transaction(workspaceId, db => {
      const row = this.#row(db)
      const record = this.#record(row, workspaceId)
      if (record && this.#isStale(record)) {
        db.prepare('UPDATE lease SET record=NULL WHERE id=1').run()
        return undefined
      }
      return record
    })
  }

  /** Is this lease stale? (TTL expired OR all PIDs dead) */
  #isStale(record: LeaseRecord): boolean {
    // (a) TTL check: if expiresAt exists and is past → stale
    if (record.expiresAt) {
      const expires = Date.parse(record.expiresAt)
      if (!Number.isNaN(expires) && expires < Date.now()) return true
    }
    // (b) Process-liveness check: if ALL refs are dead → stale
    if (record.liveProcessRefs.length > 0) {
      const anyAlive = record.liveProcessRefs.some(pid => isProcessAlive(pid))
      if (!anyAlive) return true
    }
    return false
  }

  #row(db: DatabaseSync): { generation: number; record: unknown } {
    const row = db.prepare('SELECT generation, record FROM lease WHERE id=1').get()
    if (!row || typeof row.generation !== 'number' || !Number.isSafeInteger(row.generation) || row.generation < 0) {
      throw new FusionError(LEASE_BUSY, 'durable lease generation is corrupt')
    }
    return { generation: row.generation, record: row.record }
  }

  #record(row: { generation: number; record: unknown }, workspaceId: string): LeaseRecord | undefined {
    if (row.record === null) return undefined
    if (typeof row.record !== 'string') throw new FusionError(LEASE_BUSY, 'invalid durable lease record')
    const value = JSON.parse(row.record) as Partial<LeaseRecord>
    if (value.workspaceId !== workspaceId || value.generation !== row.generation
      || typeof value.owner !== 'string' || typeof value.holder !== 'string' || typeof value.taskId !== 'string'
      || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.acquiredAt !== 'string'
      || !Array.isArray(value.activeOperationIds) || !Array.isArray(value.liveProcessRefs)) {
      throw new FusionError(LEASE_BUSY, 'durable lease requires reconciliation')
    }
    // expiresAt is optional — legacy records lack it; #isStale handles both
    if (value.expiresAt !== undefined && typeof value.expiresAt !== 'string') {
      throw new FusionError(LEASE_BUSY, 'durable lease expiresAt must be ISO string')
    }
    return value as LeaseRecord
  }

  /** Atomic publication/CAS; generations survive release and process restart. */
  #transaction<T>(workspaceId: string, body: (db: DatabaseSync) => T): T {
    const legacy = leasePath(workspaceId, this.root)
    fs.mkdirSync(path.dirname(legacy), { recursive: true, mode: 0o700 })
    const oldTemporary = leasePath(workspaceId, path.join(fs.existsSync('/tmp') ? '/tmp' : os.tmpdir(), 'dsh-fusion-board-leases'))
    for (const lock of new Set([legacy, oldTemporary])) {
      try {
        fs.lstatSync(lock)
        throw new FusionError(LEASE_BUSY, 'legacy writer lock requires explicit reconciliation')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const db = new DatabaseSync(`${legacy}.sqlite`)
    let transaction = false
    try {
      db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;')
      transaction = true
      const version = db.prepare('PRAGMA user_version').get()?.user_version
      if (version !== 0 && version !== 1) throw new FusionError(LEASE_BUSY, 'unknown lease database version')
      if (version === 0) {
        const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()?.n
        if (tables !== 0) throw new FusionError(LEASE_BUSY, 'unversioned nonempty lease database')
        db.exec('CREATE TABLE lease (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, record TEXT); INSERT INTO lease VALUES (1, 0, NULL); PRAGMA user_version=1;')
      }
      const result = body(db)
      db.exec('COMMIT'); transaction = false
      return result
    } catch (error) {
      if (transaction) db.exec('ROLLBACK')
      throw error
    } finally { db.close() }
  }
}

export function classifyEffect(kind: 'read-tool' | 'write-tool' | 'unknown-shell'): 'read' | 'write' {
  if (kind === 'read-tool') return 'read'
  return 'write'
}
