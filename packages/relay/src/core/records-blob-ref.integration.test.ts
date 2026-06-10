// #505 (A) — write-side attachment-ref access gate for records.
//
// Records and template-records register the `pane-attachment-id` format, so a
// record's `data` may legitimately carry attachment references. Before this fix
// the four record writers (writeRecord / updateRecord / writeTemplateRecord /
// updateTemplateRecord) never ran the access gate that events
// (core/events.ts:188-194) and pane-create input_data run, so an
// attachment_id owned by another agent (or dangling / soft-deleted) could be
// planted into a record with zero write-time check.
//
// These tests prove the gate now fires: a foreign / non-owned attachment_id is
// rejected at write time with attachment_ref_not_accessible, while an
// agent-owned attachment is accepted.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../test-helpers/db.js";
import { createPrismaClient } from "../db.js";
import { ApiError } from "../http/errors.js";
import {
  updateRecord,
  writeRecord,
  type PaneWithRecordSchema,
} from "./records.js";
import {
  updateTemplateRecord,
  writeTemplateRecord,
  type TemplateWithSchema,
} from "./template-records.js";
import type { Author } from "../types.js";

let testDb: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (testDb) await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.truncateAll(prisma);
});

// A record schema whose `Asset` row carries an attachment_id at the top level
// AND one nested under a 2020-12 `prefixItems` tuple — the latter proving the
// #504 walker fix is load-bearing for the #505 gate.
const RECORD_SCHEMA_WITH_BLOB = {
  $defs: {
    Asset: {
      type: "object",
      properties: {
        attachment_id: { type: "string", format: "pane-attachment-id" },
        slots: {
          type: "array",
          prefixItems: [{ type: "string", format: "pane-attachment-id" }],
        },
      },
    },
  },
  "x-pane-collections": {
    assets: {
      schema: { $ref: "#/$defs/Asset" },
      write: ["agent", "page"],
      delete: ["agent"],
    },
  },
};

async function seedAgent(): Promise<string> {
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: randomBytes(32).toString("hex"),
      keyPrefix: "pane_test",
    },
  });
  return agent.id;
}

async function seedAttachment(ownerId: string): Promise<string> {
  const att = await prisma.attachment.create({
    data: {
      ownerId,
      scope: "agent",
      mime: "image/png",
      size: 1,
      sha256: randomBytes(16).toString("hex"),
      storageKey: `att_${randomBytes(8).toString("hex")}`,
      status: "ready",
    },
  });
  return att.id;
}

async function seedPane(agentId: string): Promise<PaneWithRecordSchema> {
  const template = await prisma.template.create({
    data: { ownerId: agentId, name: "Blob Ref Test", latestVersion: 1 },
  });
  const version = await prisma.templateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<html></html>",
      recordSchema: RECORD_SCHEMA_WITH_BLOB,
    },
  });
  const pane = await prisma.pane.create({
    data: {
      id: `pan_${randomBytes(8).toString("hex")}`,
      agentId,
      templateVersionId: version.id,
      title: "blob ref test pane",
      expiresAt: new Date(Date.now() + 3600_000),
    },
    include: { templateVersion: true },
  });
  return pane as PaneWithRecordSchema;
}

async function seedTemplate(ownerId: string): Promise<TemplateWithSchema> {
  const template = await prisma.template.create({
    data: { ownerId, name: "TRec Blob Ref Test", latestVersion: 1 },
  });
  const version = await prisma.templateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<html></html>",
      templateRecordSchema: RECORD_SCHEMA_WITH_BLOB,
    },
  });
  return { ...template, latestVersionRow: version } as TemplateWithSchema;
}

