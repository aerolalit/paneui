<!-- pane skill v0.0.27 -->

# pane (MCP)

`pane` is a round-trip UI channel between agents and humans. You render an HTML
UI, the relay hands the human a URL, and the human's interactions come back to
you as structured events or record rows.

You are talking to pane over the **Model Context Protocol** — every operation
is an MCP **tool call**, not a `pane ...` shell command. The conceptual core
below (when to use pane, events vs records, schema design, the house style, the
round-trip mental model) is identical regardless of how you invoke it. This
section is the thin invocation layer: which tool to call for each step.

## The round trip, as tool calls

1. **`create_pane`** — author the UI and get a URL back. Pass inline HTML
   (`name` + `html`) for a one-off, or `template_id` to reuse a saved template.
   Returns `{ pane_id, url, urls, title, expires_at }`. **Give `url` to the
   human** over whatever channel you have.
2. Deliver the URL to the human.
3. **`get_events`** — poll the pane's event log for the human's response. MCP
   has no streaming, so this replaces the CLI's `pane watch`: call with no
   `since` first, remember `next_cursor`, then call again passing it as `since`.
   To wait for a human who hasn't acted yet, pass `wait_seconds` (~25) so the
   relay long-polls, then call again with the same cursor. A `_closed`/expiry
   means the human did not answer — not an answer.
4. Act on the event's `data`.

## Tool map (CLI command → MCP tool)

| You want to…                              | MCP tool call |
|-------------------------------------------|---------------|
| Start a pane                              | `create_pane` |
| Check a pane's status / expiry            | `get_pane_state` |
| Read the human's responses (was `watch`)  | `get_events` (long-poll with `wait_seconds`) |
| Push an event into a live pane            | `send_to_pane` |
| Edit instance fields (ttl/title/…)        | `update_pane` |
| Re-pin a pane to a new template version   | `upgrade_pane` |
| List your panes                           | `list_panes` |
| Close a pane                              | `delete_pane` |
| List / read / write / delete records      | `list_records`, `get_record`, `upsert_record`, `update_record`, `delete_record`, `delete_record_collection` |
| Manage reusable templates                 | `template` (action: create/version/update/search/list/show/get_version/delete/publish/unpublish/search_public/set_icon) |
| Template-level (shared) records           | `template_records` |
| Mint / list / revoke human URLs           | `participant` |
| Identity sharing (invite / access mode)   | `share` |
| Upload / download binary attachments      | `attachments` |
| Read / write the human's UI taste notes   | `taste` (action: get/set/clear) |
| Inspect / revoke your API key             | `key` |
| Restore / purge trashed panes + templates | `trash` |
| Product feedback to pane's maintainers    | `feedback` |
| Identity (whoami / claim / logout)        | `agent` |
| Read-only SQL over your data              | `run_query` |
| Re-read this guide / its version          | `get_skill` |

## Before you author — two cheap calls that improve every pane

- **`get_skill`** (this guide) — the events-vs-records decision, the schema
  grammar (`x-pane-events` / `x-pane-collections`), and the house style. You're
  reading it now; re-read the core below before designing a non-trivial pane.
- **`taste` (action: get)** — the human's recorded presentation preferences
  ("denser tables", "always dark"). They **override** the default house style.
  When the human gives presentation feedback, persist it with
  `taste` (action: set) — a whole-document replace, not an append.

## Search before you generate

Before writing template HTML, call **`template` (action: search)** with
keywords (or action: list) to see whether a suitable template already exists. A
previous run may have authored exactly the UI you need. If one fits, instance it
with `create_pane` + `template_id` instead of regenerating HTML. Only author
(`create_pane` with inline `html`, or `template` action: create for a reusable
one) when nothing fits.

## Watching for the human (no streaming in MCP)

There is no persistent `watch` over MCP. Two poll loops replace it:

- **Events** — `get_events` with `wait_seconds: 25`, re-called with the prior
  `next_cursor` as `since`. Stop when you see your terminal event type, or when
  the pane closes/expires (treat that as "no response", not an answer).
- **Records** — `list_records` with the prior `next_since`. Pass
  `include_tombstones: true` to observe deletions.

If you run under a harness that can launch a long-lived process (e.g. Claude
Code), prefer the `pane` CLI's `pane watch` for true streaming; over a pure MCP
transport, long-poll as above.

## Attachments, in brief

`attachments` (action: upload) reads an absolute `file_path`; action: download
writes to an absolute `out_path` or returns base64. To let a browser fetch
bytes without your API key, `attachments` (action: mint_token) returns a
`/b/<token>` URL — bake it into `input_data` or send it on an event, then point
an `<img src>` at it. See the attachment concepts in the core guide for the
events-reference-attachments pattern and the inline-bytes warning.

---

The rest of this document is the **transport-agnostic core** — the same
conceptual material the CLI skill carries, with the command grammar stripped.
Read it before authoring.
