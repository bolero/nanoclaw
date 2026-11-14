# App channel

A native phone/tablet client channel. The host serves a small JSON + Server-Sent-Events API; the app pairs once with a one-time code and then talks to its agents like any other channel. Code: `src/channels/app.ts`, `src/channels/app/`.

## Enable

Add to `.env` and restart the host:

```
APP_CHANNEL_PORT=3100                                    # off when unset
APP_CHANNEL_HOST=127.0.0.1                               # default; keep it on loopback
APP_CHANNEL_PUBLIC_URL=https://<host>.<tailnet>.ts.net   # what the phone connects to (used in pairing links)
```

Publish privately with Tailscale, which gives iOS the TLS certificate it needs, e.g. `tailscale serve --bg --https=443 http://127.0.0.1:3100`. Do not expose the port on a LAN or the internet.

## Push notifications (optional)

```
APP_APNS_KEY_FILE=~/.config/nanoclaw/apns/AuthKey_XXXXXXXXXX.p8   # owner-only file, outside every agent mount
APP_APNS_KEY_ID=XXXXXXXXXX
APP_APNS_TEAM_ID=XXXXXXXXXX
APP_APNS_TOPIC=<app bundle id>
APP_PUSH_QUIET_HOURS=21-7        # local hours; "off" to disable
APP_PUSH_URGENT_AGENTS=ops       # agent folders that break through quiet hours
```

Pushes go out for "needs you" cards, and for other agent messages only when the agent spoke first (nobody wrote in that conversation in the last 10 minutes). Nothing is pushed while the person has the app open. In quiet hours notifications arrive silently, except from urgent agents. The lock screen shows the agent name and the first line; the badge is the number of open cards.

## Set up a person

```
ncl app connect --user alex --agent main --home   # Home chat (approvals land here), answered by `main`
ncl app connect --user alex --agent family        # a direct chat with another agent
ncl app pair --user alex --name "Alex"            # one-time code, valid 10 minutes
ncl app devices [--user alex]
ncl app revoke --id <device id>
ncl app avatar --agent family --file family.png --color '#f59e0b'
```

The person is NanoClaw user `app:<handle>`. `connect` adds them as a member of the agent group; owner/admin roles are granted as usual (`ncl roles grant`). Conversation ids are platform ids: `app:<handle>` (Home) and `app:<handle>:<agentFolder>`.

## API

All routes are under `/v1`; everything except `health` and `pair` needs `Authorization: Bearer <token>`.

| Route | Purpose |
|---|---|
| `GET /health` | liveness |
| `POST /pair` `{code, deviceName}` | → `{token, deviceId, user}`; the token is shown once and stored hashed |
| `GET /me` | user and device |
| `GET /conversations` | the caller's conversations, their agents (name, colour, avatar URL) and last message |
| `GET /conversations/:id/messages?before=<iso>&limit=` | page of one conversation, newest first |
| `POST /conversations/:id/messages` `{text, clientId?, attachments?: [{name, mimeType, data}]}` | send; base64 attachments, 30 MB body cap; `clientId` makes retries idempotent |
| `GET /feed?before=&limit=` | `{needsYou, messages}`: open cards plus agent messages across all conversations |
| `GET /sync?after=<rev>&limit=` | every message created or changed after `rev`, for the offline cache |
| `POST /actions` `{messageId, value}` | answer a card (approval or agent question) |
| `GET /events` | SSE: `message` (id = rev) and `typing` events; resumes from `Last-Event-ID` |
| `GET /files/:id` | attachment bytes |
| `GET /agents/:folder/avatar` | avatar image |
| `PUT /devices/me/push` `{apnsToken, environment}` | register for push; `environment` is `development` (direct installs) or `production` (TestFlight) |

Message: `{id, rev, conversationId, direction: in|out, kind: text|card, text (Markdown), card?: {questionId, title, question, options[{label, value, style?}], resolution?}, files[{id, filename, mimeType, size}], senderName, failure, createdAt, updatedAt}`.

The channel keeps its own store in `data/app-channel/` (devices, pairing codes, message mirror, files, avatars); routing state stays in the central DB.
