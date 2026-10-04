/**
 * Optional global setup/teardown, wired in playwright.config.ts.
 * Runs the DB setup/reset once per run and (if configured) resets the seed API.
 * Both are no-ops when the corresponding env vars are unset.
 */
import { DbSeeder, ApiSeeder, CleanupRegistry, newSeedContext, seedApiConfigured } from "./data-seeding.js";

export default async function globalSetup(): Promise<void> {
  const db = new DbSeeder();
  try {
    await db.setup();
  } finally {
    await db.close();
  }
  if (seedApiConfigured() && process.env.SEED_API_RESET_ON_START === "true") {
    const ctx = await newSeedContext();
    try {
      await new ApiSeeder(ctx, new CleanupRegistry()).reset();
    } finally {
      await ctx.dispose();
    }
  }
}
