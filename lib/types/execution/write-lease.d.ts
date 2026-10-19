import type { OperationId, SessionId, TaskId, WriteLease } from '../contracts.js';
/** Lease TTL: 30 minutes. A lease whose expiresAt has passed is stale. */
export declare const LEASE_TTL_MS: number;
/** Heartbeat interval: 20 seconds. Worker calls renew() at this cadence. */
export declare const LEASE_HEARTBEAT_MS: number;
export interface LeaseRecord extends WriteLease {
    readonly owner: string;
    readonly pid: number;
    readonly acquiredAt: string;
    /** ISO timestamp; lease expires at this point unless renewed. Absent on legacy records. */
    readonly expiresAt?: string;
    readonly liveProcessRefs: readonly number[];
}
export declare function canonicalWorkspace(cwd: string): string;
export declare function leasePath(workspaceId: string, root?: string): string;
export declare class WorkspaceWriteLease {
    #private;
    private readonly root;
    constructor(root?: string);
    acquire(input: {
        cwd: string;
        holder: SessionId;
        taskId: TaskId;
        operationId: OperationId;
        liveProcessRefs?: readonly number[];
    }): LeaseRecord;
    assertGeneration(lease: WriteLease, generation: number): void;
    stillHeld(lease: LeaseRecord): boolean;
    /** Caller must prove native Worker/tool quiescence before releasing. */
    release(lease: LeaseRecord): void;
    /**
     * Renew (heartbeat) the lease — push expiresAt forward by TTL.
     * Called by Worker every LEASE_HEARTBEAT_MS to prevent premature TTL expiry.
     * No-op if lease is not owned by caller.
     */
    renew(lease: LeaseRecord): LeaseRecord;
    /**
     * Read the current lease, auto-clearing stale ones:
     *   (a) TTL expired (expiresAt < now), OR
     *   (b) all liveProcessRefs PIDs are dead.
     * Legacy records without expiresAt fall back to process-liveness only.
     * Returns undefined if no lease OR lease was stale and cleared.
     */
    current(cwd: string): LeaseRecord | undefined;
}
export declare function classifyEffect(kind: 'read-tool' | 'write-tool' | 'unknown-shell'): 'read' | 'write';
