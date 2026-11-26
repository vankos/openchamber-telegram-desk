# Telegram Desk for OpenChamber

Two-way Telegram control for OpenCode sessions. Questions and permission requests from any
session arrive as Telegram cards with buttons; the answer goes back to the session that
asked. A small command surface covers `/status`, `/sessions`, `/send`, `/stop`, `/digest`,
and replying to any bot message sends the text to its session.

Status: v1.1.0. The design and the SDK constraints are in
[`docs/design.md`](docs/design.md). The real-token checklist is in
[`docs/smoke-test.md`](docs/smoke-test.md).

## What you get

- **Question cards.** A `question-asked` form becomes a message with option buttons. Single
  choice questions answer on the first press; multi-field forms collect answers and show a
  Submit button. Text, number, boolean and multiselect fields are supported.
- **Permission cards.** `Allow once` and `Deny` only. “Always allow” stays a click in
  OpenChamber on purpose.
- **Turn notices.** Finished turns send the agent's full reply, formatted as a Telegram rich
  message when it fits (32k characters) or split across ordinary messages otherwise. Failed
  turns send a short error card. Per-session and global cooldowns apply. The default mode is
  `all`; switch to `active` to hear only from sessions that recently interacted with
  Telegram, or `off`.
- **Reply routing.** Reply to any bot message and the text goes to the session it belongs
  to. Replying to an open question card answers its text field instead.
- **Commands.** `/status`, `/sessions`, `/send`, `/stop`, `/digest`, `/help`.
- **Pairing and allowlist.** A short-lived code from the panel pairs a private chat. A
  numeric allowlist in the integration settings is the second way in.
- **Persistence.** Message/request mappings, Telegram offset, the allowlist and the outbox
  live in `OPENCHAMBER_SERVICE_DATA_DIR` and survive restarts.

## Requirements

