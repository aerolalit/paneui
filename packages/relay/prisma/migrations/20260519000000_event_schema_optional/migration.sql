-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_artifact_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "artifact_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "artifact_type" TEXT NOT NULL,
    "artifact_source" TEXT NOT NULL,
    "event_schema" JSONB,
    "input_schema" JSONB,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "artifact_versions_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_artifact_versions" ("artifact_id", "artifact_source", "artifact_type", "created_at", "event_schema", "id", "input_schema", "version") SELECT "artifact_id", "artifact_source", "artifact_type", "created_at", "event_schema", "id", "input_schema", "version" FROM "artifact_versions";
DROP TABLE "artifact_versions";
ALTER TABLE "new_artifact_versions" RENAME TO "artifact_versions";
CREATE INDEX "artifact_versions_artifact_id_idx" ON "artifact_versions"("artifact_id");
CREATE UNIQUE INDEX "artifact_versions_artifact_id_version_key" ON "artifact_versions"("artifact_id", "version");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

