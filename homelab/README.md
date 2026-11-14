# Homelab notes (fork-local)

Installation-specific setup for this fork. Kept in `homelab/` so it stays out of upstream diffs.
Plan doc: "Proactive Agent Plan — NanoClaw on Homelab" (Claude Docs).

## Current state (Mac mini, trial period)

- NanoClaw v2 from `nanocoai/nanoclaw` (remote `upstream`), fork at `bolero/nanoclaw`.
- Runtime: Docker Desktop. Gateway: OneCLI (`NANOCLAW_GATEWAY_PROVIDER=onecli`).
- Claude: subscription via `claude setup-token`, stored in OneCLI (`authMode: oauth`). No API key.
- Channel: Telegram, one owner DM, agent `bono` (provider `claude`).
- Host service: launchd `com.nanoclaw-v2-<slug>` (created by `nanoclaw.sh`).

## Verified

| Test | Result |
|---|---|
| Claude subscription through the gateway | Pass |
| Telegram Approve/Deny (`install_packages`) | Pass |
| Gatus-style webhook → agent reply in Telegram | Pass |
| Webhook as a launchd service | Pass |
| Agent SSH access (per-agent key mounted read-only into one group) | Pass |
| Codex on ChatGPT | Parked (see below) |
| Aperture + `X-Job-Name` | Not tested (needs Aperture) |
| OpenCode (Gemma local / Gemini Flash) | Not tested |
| Browser worker on the Mac mini | Not tested |

## Gatus webhook sidecar

`scripts/gatus-webhook.ts` receives `POST /alert` and injects the alert into the agent through
`data/cli.sock` (the CLI admin channel), addressed to the target Telegram chat. No NanoClaw core
changes. Debounce: repeat alerts per endpoint are dropped for `REPEAT_SUPPRESS_MIN`; a recovery is
held `RESOLVE_DELAY_SEC` and dropped if the check re-triggers.

First use needs one owner approval: the sender `cli:local` is unknown, so NanoClaw sends an approval
card to the owner's Telegram DM. Approve it once.

Setup:

```bash
mkdir -p ~/.config/nanoclaw && chmod 700 ~/.config/nanoclaw
cp homelab/gatus-webhook.env.example ~/.config/nanoclaw/gatus-webhook.env
chmod 600 ~/.config/nanoclaw/gatus-webhook.env
# edit it: set WEBHOOK_SECRET (openssl rand -hex 24), WEBHOOK_HOST (tailscale ip -4), TARGET_PLATFORM_ID
```

Run by hand to test: `homelab/run-gatus-webhook.sh`.

Run as a service (macOS launchd):

```bash
sed -e "s|__REPO__|$PWD|g" -e "s|__HOME__|$HOME|g" \
  homelab/launchd/com.nanoclaw-gatus-webhook.plist.template \
  > ~/Library/LaunchAgents/com.nanoclaw-gatus-webhook.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nanoclaw-gatus-webhook.plist
```

Then add `homelab/gatus-alert.yaml` to the Gatus config on the VPS (use the same secret) and allow the VPS's
Tailscale tag to reach port 8787 on this host in the ACLs. The sidecar binds to the Tailscale IP only.

## Codex (parked)

- `pnpm exec tsx setup/index.ts --step provider-auth codex` needs `codex` on PATH. npm's global bin here is
  `/Users/bolero/node/bin`, so `export PATH="/Users/bolero/node/bin:$PATH"` (added to `~/.zshrc`).
- The first attempt switched agent `bono` to Codex before auth finished; the container then crashed with
  `EACCES: permission denied, open '/home/node/.codex/config.toml'`. Fix: `ncl groups config update --id <group> --provider claude`
  then `ncl groups restart --id <group>`.
- Retry on a separate test agent group, never on `bono`. Check the `EACCES` error again once the login is stored.

## Agent SSH access (generic)

Each agent gets its own key, kept outside `~/.ssh` (the mount allowlist blocks paths containing `.ssh`, `id_ed25519`,
`private_key` or `credentials`). For a NanoClaw group: put the key, an ssh `config`, `known_hosts` and an `ssh-wrap` script in one
directory, allow it in `~/.config/nanoclaw/mount-allowlist.json` (read-only), then `ncl groups config add-mount --id <group>
--host <dir> --container agent-ssh --ro` and `ncl groups restart`. The image has `git` but not `ssh`: approve `install_packages` for
`openssh-client` and `libnss-wrapper`. The container runs as the host uid, which has no `/etc/passwd` entry, and OpenSSH refuses to
run without one, so `ssh-wrap` uses `nss_wrapper` (`LD_PRELOAD`) to fake it; set `git config --global core.sshCommand ~/.ssh/ssh-wrap`.
Give the mount only to a test group, never the group that reads outside messages.

