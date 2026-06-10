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
//   GET   /v1/self/profile             read the human's display name + the
//                                      resolved home template (the pinned
//                                      override, or null = pane default).
//   PATCH /v1/self/profile             update the human's display name and/or
//                                      pinned home template; `null`/empty
//                                      clears name (display falls back to the
//                                      email-local-part); `null` clears the
//                                      home-template pin (Home serves the
//                                      pane default).

import { Hono } from "hono";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { generateClaimCode, hashClaimCode } from "../../auth/claim.js";
import { generateApiKey, hashKey, keyPrefix } from "../../keys.js";
import { errors } from "../errors.js";
import { requireHuman, type HumanAuthEnv } from "../../auth/human-auth.js";
import { isPushEnabled } from "../../push.js";

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

// A template is usable as a human's pinned home template when it is live
// (not soft-deleted) AND the human has a relationship to it: they own it via
// one of their claimed agents, they have it installed (HumanTemplateInstall),
// or it is published to the store. These are exactly the template surfaces a
// human can reach from Home, so pinning is constrained to that set rather than
// any arbitrary id in the table.
async function isHomeTemplateUsable(
  prisma: PrismaClient,
  humanId: string,
  templateId: string,
): Promise<boolean> {
  const template = await prisma.template.findFirst({
    where: {
      id: templateId,
      deletedAt: null,
      OR: [
        // Published to the store — anyone can pin it.
        { publishedAt: { not: null } },
        // Owned via one of the human's claimed agents.
        { owner: { ownerHumanId: humanId, deletedAt: null } },
        // Installed by the human (and not later uninstalled).
        {
          installs: {
            some: { humanId, uninstalledAt: null },
          },
        },
      ],
    },
    select: { id: true },
  });
  return template !== null;
}

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

// PATCH /v1/self/agents/:id
// Body: { name: string }   Response: { agent_id, name }
//
// Rename an agent the human owns. Unlike Human.name (which is optional and
// clearable), Agent.name is required, so the body rejects empty/blank names.
// Trimmed, max 80 chars, no control characters — mirrors the human-profile
// name rules.
//
// Authz: requireHuman (above) + the agent must be claimed by THIS human; a
// 404 (not 403) is returned for an unclaimed-or-other-human agent so the route
// isn't an ownership oracle. Revoked agents can still be renamed — a label
// change doesn't reactivate the credential.
const renameAgentBody = z.object({
  name: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() : v),
    z
      .string()
      .min(1, "name must not be empty")
      .max(80)
      .refine((s) => !hasControlChar(s), {
        message: "name must not contain control characters",
      }),
  ),
});

self.patch("/agents/:id", async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");

  const parsed = renameAgentBody.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid agent rename",
      parsed.error.flatten(),
      "send { name: string } — trimmed, 1–80 chars, no control characters",
    );
  }

  const agent = await prisma.agent.findFirst({
    where: { id, ownerHumanId: human.id, deletedAt: null },
    select: { id: true },
  });
  if (!agent) throw errors.notFound();

  const updated = await prisma.agent.update({
    where: { id: agent.id },
    data: { name: parsed.data.name },
    select: { id: true, name: true },
  });

  return c.json({ agent_id: updated.id, name: updated.name });
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
// Body: { name?: string | null, home_template_id?: string | null }
// Response: { name, display_name, home_template_id }
//   - `name` is the stored value after the update: the trimmed string, or
//     `null` when cleared. An empty / whitespace-only string is normalised
//     to `null` (an explicit clear), so the display name falls back to the
//     email-local-part.
//   - `display_name` is what the UI shows: the stored name if non-empty,
//     else the friendlyName(email) fallback (shared with owner-shell-spa.ts).
//   - `home_template_id` is the human's pinned home template after the
//     update: a template id, or `null` when none is pinned (Home serves the
//     pane-default). See §5.2.
//
// Both fields are OPTIONAL and key-presence aware: a field that is *absent*
// from the body is left untouched, so a caller can patch `name` without
// disturbing `home_template_id` and vice-versa. An explicit `null` is a
// clear. Names are capped at 80 chars and may not contain control characters;
// `home_template_id`, when a string, must reference a template this human can
// use (owns via a claimed agent, has installed, or is published) — otherwise
// 404 template_not_found. Anything else 400s as invalid_request.
//
// `name` is parsed via `nameValue` only when the `name` key is present; the
// preprocess collapses empty/whitespace-only to `null` (an explicit clear)
// and accepts `null` as-is.
const nameValue = z.preprocess(
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
);

