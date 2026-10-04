/** Optional global teardown: resets the DB once after the whole run (no-op without DB_DSN). */
import { DbSeeder } from "./data-seeding.js";

export default async function globalTeardown(): Promise<void> {
  const db = new DbSeeder();
  try {
    await db.reset();
  } finally {
    await db.close();
  }
}
