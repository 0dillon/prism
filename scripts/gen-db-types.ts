import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDb } from "../src/tests/sql/harness";
import { generateDatabaseTypes } from "./db-types-generator";

export const OUTPUT_PATH = join(process.cwd(), "src", "lib", "supabase", "database.types.ts");

async function main() {
  const db = await createDb();
  try {
    const output = await generateDatabaseTypes(db);
    writeFileSync(OUTPUT_PATH, output, "utf8");
    console.log(`Wrote ${OUTPUT_PATH}`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