// `home_template_id`, when present: a non-empty string id or an explicit
// `null` (clear). Existence + usability of the id is checked against the DB
// in the handler (a bad id must 404, not hit the FK and 500).
const homeTemplateIdValue = z.union([z.string().min(1), z.null()]);

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
          ownerHumanId: true,
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
      // Whether the current human owns this pane — recents can include panes
      // the human only joined, so the Home card ⋯ menu shows Delete only when
      // this is true. We expose a boolean (not the owner id) to avoid leaking
      // who owns someone else's pane.
      owned: v.pane.ownerHumanId === human.id,
      template_id: v.pane.templateVersion.templateId,
      template_version_id: v.pane.templateVersion.id,
      last_viewed_at: v.lastViewedAt.toISOString(),
    })),
  });
});

// DELETE /v1/self/recents/:paneId
//
// "Hide from recents" — drops this human's view-ledger row for the pane so it
// no longer surfaces in the Home "Recently viewed" feed. The pane itself is
// untouched (this is not a delete), and opening it again re-records a view and
// brings it back. Available for any pane the human has viewed, owned or not.
//
// Idempotent: deleteMany returns count 0 when there's no row (already hidden /
// never viewed), so we always return 204 without leaking whether the pane id
// or view existed.
self.delete("/recents/:paneId", async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const paneId = c.req.param("paneId");
  if (!paneId) throw errors.invalidRequest("missing pane id");

  await prisma.humanPaneView.deleteMany({
    where: { humanId: human.id, paneId },
  });
  return c.body(null, 204);
});

// GET /v1/self/push-subscription/vapid-public-key
// Returns the VAPID public key the browser needs to subscribe. 404 when push
// is not configured (VAPID keys absent from env).
self.get("/push-subscription/vapid-public-key", (c) => {
  const config = c.get("config");
  if (!isPushEnabled(config)) throw errors.notFound();
  return c.json({ vapid_public_key: config.VAPID_PUBLIC_KEY });
});

const pushSubscriptionBody = z.object({
  endpoint: z.string().url().max(2048),
  p256dh: z.string().min(1).max(512),
  auth: z.string().min(1).max(128),
});

// POST /v1/self/push-subscriptions
// Upserts a browser push subscription for the logged-in human. Idempotent:
// re-submitting an existing endpoint updates the keys (the browser may rotate
// them). Returns 201 on first save, 200 on update.
self.post("/push-subscriptions", async (c) => {
  const config = c.get("config");
  if (!isPushEnabled(config)) throw errors.notFound();

  const prisma = c.get("prisma");
  const human = c.get("human");

  const parsed = pushSubscriptionBody.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid push subscription",
      parsed.error.flatten(),
      "send { endpoint, p256dh, auth } from PushSubscription.toJSON()",
    );
  }
  const { endpoint, p256dh, auth } = parsed.data;

  const existing = await prisma.pushSubscription.findUnique({
    where: { endpoint },
    select: { id: true, humanId: true },
  });

  if (existing) {
    if (existing.humanId !== human.id) {
      // Another human owns this endpoint — shouldn't happen in practice
      // (each browser generates a unique endpoint per app server key), but
      // treat it as a conflict and refuse rather than silently re-assign.
      throw errors.conflict("endpoint is registered to a different account");
    }
    await prisma.pushSubscription.update({
      where: { id: existing.id },
      data: { p256dh, auth },
    });
    return c.json({ saved: true }, 200);
  }

  await prisma.pushSubscription.create({
    data: { humanId: human.id, endpoint, p256dh, auth },
  });
  return c.json({ saved: true }, 201);
});

