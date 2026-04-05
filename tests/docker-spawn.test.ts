import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDockerAvailable } from '../src/docker-spawn.js';

describe('Docker spawn', () => {
  it('isDockerAvailable returns a boolean', async () => {
    const result = await isDockerAvailable();
    assert.equal(typeof result, 'boolean');
    // We don't assert true/false — Docker may or may not be installed
  });

  it('isDockerAvailable is consistent on repeated calls', async () => {
    const a = await isDockerAvailable();
    const b = await isDockerAvailable();
    assert.equal(a, b, 'should return same value on repeated calls');
  });
});
