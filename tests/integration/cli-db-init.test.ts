import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createTempStateDir } from '../helpers/state';

const ROOT = path.join(__dirname, '..', '..');
const TSX_BIN = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const CLI = path.join(ROOT, 'src', 'cli', 'index.ts');

function runCli(args: string[], stateDir: string) {
  return spawnSync(TSX_BIN, [CLI, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: stateDir,
      CLODDS_STATE_DIR: stateDir,
      LOG_LEVEL: 'error',
      NO_COLOR: '1',
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

// Regression coverage for the async sql.js proxy: CLI commands used to run
// migrations before the database finished initializing, which made migration
// 15 fail and left the process alive on an ACP heartbeat interval.
test('CLI initializes the database, applies migrations, and exits cleanly', async () => {
  const tempState = createTempStateDir('clodds-cli-db-');
  const previousStateDir = process.env.CLODDS_STATE_DIR;
  process.env.CLODDS_STATE_DIR = tempState.dir;

  try {
    // `pairing` uses the CLI's direct database path; `cron` uses the shared
    // withDb helper. Both previously hung after printing their output.
    for (const args of [
      ['pairing', 'list', 'telegram'],
      ['cron', 'list'],
    ]) {
      const label = `clodds ${args.join(' ')}`;
      const result = runCli(args, tempState.dir);

      assert.equal(result.error, undefined, `${label} failed to run: ${result.error?.message}`);
      assert.equal(result.signal, null, `${label} was killed by ${result.signal}\n${result.stderr}`);
      assert.equal(result.status, 0, `${label} exited with ${result.status}\n${result.stderr}`);
    }

    const { initDatabase, createDatabase } = await import('../../src/db/index.ts');
    const db = await initDatabase();

    assert.equal(
      createDatabase(),
      db,
      'createDatabase() should return the initialized instance instead of the async proxy'
    );

    const versions = db.query<{ version: number }>('SELECT version FROM _migrations ORDER BY version');
    assert.ok(
      versions.some((row) => row.version === 15),
      `expected migration 15 to be recorded, got: ${versions.map((row) => row.version).join(', ')}`
    );

    const messagesTable = db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'"
    );
    assert.equal(messagesTable.length, 1, 'migration 15 should create the messages table');

    db.close();
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.CLODDS_STATE_DIR;
    } else {
      process.env.CLODDS_STATE_DIR = previousStateDir;
    }
    tempState.cleanup();
  }
});
