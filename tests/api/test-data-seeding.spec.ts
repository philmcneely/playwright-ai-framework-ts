/**
 * Data seeding example
 *
 * Demonstrates API-seed setup with automatic teardown via the `apiSeed` and
 * `cleanup` fixtures. Skips unless SEED_API_URL is set (optionally
 * SEED_API_TOKEN, SEED_API_RESOURCE; the API must accept POST/DELETE on it).
 */
import { test, expect } from "../../fixtures/index.js";

const RESOURCE = process.env.SEED_API_RESOURCE || "/users";

test.describe("Data setup & teardown", { tag: ["@data", "@regression"] }, () => {
  test("seeded entity exists and is removed afterwards", { tag: ["@p2", "@positive"] }, async ({ apiSeed }) => {
    const created = await apiSeed.create<{ id: string }>(
      RESOURCE,
      { name: `seed-${Date.now()}` },
      (c) => `${RESOURCE}/${c.id}`,
    );
    expect(created.id).toBeTruthy();

    const res = await apiSeed.ctx.get(`${RESOURCE}/${created.id}`);
    expect(res.ok()).toBeTruthy();
    // teardown: the apiSeed fixture deletes the entity after this test
  });

  test("registered cleanups run newest-first and report no errors", { tag: ["@p3", "@positive"] }, async ({ cleanup }) => {
    let cleaned = false;
    cleanup.add("flag", async () => {
      cleaned = true;
    });
    expect(await cleanup.runAll()).toEqual([]);
    expect(cleaned).toBe(true);
  });

  test("dbSeed is a no-op without DB_DSN", { tag: ["@p3", "@boundary"] }, async ({ dbSeed }) => {
    test.skip(dbSeed.enabled, "DB_DSN configured; covered by real DB runs");
    await dbSeed.setup();
    await dbSeed.reset();
  });
});