describe("writeRecord — attachment-ref access gate (#505 A)", () => {
  it("accepts a record referencing an attachment the pane's agent owns", async () => {
    const agentId = await seedAgent();
    const attachmentId = await seedAttachment(agentId);
    const pane = await seedPane(agentId);
    const author: Author = { kind: "agent", id: agentId };

    const r = await writeRecord({ prisma }, pane, author, {
      collectionName: "assets",
      recordKey: "asset_ok",
      data: { attachment_id: attachmentId },
    });
    expect(r.record.data).toEqual({ attachment_id: attachmentId });
  });

  it("rejects a record referencing a foreign agent's attachment (top-level ref)", async () => {
    const ownerAgentId = await seedAgent();
    const foreignAgentId = await seedAgent();
    const foreignAttachmentId = await seedAttachment(foreignAgentId);
    const pane = await seedPane(ownerAgentId);
    const author: Author = { kind: "agent", id: ownerAgentId };

    await expect(
      writeRecord({ prisma }, pane, author, {
        collectionName: "assets",
        recordKey: "asset_bad",
        data: { attachment_id: foreignAttachmentId },
      }),
    ).rejects.toMatchObject({ code: "attachment_ref_not_accessible" });
  });

  it("rejects a foreign attachment hidden under prefixItems (proves #504 walker fix is load-bearing)", async () => {
    const ownerAgentId = await seedAgent();
    const foreignAgentId = await seedAgent();
    const foreignAttachmentId = await seedAttachment(foreignAgentId);
    const pane = await seedPane(ownerAgentId);
    const author: Author = { kind: "agent", id: ownerAgentId };

    let thrown: unknown;
    try {
      await writeRecord({ prisma }, pane, author, {
        collectionName: "assets",
        recordKey: "asset_prefix_bad",
        data: { slots: [foreignAttachmentId] },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).code).toBe("attachment_ref_not_accessible");
    expect((thrown as ApiError).status).toBe(422);
    // The row must NOT have been persisted.
    const col = await prisma.recordCollection.findFirst({
      where: { paneId: pane.id, name: "assets" },
    });
    expect(col).toBeNull();
  });

  it("rejects a soft-deleted attachment", async () => {
    const agentId = await seedAgent();
    const attachmentId = await seedAttachment(agentId);
    await prisma.attachment.update({
      where: { id: attachmentId },
      data: { deletedAt: new Date(), status: "deleted" },
    });
    const pane = await seedPane(agentId);
    const author: Author = { kind: "agent", id: agentId };

    await expect(
      writeRecord({ prisma }, pane, author, {
        collectionName: "assets",
        recordKey: "asset_deleted",
        data: { attachment_id: attachmentId },
      }),
    ).rejects.toMatchObject({ code: "attachment_ref_not_accessible" });
  });

  it("page (human participant) cannot plant a foreign attachment into a shared collection", async () => {
    const ownerAgentId = await seedAgent();
    const foreignAgentId = await seedAgent();
    const foreignAttachmentId = await seedAttachment(foreignAgentId);
    const pane = await seedPane(ownerAgentId);
    const pageAuthor: Author = { kind: "human", id: "h_evil" };

    await expect(
      writeRecord({ prisma }, pane, pageAuthor, {
        collectionName: "assets",
        recordKey: "asset_page_bad",
        data: { attachment_id: foreignAttachmentId },
      }),
    ).rejects.toMatchObject({ code: "attachment_ref_not_accessible" });
  });
});

describe("updateRecord — attachment-ref access gate (#505 A)", () => {
  it("rejects a PATCH that introduces a foreign attachment ref", async () => {
    const ownerAgentId = await seedAgent();
    const ownedAttachmentId = await seedAttachment(ownerAgentId);
    const foreignAgentId = await seedAgent();
    const foreignAttachmentId = await seedAttachment(foreignAgentId);
    const pane = await seedPane(ownerAgentId);
    const author: Author = { kind: "agent", id: ownerAgentId };

    // Create with a valid (owned) ref first.
    const created = await writeRecord({ prisma }, pane, author, {
      collectionName: "assets",
      recordKey: "asset_patch",
      data: { attachment_id: ownedAttachmentId },
    });

    // PATCH swaps in a foreign ref → rejected.
    await expect(
      updateRecord({ prisma }, pane, author, {
        collectionName: "assets",
        recordKey: "asset_patch",
        data: { attachment_id: foreignAttachmentId },
        ifMatch: created.record.version,
      }),
    ).rejects.toMatchObject({ code: "attachment_ref_not_accessible" });
  });
});

describe("template-records — attachment-ref access gate (#505 A)", () => {
  it("rejects a template record referencing a foreign agent's attachment", async () => {
    const ownerAgentId = await seedAgent();
    const foreignAgentId = await seedAgent();
    const foreignAttachmentId = await seedAttachment(foreignAgentId);
    const template = await seedTemplate(ownerAgentId);
    const author: Author = { kind: "agent", id: ownerAgentId };

    await expect(
      writeTemplateRecord({ prisma }, template, author, {
        collectionName: "assets",
        recordKey: "trec_bad",
        data: { attachment_id: foreignAttachmentId },
      }),
    ).rejects.toMatchObject({ code: "attachment_ref_not_accessible" });
  });

  it("accepts a template record referencing an owner-owned attachment", async () => {
    const ownerAgentId = await seedAgent();
    const attachmentId = await seedAttachment(ownerAgentId);
    const template = await seedTemplate(ownerAgentId);
    const author: Author = { kind: "agent", id: ownerAgentId };

    const r = await writeTemplateRecord({ prisma }, template, author, {
      collectionName: "assets",
      recordKey: "trec_ok",
      data: { attachment_id: attachmentId },
    });
    expect(r.record.data).toEqual({ attachment_id: attachmentId });
  });

  it("rejects a template-record PATCH introducing a foreign ref", async () => {
    const ownerAgentId = await seedAgent();
    const ownedAttachmentId = await seedAttachment(ownerAgentId);
    const foreignAgentId = await seedAgent();
    const foreignAttachmentId = await seedAttachment(foreignAgentId);
    const template = await seedTemplate(ownerAgentId);
    const author: Author = { kind: "agent", id: ownerAgentId };

    const created = await writeTemplateRecord({ prisma }, template, author, {
      collectionName: "assets",
      recordKey: "trec_patch",
      data: { attachment_id: ownedAttachmentId },
    });

    await expect(
      updateTemplateRecord({ prisma }, template, author, {
        collectionName: "assets",
        recordKey: "trec_patch",
        data: { attachment_id: foreignAttachmentId },
        ifMatch: created.record.version,
      }),
    ).rejects.toMatchObject({ code: "attachment_ref_not_accessible" });
  });
});
