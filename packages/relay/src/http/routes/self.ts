// /v1/self/* — human-authenticated routes for the logged-in human's
// own account. Requires the pane_login cookie via requireHuman.
//
//   POST  /v1/self/claim-codes         mint a one-shot claim code; agent
//                                      submits it to POST /v1/agents/claim
//                                      to bind itself to this human (§6.1).
//   POST  /v1/self/agents/:id/rotate-key  rotate the API key on an agent
//                                      owned by this human. Old key is
//                                      invalidated (key_hash overwritten);
//                                      the new key is returned ONCE.
//   POST  /v1/self/agents/:id/revoke-key  revoke an owned agent's API key.
//                                      Sets revokedAt; the agent's existing
//                                      key 401s on the next request. Owner-
//                                      side counterpart to DELETE /v1/keys
//                                      (self-revoke).
//   PATCH /v1/self/profile             update the human's display name;
//                                      `null`/empty clears it (display falls
//                                      back to the email-local-part).

import { Hono } from "hono";
import { z } from "zod";
import { generateClaimCode, hashClaimCode } from "../../auth/claim.js";
import { generateApiKey, hashKey, keyPrefix } from "../../keys.js";
import { errors } from "../errors.js";
import { requireHuman, type HumanAuthEnv } from "../../auth/human-auth.js";

// The friendly display name derived from the email when the human hasn't
// set an explicit name. Kept byte-identical to owner-shell-spa.ts's
// friendlyName so the API and the SPA agree on the fallback.
function friendlyName(email: string): string {
  const local = (email.split("@")[0] ?? "").split(/[._-]/)[0] ?? "";
  if (local.length === 0) return "there";
  return local.charAt(0).toUpperCase() + local.slice(1);
}

const self = new Hono<HumanAuthEnv>();

self.use("*", requireHuman);

// POST /v1/self/claim-codes
// Body: {} (none yet)
// Response: { code, code_prefix, expires_at }
//   - `code` is the RAW one-shot code; returned ONCE here and never again.
//     The human copies it and hands it to the agent out-of-band.
//   - `code_prefix` is a short, non-secret correlator for log lookups.
//
// The TTL is config.MAGIC_LINK_TTL_SECONDS for symmetry with the magic-link
// flow (both are short-lived one-shot codes the human is mid-transferring).
self.post("/claim-codes", async (c) => {
  const config = c.get("config");
  const prisma = c.get("prisma");
  const human = c.get("human");

  const code = generateClaimCode();
  const codeHash = hashClaimCode(code);
  const expiresAt = new Date(Date.now() + config.MAGIC_LINK_TTL_SECONDS * 1000);

  await prisma.claimCode.create({
    data: {
      humanId: human.id,
      codeHash,
      expiresAt,
    },
  });

  return c.json(
    {
      code,
      code_prefix: keyPrefix(code),
      expires_at: expiresAt.toISOString(),
    },
    201,
  );
});

// POST /v1/self/agents/:id/rotate-key
// Body: {} (none)
// Response: { agent_id, name, api_key, key_prefix, rotated_at }
//   - `api_key` is the RAW new key; returned ONCE here and never stored
//     in plaintext. The human copies it into the agent's config.
//   - The previous key is invalidated atomically: we overwrite the
//     agent row's key_hash + key_prefix with the new hash, so any
//     subsequent agent-authenticated request with the old key 401s.
//
// Authz: requireHuman (above) + the agent must be claimed by THIS human.
// A 404 (not a 403) is returned for an unclaimed-or-other-human agent so
// the route isn't an "is agent X claimed by anyone" oracle.
//
// Revoked agents (revokedAt != null) are NOT rotatable — that's a
// distinct lifecycle state from "lost the key". Surface explicitly so the
// human gets a useful error instead of a fresh key on a revoked row.
self.post("/agents/:id/rotate-key", async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");

  const agent = await prisma.agent.findFirst({
    where: { id, ownerHumanId: human.id, deletedAt: null },
    select: { id: true, name: true, revokedAt: true },
  });
  if (!agent) throw errors.notFound();
  if (agent.revokedAt) {
    throw errors.invalidRequest(
      "agent is revoked — rotating the key would not re-activate it",
      undefined,
      "revocation is permanent; claim a fresh agent and retire this one",
    );
  }

  const apiKey = generateApiKey();
  const newKeyHash = hashKey(apiKey);
  const newKeyPrefix = keyPrefix(apiKey);

  await prisma.agent.update({
    where: { id: agent.id },
    data: { keyHash: newKeyHash, keyPrefix: newKeyPrefix },
  });

  return c.json(
    {
      agent_id: agent.id,
      name: agent.name,
      api_key: apiKey,
      key_prefix: newKeyPrefix,
      rotated_at: new Date().toISOString(),
    },
    201,
  );
});