// DELETE /v1/self/push-subscriptions
// Removes a push subscription. Body: { endpoint }. Idempotent — a missing
// endpoint returns 204 with no error.
self.delete("/push-subscriptions", async (c) => {
  const config = c.get("config");
  if (!isPushEnabled(config)) throw errors.notFound();

  const prisma = c.get("prisma");
  const human = c.get("human");

  const body = (await c.req.json().catch(() => null)) as {
    endpoint?: unknown;
  } | null;
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : null;
  if (!endpoint) {
    throw errors.invalidRequest(
      "endpoint is required",
      undefined,
      "send { endpoint: string }",
    );
  }

  await prisma.pushSubscription.deleteMany({
    where: { humanId: human.id, endpoint },
  });
  return c.body(null, 204);
});

// GET /v1/self/profile
// Response: { name, display_name, home_template_id }
//   - `home_template_id` is the human's pinned home template, or `null` when
//     none is pinned (Home serves the pane-default `home` template). The
//     read-side counterpart to PATCH — lets the settings UI (and any agent)
//     observe whether the override is set or the default is in effect.
self.get("/profile", (c) => {
  const human = c.get("human");
  const name = human.name;
  const displayName =
    name && name.trim().length > 0 ? name : friendlyName(human.email);
  return c.json({
    name,
    display_name: displayName,
    home_template_id: human.homeTemplateId,
  });
});

self.patch("/profile", async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");

  const raw = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw errors.invalidRequest(
      "invalid profile update",
      undefined,
      "send a JSON object with optional { name, home_template_id } fields",
    );
  }

  // Key-presence aware: only fields actually present in the body are
  // touched. This lets a caller patch `name` without clobbering
  // `home_template_id` and vice-versa.
  const data: { name?: string | null; homeTemplateId?: string | null } = {};

  if ("name" in raw) {
    const parsed = nameValue.safeParse(raw.name);
    if (!parsed.success) {
      throw errors.invalidRequest(
        "invalid profile update",
        parsed.error.flatten(),
        "name is trimmed, max 80 chars, no control characters; an empty string or null clears it",
      );
    }
    data.name = parsed.data;
  }

  if ("home_template_id" in raw) {
    const parsed = homeTemplateIdValue.safeParse(raw.home_template_id);
    if (!parsed.success) {
      throw errors.invalidRequest(
        "invalid profile update",
        parsed.error.flatten(),
        "home_template_id must be a non-empty template id or null (to clear the pinned home template)",
      );
    }
    if (parsed.data === null) {
      // Clearing is always allowed — no existence check.
      data.homeTemplateId = null;
    } else {
      // Validate the template exists and is usable by this human BEFORE
      // setting, so a bad id returns a clean 404 instead of hitting the FK
      // and 500. "Usable" = the human owns it (via a claimed agent), has it
      // installed, or it is published — the same surfaces Home draws from.
      const usable = await isHomeTemplateUsable(prisma, human.id, parsed.data);
      if (!usable) throw errors.templateNotFound();
      data.homeTemplateId = parsed.data;
    }
  }

  // Re-read the human so the response reflects the post-update state even when
  // a field was omitted (left untouched). The update is a no-op when `data` is
  // empty, but we still re-read to echo back the current values.
  const updated =
    Object.keys(data).length > 0
      ? await prisma.human.update({ where: { id: human.id }, data })
      : human;

  const name = updated.name;
  const displayName =
    name && name.trim().length > 0 ? name : friendlyName(human.email);

  return c.json({
    name,
    display_name: displayName,
    home_template_id: updated.homeTemplateId,
  });
});

export default self;
