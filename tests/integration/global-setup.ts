import pg from "pg";
import { runMigrations } from "../../packages/db/src/migrate";
import { TEST_ENV } from "./env";

/** Fresh database per test run. */
export default async function setup() {
  const url = new URL(TEST_ENV.DATABASE_URL);
  const dbName = url.pathname.slice(1);
  const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: "/postgres" }).toString() });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [dbName]);
  await admin.query(`drop database if exists "${dbName}"`);
  await admin.query(`create database "${dbName}"`);
  await admin.end();
  await runMigrations(TEST_ENV.DATABASE_URL);
}
