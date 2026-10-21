import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client";

export async function runMigrations(connectionString: string): Promise<void> {
  const handle = createDb(connectionString, { max: 1, applicationName: "flock-migrate" });
  try {
    const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
    await migrate(handle.db, { migrationsFolder });
  } finally {
    await handle.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  runMigrations(url)
    .then(() => {
      console.log("migrations applied");
    })
    .catch((err: unknown) => {
      console.error("migration failed", err);
      process.exit(1);
    });
}
