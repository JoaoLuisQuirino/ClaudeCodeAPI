import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';

describe('Cluster config', () => {
  it('availableParallelism returns a positive number', () => {
    const cpus = availableParallelism();
    assert.ok(cpus > 0, 'should have at least 1 CPU');
    assert.equal(typeof cpus, 'number');
  });

  it('worker count defaults to CPUs - 1', () => {
    const cpus = availableParallelism();
    const workers = Math.max(1, cpus - 1);
    assert.ok(workers >= 1);
    assert.ok(workers <= cpus);
  });

  it('slots divide evenly across workers', () => {
    const maxGlobal = 8;
    const numWorkers = 4;
    const perWorker = Math.max(1, Math.ceil(maxGlobal / numWorkers));
    assert.equal(perWorker, 2);
    // Total capacity >= global limit
    assert.ok(perWorker * numWorkers >= maxGlobal);
  });

  it('handles uneven division', () => {
    const maxGlobal = 10;
    const numWorkers = 3;
    const perWorker = Math.max(1, Math.ceil(maxGlobal / numWorkers));
    assert.equal(perWorker, 4); // ceil(10/3) = 4
    assert.ok(perWorker * numWorkers >= maxGlobal);
  });
});
