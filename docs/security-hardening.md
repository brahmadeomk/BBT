# Security hardening (Slice 8a)

The panel has an outward network route (AWS IoT), so credential exposure
and an open editor are real risks. This slice removes hardcoded
credentials from the repo, scopes privileged access, and secures the
Node-RED editor. **Done when:** no credentials in the repo or flow
exports; the editor requires authentication; sudoers is scoped to named
commands.

## 1. Dashboard access PINs — now from the environment

The flow used to hardcode five plaintext gate PINs in function/template
node source (committed to git):

| Was (removed) | Now reads | Gates |
|---|---|---|
| `system123` | `BUSDUCT_PW_SYSTEM` | System config screen |
| `alarm123` | `BUSDUCT_PW_ALARM` | Alarm config screen |
| `AdminPro` | `BUSDUCT_PW_PARAMETERS` | Parameters tab |
| `AdminLite` | `BUSDUCT_PW_COMMS` | Communication Settings tab |
| `Password@21` | `BUSDUCT_KIOSK_PIN` | Exit-kiosk PIN |

Every gate now reads its PIN from the Node-RED environment and **fails
closed** when the variable is unset (access denied; the kiosk shows
"Kiosk PIN not configured"). Set them on the Pi from the template:

```bash
sudo mkdir -p /etc/busduct
sudo cp deploy/nodered.env.example /etc/busduct/nodered.env
sudo nano /etc/busduct/nodered.env      # set real values
sudo chmod 600 /etc/busduct/nodered.env
sudo systemctl edit nodered             # add: [Service] / EnvironmentFile=/etc/busduct/nodered.env
sudo systemctl restart nodered
```

All five gates validate **server-side**: `env.get(...)` in a function
node reads process environment variables. (The kiosk PIN is checked by a
"Check Kiosk PIN" function node too — an earlier attempt to use
`${BUSDUCT_KIOSK_PIN}` substitution inside the `ui_template` did **not**
work, because Node-RED does not substitute env vars inside dashboard
template body content; server-side validation also keeps the PIN out of
the browser.) `/etc/busduct/nodered.env` is git-ignored — never commit
the filled-in file.

> These are **low-strength dashboard gates** (client-reachable widgets,
> short shared PINs). They keep a casual operator out of a config screen;
> they are not the security boundary. The real boundary is the editor
> `adminAuth` (§3) and the OS. A proper hashed/role-based dashboard auth
> is a possible future improvement, out of 8a scope.

## 2. Scoped sudo (no embedded password, no blanket root)

The only privileged operation in the flow is the USB-hub power-cycle in
the RECOVERY CONTROLLER (`sudo uhubctl ...`). It must run without a
password and **without** granting the Node-RED user blanket root. Install
the scoped rule:

```bash
which uhubctl                              # confirm the path in the file
sudo cp deploy/sudoers.d/busduct-nodered /etc/sudoers.d/busduct-nodered
sudo chmod 440 /etc/sudoers.d/busduct-nodered
sudo visudo -cf /etc/sudoers.d/busduct-nodered   # must print "parsed OK"
```

Then **remove any pre-existing broad `NOPASSWD: ALL`** entry for the
Node-RED user. The flow already calls `sudo uhubctl` with no password (no
`sudo -S`, no piped password), so nothing in the flow changes.

## 2b. Wi-Fi screen: a wrapper, not `sudo nmcli`

The Slave Config tab's **Wi-Fi Network** screen lets a technician pick the site
network and enter its password on the panel's touchscreen. That needs root, so
it is granted through a narrow helper:

```bash
sudo install -o root -g root -m 0755 deploy/bin/busduct-wifi /usr/local/sbin/busduct-wifi
# the sudoers file in deploy/ already grants this one binary; reinstall it:
sudo cp deploy/sudoers.d/busduct-nodered /etc/sudoers.d/busduct-nodered
sudo chmod 440 /etc/sudoers.d/busduct-nodered
sudo visudo -cf /etc/sudoers.d/busduct-nodered     # must print "parsed OK"
```

Three deliberate choices, each worth keeping:

- **A wrapper, not `NOPASSWD: /usr/bin/nmcli`.** Granting nmcli wholesale is
  effectively granting root: it can edit any connection profile and run
  dispatcher scripts on connection events. The wrapper exposes exactly
  `scan`, `status` and `connect <ssid>` and nothing else.

- **The passphrase never enters an argument vector.** `/proc/<pid>/cmdline` is
  world-readable, so the obvious `nmcli device wifi connect X password Y` leaks
  the site's Wi-Fi password to every local user for the life of the process.
  The helper reads it from **stdin** and writes it straight into a `0600`
  root-owned NetworkManager keyfile. The Node-RED library writes it to the
  child's stdin; a unit test asserts it is absent from argv, and that test is
  the thing to keep if this code is ever refactored.