- OpenChamber **2.7.0 or newer** (web, desktop, or a server with connected clients).
- An OpenCode server managed by that OpenChamber instance.
- A Telegram bot from [@BotFather](https://t.me/BotFather).
- The extension is installed on the **server** that runs OpenChamber. VS Code does not load
  OpenChamber extensions. Mobile clients can open the panel and use the bot, but they do
  not spawn the background service.

## Install

1. Open **Settings → Extensions → Add** and choose this folder
   (`openchamber-telegram-desk`).
2. Approve the extension. The approval dialog lists the local service, network access,
   transcripts, session control, session answers and OpenCode reads. The service has the
   user's full access, as the dialog says; it runs on the OpenChamber server.
3. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
4. Open **Settings → Integrations → Telegram Desk**, expand the card and paste the token
   into **“Bot token used by the service”**. Click outside the field to save.
   - **Do not use the “API token” field or the Connect button.** OpenChamber's manifest
     requires an integration auth kind, but Telegram bot tokens are not HTTP bearer
     tokens, so that field cannot work. It is a schema limitation of the SDK, not a second
     setting. The extension card may read “Not connected” even when the bot works; the
     Telegram Desk panel shows the real status.
   - Optionally fill **Allowed Telegram user/chat IDs** with numeric IDs separated by
     commas. This is an alternative or addition to pairing.
   - Optionally set **Turn notifications** to `all` (default), `active` or `off`.
5. Open the **Telegram Desk** rail panel. Once the service reads the token it shows the bot
   username and “connected”.
6. Click **Create pairing code**, then send `/start CODE` (for example
   `/start ABCD-2345`) to the bot in a **private chat**. The code works once and expires in
   10 minutes.
7. Click **Send test message** to check the path end to end.

The bot token is stored by OpenChamber as a `secret` integration setting. The service reads
it through `readSettings`; the panel never receives it, and it is never written to the
service state file. OpenChamber 2.8 writes integration settings to
`%USERPROFILE%\.config\openchamber\guest-auth.json` in plain text — treat that folder as a
secret and do not sync or commit it.

## Commands

| Command | What it does |
|---|---|
| `/start [code]` | Pair a private chat, or explain how to pair |
| `/status` | Sessions grouped as waiting / busy / idle, with pending-answer counts |
| `/sessions` | Recent sessions with indexes, IDs, projects and relative update time |
| `/send <session> <text>` | Send a message with `sessions.send` |
| `/stop <session>` | Stop the running turn with `sessions.stop` |
| `/digest` | Counts, pending answers, and turns since the last digest in this chat |
| `/help` | The command list |
| `/unpair` | Remove this chat from the paired list (settings allowlist can still allow it) |
| Reply to a bot message | Send the text to that message's session, or answer an open form field |

`<session>` accepts:

- an index from the last `/sessions` in this chat (`/send 2 …`),
- a full session id (`ses_…`),
- a unique id prefix of at least four characters,
- a unique title (exact match first, then substring); quote multi-word titles:
  `/send "Fix parser" continue`.

The panel's notification mode is an override stored in service state; the `Turn
notifications` field in Settings → Integrations is the default used before the panel sets
one. `/status`, `/sessions`, `/send` and `/stop` work from any allowed chat. Event cards are sent
to the **primary chat** (the first paired chat, or the first ID in the settings allowlist);
the panel shows which chat that is.

## How a question is answered

A `question-asked` event carries a form. The bot stores the form, creates one opaque callback
ref per button and renders the card. Telegram limits `callback_data` to 64 bytes, so the
button does not carry the session and form IDs directly; the persisted ref table does.

- One choice field: pressing a button calls `sessions.answerForm` immediately.
- Several fields: choices are stored, text fields are answered by replying to the card, and
  a **Submit answer** button appears when every required visible field is answered.
- Conditional fields (`when`) are evaluated on every render; answers to hidden fields are
  dropped.
- A required `external` field cannot be answered from Telegram; the card says to use
  OpenChamber.
- `ask.kind: "page"` cannot be answered by a service at all. The bot sends a notice; reply
  to it to send text to the session, which closes the page in OpenChamber.
- **Dismiss** calls `answerForm(..., null, "Dismissed from Telegram.")`.

Answers are idempotent by Telegram callback id. A request that was already answered in
OpenChamber produces a 404 from the host; the card is edited to “already settled” and the
press does nothing else.

## Security

- The service binds to `127.0.0.1` only and requires
  `Authorization: Bearer $OPENCHAMBER_SERVICE_TOKEN` on every route, including `/health`.
- The bot token is never returned by `/status`, never stored in `state.json`, and is
  redacted from logs together with bearer values. Its storage is OpenChamber's:
  `guest-auth.json` in the OpenChamber config folder holds it in plain text (see above).
- Only allowlisted user or chat IDs are processed. Unknown non-`/start` commands are ignored.
- Pairing is private-chat only, one code at a time, 10-minute TTL, one use, and rate
  limited per chat.
- Text in ordinary messages is HTML-escaped, and Telegram parse errors fall back to plain
  text once. Rich messages carry the agent's Markdown to Telegram's rich-text parser; if
  Telegram refuses one, the same reply goes out as escaped HTML parts.
- Ordinary messages stay under Telegram's 4096-character limit; a reply that does not fit a
  rich message is split across parts. Option labels, resources and titles have their own
  caps.
- Callback queries are deduplicated, updates and event IDs are deduplicated, and terminal
  refs (permission answer, submit, dismiss) are single-use in practice because the
  underlying request closes.

## Persistence and restarts

State is `OPENCHAMBER_SERVICE_DATA_DIR/state.json`, written atomically with mode 0600. It
contains the Telegram offset, message→session/form routes, opaque callback refs, open forms
and permissions, the paired IDs, notification preference, recent event metadata and the
outbox. It contains no token and no full transcript.

After a service or OpenChamber restart the offset resumes, existing buttons keep working,
and undelivered cards are retried from the outbox. Session events are delivered by
OpenChamber at most once with a 10-second timeout; the service acknowledges quickly and
sends from the persisted outbox. The state also holds answers typed into open forms and
rendered card text in the outbox (needed to deliver after a restart); remove the extension
to delete its data folder.

## Limitations

- **No “Always allow”.** That action is deliberately a click in the app.
- **Page questions cannot be answered from a service.** Use OpenChamber or reply to the
  notice to send text to the session.
- **Event content is at most once.** A turn that fails while the service is down is not
  replayed by OpenChamber. The outbox helps with outbound sends, not with host events.
- **OpenCode session list is optional.** It needs the separately approved `opencode` grant.
  Without it, `/status` and `/sessions` only know sessions observed in events since the
  service started.
- **One poller per bot.** Do not run two OpenChamber instances with the same bot token; a
  `getUpdates` conflict backs off but only one process can poll. Use a dedicated bot with
  no webhook set; a webhook makes `getUpdates` fail with a 409.
- **Group chats.** Allowing a group lets every member press its cards; the bot pairs only
  private chats. Prefer private chats for questions and permissions.
- **No attachments, voice, reactions or rich messages in v1.** Text cards only.
- **Bot messages are English in v1.**
- **The integration “API token” field is unused** because the SDK does not expose the
  integration token to services. Use the secret **Bot token** setting.

## Development

```bash
npm install
npm run build     # rebuilds panel/main.js from panel/src/main.mjs
npm test          # node:test unit + smoke tests
npm run check     # manifest, packaged files, IIFE panel
```

The package ships built JavaScript. OpenChamber never compiles the extension. After editing
`panel/src/main.mjs`, run `npm run build` and reload the extension.

Layout:

```
package.json          manifest + scripts
icon.svg              rail icon
panel/index.html      panel markup
panel/style.css       theme-aware styles
panel/src/main.mjs    panel source (SDK host bridge)
panel/main.js         built classic IIFE
service/main.js       service entry
service/app.js        loopback HTTP server, poller, settings
service/lib/          Telegram, host, OpenCode, store, forms, commands, outbox
tests/                unit and loopback smoke tests
docs/design.md        architecture, data model, security, Mermaid flows
docs/smoke-test.md    real-bot checklist
```

### Real Telegram smoke test

The unit smoke test uses a mocked Telegram and host. To check the real Bot API without
putting the token in chat:

```bash
# PowerShell
$env:TELEGRAM_BOT_TOKEN="<paste locally>"
$env:TELEGRAM_CHAT_ID="<your numeric chat id>"
npm run smoke:telegram
```

The script calls `getMe` and sends one test message. It never prints the token. For the full
UI path, follow `docs/smoke-test.md`.

## SDK notes

The extension uses `sessionEvents`, `sessionControl` (`answers: true`), and the `opencode`
service role. It does not patch OpenChamber or OpenCode. The important mismatch between the
brief and the SDK is documented in [`docs/design.md`](docs/design.md#1-what-the-sdk-actually-gives-us):
there is no session-list method on `sessionControl`, callback data is tiny, and integration
tokens are not readable by services.