## Home assistant pieces (generic)

- `home.example.yaml` → copy to `~/.config/nanoclaw/home.yaml` (mode 0600) and fill in. Validate with
  `pnpm exec tsx scripts/home-config.ts`. Nothing personal lives in the repo.
- **Google broker** (`scripts/google-broker.ts`): holds Google refresh tokens; agents reach it as an MCP
  server at `http://host.docker.internal:8791/google/mcp` through the credential gateway, which injects a
  per-agent `X-Caller-Key`. Gmail read-only; calendar writes are tagged and only the creating agent can
  delete them. Install: fill `launchd/com.nanoclaw-google-broker.plist.template` (`__REPO__`, `__HOME__`)
  into `~/Library/LaunchAgents/`, then `launchctl bootstrap gui/$(id -u) <plist>`. Consent per account:
  `pnpm exec tsx scripts/google-authorize.ts <account>` (loopback PKCE with your Desktop OAuth client;
  `GOOGLE_CLIENT_FILE` points at it). Health: `GET /health` (503 while any account needs consent).
- **Mail triage** (`scripts/mail-triage.ts`, mailbox `mode: triaged`): starred mail stays the trusted path;
  other mail matching `triage.query` is sent to Gemini Flash on Vertex AI (no tools, JSON schema) and the
  agent only gets the validated summary line (type, action, due date, sender from the header). Triaged items
  are suggestions: the agent asks before acting, and `mail_get` stays closed until the owner stars the
  message or asks for a search. Failed triage is retried, never passed through raw. Setup: in the Cloud
  project enable the Vertex AI API, create a service account with `roles/aiplatform.user`, save its JSON
  key as `~/.config/nanoclaw/vertex-sa.json` (mode 0600, or set `VERTEX_SA_FILE`), use a paid (billed)
  project, check the current data-retention settings, then switch the mailbox to `mode: triaged` and
  restart the broker.
- **Caller keys**: `scripts/bridge-policy.ts add-caller <agent> --onecli-agent <id> --host <bridge host>`
  (host-side MCP bridges) or `--target google` (broker). Keys go straight into OneCLI; only hashes are kept.
- **App dashboard** (`scripts/dashboard-feed.ts`): fills the Bono app's Today and Ops boards from home.yaml
  `dashboard` (audience per board = app handles, Today calendars, Gatus URL, optional weather location). Host-side
  only: reads Google grants with read scopes, Gatus, `alerts.db` and `ncl tasks/approvals list`; writes
  `data/app-channel/dashboard.json`, which the app channel serves per audience. Run `homelab/run-dashboard-feed.sh`
  from a timer (systemd user `.service` with `Type=oneshot` + `.timer` with `OnUnitActiveSec=5min`).
- **Agent tools** (`agent-tools/`): `nudges.ts` (Bun) — nudge record, numbered brief replies, auto-action
  ledger with undo. Copy into `groups/<folder>/tools/`. Tests: run `bun test` inside the agent image.

## Rules for this install

- Never set `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`; the subscription token lives in OneCLI only.
- Keep each subscription single-user on its official client.
- Test new providers on a separate group, not the main chat.
- Don't mount the Docker socket into agent containers.

## Migrating to a VM on Proxmox (after the trial)

Carries over: this repo (clone the fork), the Telegram bot token, the design and findings.
Redo on the VM:

1. Stop NanoClaw here first (only one machine may poll the Telegram bot): `launchctl bootout gui/$(id -u)/com.nanoclaw-v2-<slug>`.
2. VM: Debian/Ubuntu, about 4 vCPU, 8 GB RAM, 60 GB disk. Install Tailscale with a tag; install Docker Engine.
3. `git clone https://github.com/bolero/nanoclaw.git && cd nanoclaw && bash nanoclaw.sh`. Answer No to the
   hardened image and the perks dashboard. Pick the Claude subscription (`setup-token`) and Telegram.
4. Re-pair Telegram and re-approve the `cli:local` sender (approvals live in `data/v2.db`).
5. Recreate the webhook env file and run the sidecar as a systemd unit; update the Gatus alert URL to the VM's Tailscale IP.
6. Tailscale ACLs: VPS (Gatus) → VM:8787; VM → Aperture; VM → Mac mini (browser worker, local models).
7. Optional: copy `data/` and `groups/` to keep the agent's memory (starting fresh is fine).
8. Snapshot the VM once it works.
