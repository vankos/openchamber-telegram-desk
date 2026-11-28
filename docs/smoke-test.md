# Real-token smoke test

Use this checklist once after installing the extension. It exercises real Telegram, real
OpenChamber and real OpenCode. Keep the bot token out of chat: put it only in the integration
settings or in a local environment variable for the small script.

## 0. Prerequisites

- OpenChamber `>= 2.7.0` with the extension installed and approved.
- The **local service** approved. The approval dialog lists service, network, transcript,
  session control, session answers and OpenCode reads.
- A bot token from @BotFather.
- The token saved in **Settings → Integrations → Telegram Desk → Bot token used by the
  service**. Do not use the API token/Connect controls.
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` available locally for the connectivity script
  (optional but useful).

Quick API check:

```powershell
$env:TELEGRAM_BOT_TOKEN="<local token>"
$env:TELEGRAM_CHAT_ID="<numeric chat id>"
npm run smoke:telegram
```

Expected: the bot username printed, one message delivered, no token in the output.

## 1. Pair

1. Open the Telegram Desk rail panel.
2. Confirm the header says **connected** and shows `@your_bot`.
3. Press **Create pairing code** and copy the code.
4. In a private chat with the bot send `/start ABCD-2345`.
5. Expected: “Paired.”; the panel allowlist shows the chat with a `paired` tag and an
   `events` tag (the primary chat).
6. Send `/help`; expected: the command list.
7. Press **Send test message**; expected: one test card in Telegram.

### Telegram lead

1. Open the panel's **Telegram lead** card. Expected: the session picker lists the sessions
   from `/sessions`, and the card says no lead is set.
2. Select the session you want to drive and press **Use as Telegram lead**. Expected: the
   card and `/status.lead` show that title and id.
3. Send `/status` and `/sessions`; expected: only the lead is listed.
4. Finish a turn in another top-level session; expected: no Telegram notice, and the
   panel's ignored count grows.
5. Send `/new test task`; expected: a refusal that names the lead and points to `/send`.
6. Send `/send hello`; expected: “Sent to …” for the lead.
7. Delete or archive the lead in OpenChamber; expected: its open cards close, a notice
   “Telegram lead removed … Choose a new lead” arrives, and further events from other
   sessions stay silent. The panel shows the lead as paused.
8. Choose another session; expected: delivery resumes for it only.
9. Restart OpenChamber; expected: a lead that still exists survives the restart with no
   startup notice and stays active.
10. Pause the extension (or stop OpenChamber), delete or archive the current lead while the
    service is not running, then resume/start it. Expected: after startup the panel shows
    delivery paused, and exactly one notice arrives — “deleted or archived while the service
    was offline” for a deletion, “archived while the service was offline” for an archived
    session — telling you to choose a new lead. Nothing is selected automatically.
11. Restart again; expected: the paused state stays and no second notice arrives.

## 2. Question

1. Open a session in OpenChamber.
2. Ask the agent for a question with two options, for example:
   “Ask me which branch to use, with two choices: main and dev, then wait.”
3. Expected: a Telegram card titled with the session and the form title, with `main`,
   `dev` and `Dismiss` buttons.
4. Press `dev`.
5. Expected: the card edits to “Answer sent to OpenChamber”; the OpenChamber form shows the
   answer and the session continues.
6. Press the same button again. Expected: no second answer (already handled / card closed).

### Multi-field form

If your agent can ask a two-field form (a choice plus a text field):

1. Press the choice; expected: the card shows a ✓ for the choice.
2. Reply to the card with the text value; expected: the card updates.
3. Expected: a **Submit answer** button; press it.
4. Expected: the card edits to the submitted summary and the session continues.

### Page question

If the agent opens an answerable page:

1. Expected: a notice that pages cannot be answered from a service.
2. Reply to the notice with a sentence; expected: the text reaches the session via
   `sessions.send`, which closes the page and continues the turn.

## 3. Permission

1. Trigger a tool that needs approval, for example ask the agent to run a harmless command
   with the permission policy set to ask.
2. Expected: a permission card with **Allow once** and **Deny** only.
3. Press **Allow once**.
4. Expected: the card edits, the tool runs in OpenChamber, and the turn continues.
5. Repeat and press **Deny**; expected: the agent receives the refusal.
6. Answer the same request in OpenChamber first, then press the stale Telegram button.
   Expected: the card says the request was already settled; no second answer.

### Session deletion

1. Use a disposable session with an open question or permission card, then delete it in
   OpenChamber.
2. Expected: the session disappears from `/sessions` immediately, and the card edits to
   “The session was deleted in OpenChamber.”
3. Press the old button. Expected: no answer is sent and the host is not called.
4. Reply to the old card. Expected: a clear “Session not found” error; the text is not
   routed to another session.

## 4. Turn notifications

1. Keep the default `all` mode and let any top-level session finish.
2. Expected: the agent's full reply, not an excerpt. A reply that fits arrives as one rich
   message with its Markdown rendered (bold, code, links, tables); the full text is present.
3. Ask the agent for a reply longer than 4,000 characters. Expected: several messages, each
   mapped to the session; the last one carries the reply hint. Reply to any part with a
   follow-up; expected: the text reaches the session.
4. Switch to `active`, send `/send <session> continue` from Telegram so the session
   becomes active, finish it, and confirm the notice still arrives.
5. Check the 20-second per-session cooldown: two quick finished events should not produce
   two messages.
6. Switch the panel mode to `off`; finish another turn; expected: no message. `/digest`
   still records the event.
7. Switch to `all`; finish a session that was never touched from Telegram; expected: a
   notice.

## 5. Commands

- `/new summarize the open TODOs` — expected: “New session started” with its id and project;
  the task starts running in OpenChamber and a finish notice arrives. Reply to the
  confirmation with a follow-up; expected: it reaches the new session.
- `/new` without a task — expected: the usage line; no session starts.
- `/new` when no session or project is known — expected: the reply asks to open a project in
  OpenChamber first; no session starts.
- `/status` — expected: counts plus waiting/busy/idle lines with session IDs.
- `/sessions` — expected: numbered sessions. Then `/send 1 hello` sends “hello” to that
  session.
- `/send <id-prefix> another message` — expected: “Sent to …”.
- `/stop 1` — expected: “Stopped …” when it was running, or “Nothing was running”.
- `/digest` — expected: busy/waiting/idle counts, pending answers and recent turns.
- `/unpair` in a paired private chat — expected: removed from paired chats; if the settings
  allowlist still contains the ID, the response says it is still allowed.

## 6. Authorization and isolation

1. From a different Telegram account, send `/status` to the bot.
   Expected: no reply (unless that account also has a valid pairing code).
2. From that account, try a forwarded inline button. Expected: “Not allowed”; the session
   does not receive an answer.
3. Inspect the OpenChamber logs. Expected: no bot token and no bearer value.
4. Inspect the panel. Expected: no token value is present in the DOM or network responses,
   only `configured: true` and the bot username.

## 7. Restart and persistence

1. Note the panel “Recent events” and the chat allowlist.
2. Restart the extension (disable/enable) or restart OpenChamber.
3. Expected: the panel returns to the same primary chat and event history; `/status` still
   works.
4. Press a button from a question card that was created before the restart and is still open.
   Expected: the answer reaches the correct session (the ref table and form were persisted).
5. Send a command after restart. Expected: no duplicated old replies; the Telegram offset
   resumed.

## 8. Failure modes

- **No token:** panel shows “needs token” and Settings → Integrations gets a configuration
  note. The service is still healthy (`/health` 200) but does not poll.
- **Bad token:** panel shows “connecting” and the service error; no crash loop.
- **OpenCode grant missing:** `/status` still lists sessions observed in events; the panel
  fact says “event registry only”. Re-approve `opencode` reads for the full list.
- **Service not approved:** panel says the local service is not approved; approve it in
  Settings → Extensions.
- **Two pollers:** a second instance with the same token logs a 409 and backs off. Stop one.

## 9. What “pass” looks like

- A form question appears in Telegram and one button press answers the exact session.
- A permission card offers only Allow once / Deny, and the answer reaches OpenChamber.
- `/status`, `/sessions`, `/send`, `/stop`, `/digest` work from an allowed private chat.
- With a lead, only that session's events arrive; other sessions are ignored silently.
- Deleting or archiving the lead pauses delivery and asks for a new lead; nothing is
  auto-selected.
- A lead that disappeared while the service was down is cleared on startup with one offline
  notice; a lead confirmed archived by OpenCode's archived-session read is cleared with
  archived wording even if the host still resolves it; a valid lead, a host-resolved session
  not confirmed archived, or a probe that cannot read the archive/list/host keeps the binding
  and sends nothing. Restarting a paused state sends no duplicate notice.
- An unauthorized chat is ignored.
- The token appears in neither logs nor the panel.
- After a restart, mappings, offset, the lead binding and an old open card still work.
