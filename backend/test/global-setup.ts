import { dropTestDb } from './helpers';

// Per-file beforeAll hooks already drop+recreate the run's database on every reset; this only
// needs to drop it once after the whole suite finishes so a unique TEST_DB_NAME (concurrent
// agents, concurrent CI jobs) doesn't leave an orphan database behind.
export async function teardown(): Promise<void> {
  await dropTestDb();
}
