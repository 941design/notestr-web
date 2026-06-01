import { describe, it, expect, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import { prepareServers } from '../global-setup';

/**
 * Regression test for the e2e harness port-3100 ordering bug.
 *
 * The defect: `assertPortFree(3100)` ran AFTER all three bunkers were already
 * spawned. When the port was busy, setup threw — but three live, untracked
 * `bunker.mjs` processes had already been started, and `.state.json` was never
 * written, so teardown had no PIDs to clean up. The bunkers leaked, each
 * holding a NIP-46 subscription on the relay and starving the next run.
 *
 * The fix moves the port check to the front of `prepareServers`, so a busy
 * port aborts with zero spawned children and no state file.
 *
 * These tests inject fakes for every spawn/IO dependency, so they run under
 * vitest without a relay, a build, or any real child process.
 */
describe('prepareServers — port check ordering', () => {
  const fakeServeProc = () =>
    ({ pid: 2000, unref: () => {}, on: () => fakeServeProc() }) as unknown as ChildProcess;

  function makeDeps() {
    const spawnBunker = vi.fn(
      async (): Promise<ChildProcess> => ({ pid: 1000 + spawnBunker.mock.calls.length }) as ChildProcess,
    );
    const spawnServe = vi.fn(() => fakeServeProc());
    const waitForHttp = vi.fn(async () => {});
    const writeState = vi.fn();
    const writeKeys = vi.fn();
    return { spawnBunker, spawnServe, waitForHttp, writeState, writeKeys };
  }

  it('aborts with ZERO bunker spawns and no state write when port 3100 is busy', async () => {
    const fakes = makeDeps();
    const assertPortFree = vi.fn(async (port: number) => {
      throw new Error(`[setup] Port ${port} is already in use (PID(s): 9999).`);
    });

    await expect(
      prepareServers({ ...fakes, assertPortFree }),
    ).rejects.toThrow(/Port 3100 is already in use/);

    // The bug: bunkers were spawned BEFORE the port check, so on a busy port
    // these counts were 3 and the children leaked. After the fix they are 0.
    expect(fakes.spawnBunker).not.toHaveBeenCalled();
    expect(fakes.spawnServe).not.toHaveBeenCalled();
    // No state file written → teardown has nothing to (fail to) clean up.
    expect(fakes.writeState).not.toHaveBeenCalled();
  });

  it('port check runs before any bunker spawn on the happy path', async () => {
    const fakes = makeDeps();
    const order: string[] = [];
    const assertPortFree = vi.fn(async () => {
      order.push('portCheck');
    });
    fakes.spawnBunker.mockImplementation(async () => {
      order.push('bunker');
      return { pid: 1000 + fakes.spawnBunker.mock.calls.length } as ChildProcess;
    });
    fakes.spawnServe.mockImplementation(() => {
      order.push('serve');
      return fakeServeProc();
    });

    const state = await prepareServers({ ...fakes, assertPortFree });

    expect(order[0]).toBe('portCheck');
    expect(order.indexOf('portCheck')).toBeLessThan(order.indexOf('bunker'));
    expect(fakes.spawnBunker).toHaveBeenCalledTimes(3);
    expect(fakes.spawnServe).toHaveBeenCalledTimes(1);
    expect(fakes.writeState).toHaveBeenCalledTimes(1);
    expect(state).toEqual({
      bunkerPid: 1001,
      bunkerBPid: 1002,
      bunkerCPid: 1003,
      servePid: 2000,
    });
  });

  it('writes .state.json only after all four processes are live', async () => {
    const fakes = makeDeps();
    const assertPortFree = vi.fn(async () => {});
    // Bunker C fails to come up — setup should abort with no state written.
    fakes.spawnBunker
      .mockResolvedValueOnce({ pid: 1001 } as ChildProcess)
      .mockResolvedValueOnce({ pid: 1002 } as ChildProcess)
      .mockRejectedValueOnce(new Error('bunker C never became Ready'));

    await expect(
      prepareServers({ ...fakes, assertPortFree }),
    ).rejects.toThrow(/bunker C never became Ready/);

    expect(fakes.writeState).not.toHaveBeenCalled();
  });
});
