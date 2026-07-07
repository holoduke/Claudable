import { describe, it, expect, beforeEach } from 'vitest';
import {
  tryReserveAgentRun,
  setReservedRequestId,
  attachAgentAbort,
  releaseAgentRun,
  interruptAgentRun,
  isAgentRunActive,
} from './run-registry';

const PROJECT = 'proj-test';

// The registry lives on globalThis; clear our project's slot between tests.
beforeEach(() => {
  releaseAgentRun(PROJECT);
});

describe('run-registry', () => {
  it('reserves a slot atomically and rejects a concurrent reserve', () => {
    expect(tryReserveAgentRun(PROJECT)).toBe(true);
    expect(tryReserveAgentRun(PROJECT)).toBe(false); // busy
    expect(isAgentRunActive(PROJECT)).toBe(true);
    releaseAgentRun(PROJECT);
    expect(tryReserveAgentRun(PROJECT)).toBe(true); // free again
  });

  it('attach upgrades the reservation with the real abort', () => {
    tryReserveAgentRun(PROJECT);
    setReservedRequestId(PROJECT, 'req-1');
    let aborted = false;
    attachAgentAbort(PROJECT, 'req-1', () => { aborted = true; });
    const result = interruptAgentRun(PROJECT);
    expect(result.interrupted).toBe(true);
    expect(result.requestId).toBe('req-1');
    expect(aborted).toBe(true);
  });

  it('kills a process that attaches AFTER a stop landed during startup', () => {
    // Stop pressed while the turn is still starting up (reserved, not attached).
    tryReserveAgentRun(PROJECT);
    setReservedRequestId(PROJECT, 'req-2');
    const early = interruptAgentRun(PROJECT);
    expect(early.interrupted).toBe(true);

    // The process now comes up and attaches — it must be aborted immediately,
    // otherwise Stop during startup is a silent no-op and the agent runs on.
    let aborted = false;
    attachAgentAbort(PROJECT, 'req-2', () => { aborted = true; });
    expect(aborted).toBe(true);
  });

  it('keeps the slot busy after interrupt until the run releases it', () => {
    tryReserveAgentRun(PROJECT);
    attachAgentAbort(PROJECT, 'req-3', () => {});
    interruptAgentRun(PROJECT);
    // A new turn must not start while the interrupted one winds down.
    expect(tryReserveAgentRun(PROJECT)).toBe(false);
    releaseAgentRun(PROJECT, 'req-3');
    expect(tryReserveAgentRun(PROJECT)).toBe(true);
  });

  it('scopes release by requestId so a newer turn is not clobbered', () => {
    tryReserveAgentRun(PROJECT);
    attachAgentAbort(PROJECT, 'old', () => {});
    // Old turn finishes and a new turn re-reserves under the same project.
    releaseAgentRun(PROJECT, 'old');
    tryReserveAgentRun(PROJECT);
    attachAgentAbort(PROJECT, 'new', () => {});
    // A late release from the OLD turn must not free the NEW turn's slot.
    releaseAgentRun(PROJECT, 'old');
    expect(isAgentRunActive(PROJECT)).toBe(true);
    releaseAgentRun(PROJECT, 'new');
    expect(isAgentRunActive(PROJECT)).toBe(false);
  });

  it('interruptAgentRun reports nothing when idle', () => {
    expect(interruptAgentRun(PROJECT)).toEqual({ interrupted: false });
  });
});
