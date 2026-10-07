---
name: wecom-forwarded-chat-resources
description: Fetch the online resources listed in a WeCom forwarded-chat archive. Load this Skill whenever the host injects a `<wecom_forwarded_chat_online_resources>` block, or whenever a WeCom / WeChat forwarded-chat transcript contains `[文档]` `[微盘文件]` `[日程]` `[待办]` `[会议]` `[智能纪要]` entries carrying an id. It owns the resource-type routing, the host-managed WeCom authorization wait, and the per-entry fetch accounting. It does not summarize the chat itself.
description_en: Fetch the online resources listed in a WeCom forwarded-chat archive. Load this Skill whenever the host injects a <wecom_forwarded_chat_online_resources> block, or whenever a WeCom / WeChat forwarded-chat transcript contains document, WeDrive file, calendar, todo, meeting, or meeting-minutes entries carrying an id. It owns the resource-type routing, the host-managed WeCom authorization wait, and the per-entry fetch accounting. It does not summarize the chat itself.
author: WorkBuddy
version: "0.1.0"
---

# WeCom forwarded-chat online resources

A WeCom forwarded-chat archive mixes two kinds of payload:

- **Offline attachments** — images, videos and documents that physically exist in the archive. Read them locally from the pre-extracted directory. Not this Skill's job.
- **Online references** — entries that exist in the transcript only as a type label plus an id. They must be fetched over the network through the WeCom connector. **This Skill owns them.**

The host lists every online reference it found in a `<wecom_forwarded_chat_online_resources>` block, one `<resource type="..." id="..." skill="..." label="..." />` per entry. That list is authoritative: do not re-derive it from the transcript, and do not drop entries from it.

## Routing

| Transcript entry | id field | Fetch with |
|---|---|---|
| `[文档]` | `doc_id` | `wecomcli-doc` |
| `[微盘文件]` | `file_id` | `wecomcli-disk` |
| `[日程]` | `schedule_id` | `wecomcli-calendar` |
| `[待办]` | `todo_id` | `wecomcli-todo` |
| `[会议]` | `meeting_id` | `wecomcli-meeting` |
| `[智能纪要]` | `meeting_id` (+ `meet_code` when present) | `wecomcli-meeting` |

Each `<resource>` already carries the resolved `skill` name — use it. Load that business Skill and read its parameter documentation before calling `wecom-cli`; this Skill deliberately does not restate their command arguments.

## Step 1 — Authorization is host-managed

WorkBuddy owns the WeCom authorization UI. Your first `wecom-cli` invocation is what tells the host that this turn needs the connector, and the host then shows the authorization QR dialog inside WorkBuddy.

Start with the status probe, before any business command:

```bash
wecom-cli auth show --status
```

- `authorized` → go to Step 2.
- `unauthorized` → the host is now showing the authorization dialog. Wait for the user, by polling:

```bash
sleep 10 && wecom-cli auth show --status
```

Poll until it reports `authorized`, or for at most about 3 minutes. Tell the user once, in one short sentence, that you are waiting for them to authorize WeCom in the dialog — do not repeat it on every poll.

- Still `unauthorized` when the wait is over → treat it as **declined**. Go to Step 4.

**Never run `wecom-cli auth init`** (in any form, interactive or not). It prints its own link and QR code and can open an external browser, which duplicates and competes with the WorkBuddy dialog the user is already looking at. Authorization is the host's surface; your only auth command is the read-only `wecom-cli auth show --status`.

Do not paste an authorization link or QR text into your reply, and do not ask the user to authorize anywhere other than the WorkBuddy dialog.

## Step 2 — Fetch every listed entry

Work through the `<resource>` list in order. For each entry, fetch by its id through the routed Skill.

- Fetch every entry before you write the summary. An online entry is required source material, not an optional reference.
- Never describe, characterize or summarize an entry you have not fetched. Do not infer its content from the `label`.
- If one fetch fails, retry that entry once. If it fails again, keep going with the remaining entries and record it as missing.
- If a fetch reports unauthorized mid-way (for example the credential expired), return to Step 1 once, then resume where you stopped.

## Step 3 — Report

Fold the fetched content into your answer as part of the chat summary, not as a separate machine report. Then, only if something is missing, add one short line naming the entries you could not fetch and why.

Do not call the archive fully summarized while any listed entry is unfetched.

## Step 4 — Declined or unavailable

When the user declines authorization, or the wait times out:

- Do not retry, and do not ask for authorization again in this turn.
- Summarize what the archive itself contains — the transcript and the offline attachments.
- State plainly that the online entries were skipped because WeCom was not authorized, referring to them by their readable `label`.

## Output constraints

`wecomcli-shared` defines the shared output rules, including the ban on exposing id fields; they apply here and outrank anything in this section. Refer to entries by their readable `label`, subject, title or time — never by `doc_id` / `file_id` / `schedule_id` / `todo_id` / `meeting_id`.