// POST /v1/self/agents/:id/revoke-key
// Body: {} (none)
// Response: { agent_id, name, revoked_at }
//
// Owner-side counterpart to DELETE /v1/keys/:id (self-revoke). The agent
// itself doesn't need to participate — the human kills the credential from
// /my-agents, which matters when the key has leaked or the agent's machine
// is gone (the two cases self-revoke can't cover).
//
// Authz: requireHuman (above) + the agent must be claimed by THIS human.
// Mirrors rotate-key: a 404 (not 403) for an unclaimed-or-other-human
// agent so the route isn't an "is agent X claimed by anyone" oracle.
// Trashed agents (deletedAt != null) also 404 — they're already inert.
//
// Idempotency: a second revoke is a no-op and returns the existing
// revoked_at as success. UI race-clicks shouldn't surface as 4xx.
//
// Revocation is permanent — there is no /un-revoke route. Matches the
// agent-side `pane key revoke --yes` semantics.
//
// Note on live WebSockets: the WS path authenticates at connect time and
// does not re-check revokedAt, so an already-open socket keeps streaming
// until the client disconnects. HTTP is gated immediately. See
// docs/DESIGN-owner-side-revoke.md for the v1 trade-off.
self.post("/agents/:id/revoke-key", async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");

  const agent = await prisma.agent.findFirst({
    where: { id, ownerHumanId: human.id, deletedAt: null },
    select: { id: true, name: true, revokedAt: true },
  });
  if (!agent) throw errors.notFound();

  // Idempotent: if already revoked, return the existing timestamp. We
  // intentionally skip a 4xx here — the UI may race-click and the
  // operator-side outcome is identical either way.
  if (agent.revokedAt) {
    return c.json({
      agent_id: agent.id,
      name: agent.name,
      revoked_at: agent.revokedAt.toISOString(),
    });
  }

  const now = new Date();
  // Conditional update sweeps revokedAt = null so two concurrent revoke
  // requests can't fight over the timestamp; the loser sees the winner's
  // value on the re-read below.
  await prisma.agent.updateMany({
    where: { id: agent.id, revokedAt: null },
    data: { revokedAt: now },
  });
  const after = await prisma.agent.findUnique({
    where: { id: agent.id },
    select: { revokedAt: true },
  });

  return c.json({
    agent_id: agent.id,
    name: agent.name,
    revoked_at: (after?.revokedAt ?? now).toISOString(),
  });
});

// True if the string contains any C0/C1 control character
// (U+0000–U+001F, U+007F–U+009F). Implemented with charCodeAt rather than a
// regex literal so no raw control bytes need to live in this source file.
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

// PATCH /v1/self/profile
// Body: { name: string | null }
// Response: { name, display_name }
//   - `name` is the stored value after the update: the trimmed string, or
//     `null` when cleared. An empty / whitespace-only string is normalised
//     to `null` (an explicit clear), so the display name falls back to the
//     email-local-part.
//   - `display_name` is what the UI shows: the stored name if non-empty,
//     else the friendlyName(email) fallback (shared with owner-shell-spa.ts).
//
// `null` is allowed (explicit clear). Names are capped at 80 chars and may
// not contain control characters — anything else 400s as invalid_request.
const profileBody = z.object({
  // Trim first so a paste with surrounding whitespace normalises before
  // validation; an empty result becomes `null` (clear the name). `null`
  // is accepted as-is. Control characters are rejected.
  name: z.preprocess(
    (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v !== "string") return v;
      const t = v.trim();
      return t.length === 0 ? null : t;
    },
    z
      .string()
      .max(80)
      .refine((s) => !hasControlChar(s), {
        message: "name must not contain control characters",
      })
      .nullable(),
  ),
});

// GET /v1/self/recents
// Response: { items: [{ pane_id, title, template_id, template_version_id,
//                        last_viewed_at }] }
//
// Panes this human has opened (any mount: /panes/:id, /s/:token while logged
// in, /p/:paneId), newest lastViewedAt first. Backed by the HumanPaneView
// ledger — anonymous opens never write a row, so they never appear here.
//
// Soft-deleted panes are filtered out (a trashed pane shouldn't resurface in
// Recents); the view row stays so a restore re-surfaces it. Capped at a
// reasonable default so the response is always a single page.
const RECENTS_LIMIT = 50;

self.get("/recents", async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");

  const views = await prisma.humanPaneView.findMany({
    where: {
      humanId: human.id,
      pane: { deletedAt: null },
    },
    orderBy: { lastViewedAt: "desc" },
    take: RECENTS_LIMIT,
    select: {
      lastViewedAt: true,
      pane: {
        select: {
          id: true,
          title: true,
          accessMode: true,
          templateVersion: {
            select: { templateId: true, id: true },
          },
        },
      },
    },
  });

  return c.json({
    items: views.map((v) => ({
      pane_id: v.pane.id,
      title: v.pane.title,
      // Access mode (invite_only | link | public) — drives the visibility
      // icon on the Home "Recently viewed" cards.
      access_mode: v.pane.accessMode,
      template_id: v.pane.templateVersion.templateId,
      template_version_id: v.pane.templateVersion.id,
      last_viewed_at: v.lastViewedAt.toISOString(),
    })),
  });
});

self.patch("/profile", async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");

  const parsed = profileBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid profile update",
      parsed.error.flatten(),
      "send { name: string | null } — name is trimmed, max 80 chars, no control characters; an empty string clears it",
    );
  }
  const name = parsed.data.name;

  await prisma.human.update({
    where: { id: human.id },
    data: { name },
  });

  const displayName =
    name && name.trim().length > 0 ? name : friendlyName(human.email);

  return c.json({ name, display_name: displayName });
});

export default self;