- **The passphrase reaches nothing else.** Not the config store, not the audit
  trail, not a Node-RED global or the context store (which serialises to disk),
  not a debug node, not the cloud heartbeat. The backend function node has no
  logging of `msg.payload` for exactly this reason.

A failed join is reverted by the helper itself: the new profile is deleted and
the previous wireless connection brought back up, so a mistyped password cannot
strand the panel. The screen says so.

**Remaining exposure, stated plainly:** the Wi-Fi screen sits behind the same
low-strength dashboard PIN gates as the rest of the config screens (see the note
in §1 — they are not the security boundary). Anyone who can reach the dashboard
can change the panel's network. On a panel whose HMI is the local touchscreen
that is acceptable; if the dashboard is exposed beyond the panel, the editor
`adminAuth` and network-level controls in §3 are what actually protect it.

## 3. Secure the Node-RED editor (`adminAuth` + TLS)

The editor (`http://<pi>:1880`) can edit flows and run arbitrary code —
it must not be open on the network. Add `adminAuth` to `settings.js`
(snippet in `src/config-service/node-red/settings.js.example`):

```bash
# generate a bcrypt hash for your admin password:
node-red admin hash-pw           # or: npx node-red-admin hash-pw
```

Paste the hash into the `adminAuth` block, set a real username, restart
Node-RED, and confirm the editor now prompts for login. Options, pick
per deployment:

- **adminAuth** (above) — editor requires a username + bcrypt password.
- **TLS** — serve the editor over https (`https` + `requireHttps` in
  settings.js) so credentials aren't sent in clear text on the LAN.
- **Disable remote editing entirely** — if the panel is commissioned and
  edits happen only locally, bind the editor to loopback
  (`uiHost: "127.0.0.1"`) or firewall port 1880. Most locked-down option.

Also set `httpNodeAuth`/`httpStatic` auth if any HTTP-In endpoints are
exposed. The **dashboard** (`/ui`) is separate from the editor — protect
it with `httpNodeMiddleware`/dashboard auth if the LAN is untrusted.

## 4. Credential & secret hygiene

- **Node-RED credentials** (SMTP auth, any DB password) live in the
  encrypted `flows_*_cred.json`, **not** in `flows_BBT.json`. That file
  and `settings.js` are git-ignored — never commit them, and set
  `credentialSecret` in `settings.js` (not the default) so the creds
  file isn't decryptable with a known key.
- **Operational certs/keys** (`/etc/busduct/certs/*`) are written on-device
  by provisioning with the private key `0600`; `*.pem`/`*.key`/`*.crt`
  are git-ignored.
- **Repo access on the Pi** is currently a Personal Access Token over
  HTTPS. Known weakness, accepted for now: a PAT in the remote URL is
  stored in plaintext in `.git/config`, shows in `git remote -v`, and
  lands in shell history. The documented improvement is a **read-only SSH
  deploy key** — scoped to one repository, one key per panel, unable to
  push (which would also enforce *"never modify the production Pi
  directly"* at the credential layer). Procedure, host-key pinning and
  revocation: **`docs/pi-deployment.md` §1a**. **Not adopted — user
  decision 2026-09-01.** If a PAT is used, scope it to `repo` **read**
  only and rotate it when anyone leaves the team.
- **Verify before every commit** that no secret slipped in:
  ```bash
  git grep -nE 'password|passwd|secret|token|BEGIN (RSA |EC )?PRIVATE KEY' -- flows/ src/ | grep -v env.get
  ```

## 5. Verification checklist (8a "Done when")

- [ ] `git grep -E 'system123|alarm123|AdminPro|AdminLite|Password@21'` → no matches.
- [ ] Dashboard gates deny access when their env var is unset; allow with the correct PIN once set.
- [ ] `/etc/sudoers.d/busduct-nodered` parses; `uhubctl` and `busduct-wifi` run without a password; no `NOPASSWD: ALL` remains.
- [ ] `/usr/local/sbin/busduct-wifi` is installed root-owned `0755`; the Wi-Fi screen scans and joins; the passphrase appears in no log.
- [ ] Editor at `:1880` prompts for login (or is loopback-bound/firewalled).
- [ ] `flows_*_cred.json`, `settings.js`, `*.key`/`*.pem`, `/etc/busduct/nodered.env` are all untracked.
- [ ] Repo credential on the Pi is a read-scoped PAT (or, if §1a was adopted, `ssh -T github-busduct` greets the **repository** and `git push` is refused as read-only).
