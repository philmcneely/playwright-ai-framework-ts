/**
 * Data setup / teardown primitives — API seeding, DB seeding and entity cleanup.
 *
 * Everything is env-driven (no credentials in code) and inert when unconfigured:
 *   SEED_API_URL    base URL of the seeding API       (falls back to unset = disabled)
 *   SEED_API_TOKEN  optional bearer token
 *   DB_DSN          connection string (postgres:// supported via optional `pg`)
 *   DB_SETUP_SQL    optional path to a SQL file run by db.setup()
 *   DB_RESET_SQL    optional path to a SQL file run by db.reset()
 */
import { request, type APIRequestContext } from "@playwright/test";
import * as fs from "fs";

/** A created entity that must be deleted again, newest first. */
export type Cleanup = { label: string; fn: () => Promise<void> };

export class CleanupRegistry {
  private items: Cleanup[] = [];

  add(label: string, fn: () => Promise<void>): void {
    this.items.push({ label, fn });
  }

  get size(): number {
    return this.items.length;
  }

  /** Run all cleanups in reverse order; keep going on failure and return the errors. */
  async runAll(): Promise<string[]> {
    const errors: string[] = [];
    while (this.items.length) {
      const item = this.items.pop()!;
      try {
        await item.fn();
      } catch (e) {
        errors.push(`${item.label}: ${(e as Error).message}`);
      }
    }
    return errors;
  }
}

export function seedApiConfigured(): boolean {
  return Boolean(process.env.SEED_API_URL);
}

/** Thin wrapper over an APIRequestContext that records a cleanup for each create. */
export class ApiSeeder {
  constructor(
    readonly ctx: APIRequestContext,
    private readonly cleanup: CleanupRegistry,
  ) {}

  /** POST `data` to `path`; if `deletePath(body)` is given, DELETE it on teardown. */
  async create<T = unknown>(
    path: string,
    data: unknown,
    deletePath?: (created: T) => string,
  ): Promise<T> {
    const res = await this.ctx.post(path, { data });
    if (!res.ok()) throw new Error(`seed POST ${path} -> ${res.status()}`);
    const body = (await res.json()) as T;
    if (deletePath) {
      const target = deletePath(body);
      this.cleanup.add(`DELETE ${target}`, async () => {
        const r = await this.ctx.delete(target);
        if (!r.ok() && r.status() !== 404) throw new Error(`status ${r.status()}`);
      });
    }
    return body;
  }

  /** POST to a reset endpoint (e.g. /test/reset) to return the app to a known state. */
  async reset(path = process.env.SEED_API_RESET_PATH || "/reset"): Promise<void> {
    const res = await this.ctx.post(path);
    if (!res.ok()) throw new Error(`seed reset ${path} -> ${res.status()}`);
  }
}

export async function newSeedContext(): Promise<APIRequestContext> {
  const token = process.env.SEED_API_TOKEN;
  return request.newContext({
    baseURL: process.env.SEED_API_URL,
    extraHTTPHeaders: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

type SqlClient = { query(sql: string): Promise<unknown>; end(): Promise<void> };

/** DB seeding/reset via an env DSN. Every method is a no-op when DB_DSN is unset. */
export class DbSeeder {
  private client?: SqlClient;

  get enabled(): boolean {
    return Boolean(process.env.DB_DSN);
  }

  private async connect(): Promise<SqlClient | undefined> {
    if (!this.enabled) return undefined;
    if (this.client) return this.client;
    const dsn = process.env.DB_DSN!;
    if (!/^postgres(ql)?:\/\//.test(dsn)) {
      throw new Error("DB_DSN: only postgres:// is built in; extend DbSeeder for other drivers");
    }
    const mod = "pg"; // optional dependency, installed by the user: npm i -D pg
    const pg = (await import(mod)) as {
      default: { Client: new (o: { connectionString: string }) => SqlClient & { connect(): Promise<void> } };
    };
    const c = new pg.default.Client({ connectionString: dsn });
    await c.connect();
    this.client = c;
    return c;
  }

  async exec(sql: string): Promise<void> {
    const c = await this.connect();
    if (c) await c.query(sql);
  }

  private async runFile(envVar: string): Promise<void> {
    const file = process.env[envVar];
    if (file) await this.exec(fs.readFileSync(file, "utf8"));
  }

  setup(): Promise<void> {
    return this.runFile("DB_SETUP_SQL");
  }

  reset(): Promise<void> {
    return this.runFile("DB_RESET_SQL");
  }

  async close(): Promise<void> {
    await this.client?.end();
    this.client = undefined;
  }
}
