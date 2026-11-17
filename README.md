# GMX Mailbox Operations

A local dashboard for GMX registration and POP3/IMAP automation, built with
Express, EJS, Tailwind CSS and Puppeteer.

## Setup

Requires Node.js **22.12 or newer**. The included `.nvmrc` selects Node.js 24.
Visible Chrome needs a graphical desktop.

```sh
npm ci
npx puppeteer browsers install chrome
cp .env.example .env
```

Edit `.env` with your provider credentials, then start the dashboard:

```sh
npm start
```

Open **http://127.0.0.1:3000**. Set `PORT` in `.env` to use another port.
The dashboard binds to the local computer and is intended for local use.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PORT` | Dashboard port; defaults to `3000` |
| `MASKIFY_USERNAME`, `MASKIFY_PASSWORD` | Required for Maskify registration mode |
| `MASKIFY_HOST`, `MASKIFY_PORT` | Maskify gateway; defaults to `resi.maskify.su:80` |
| `ANYSOLVER_API_KEY` | Optional CAPTCHA solving for Maskify registration and proxied POP3/IMAP workers |
| `HEROSMS_API_KEY` | Optional automatic German phone-number purchase and SMS retrieval during registration |
| `EMAIL`, `PASSWORD`, `GMX_PROXY_URL` | Credentials and proxy for the single-account `npm run automate` command |

Uploaded proxy pools are configured in the dashboard. They do not change `.env`.
Without automatic verification, complete the required steps in the worker's
Chrome window or use the dashboard's phone and SMS controls.

## Registration

1. Open **Registration** and choose **Maskify API** or **HTTP proxy**.
2. In HTTP proxy mode, upload a proxy TXT file up to **2 MB**, with at least one
   distinct proxy entry per requested account.
3. Choose **1–500 accounts** and **1–8 parallel workers**, then click **Start batch**.
4. Follow progress and select an account session to provide any manual inputs.
5. When the batch finishes, the dashboard downloads a TXT file containing one
   `email:password` line per completed account. Use **Download email:password TXT**
   to save another copy.

Direct registration connections are disabled. Maskify creates a separate German
sticky session per account. Each uploaded proxy entry is used once, including
failed attempts; use static or sticky proxies that retain their exit IP.

Before visiting GMX, each browser verifies its exit IP and atomically reserves it
in the database. Previously reserved, invalid or unverified IPs stop the attempt.
Reservations remain after failures and server restarts. IP history starts with
this version; registrations made before IP tracking was added have no saved IP.

Each account gets its own Chrome profile. The assistant generates account
details, fills recognized GMX forms and advances through registration. A phone
number is purchased only after the phone form is reached. HeroSMS tries Ortel
Mobile first, then Lycamobile only after an explicit stock or payment rejection.
Uncertain purchase failures are not automatically retried. SMS reads reuse the
same activation; manual phone and code entry remain available.

Only a top-level HTTPS redirect to `/mail` (or `/mail/`) on `navigator.gmx.net`
or one of its subdomains confirms registration success. This includes
`https://navigator.gmx.net/mail` and `https://bap.navigator.gmx.net/mail`.
Query strings may change; session IDs are not
recorded in completion logs. OTP submission, **Perfekt!**, the old registration
success marker and the generic `gmx.net/mail` page do not mark success or close
the browser. The assistant keeps watching for the GMX Navigator mailbox redirect. Errors
on the final screen keep the browser open with an attention message.

Manual completion is disabled. TXT exports and saved-account automation require
a recorded GMX Navigator mailbox redirect. Older screenshot-based, manually confirmed or
otherwise unverified records remain saved and are displayed as **unverified**;
they are excluded from success exports and saved-account selection.

If any tab reaches `https://hilfe.gmx.net/kundenservice/flexreg.html`, the attempt
fails and its browser closes. The batch stops starting queued attempts, and
already running accounts may finish. No replacement profile or automatic retry
is created in response to that redirect. Review the failure before starting a
new batch. Reserved phone numbers and exit IPs remain reserved.

Registration logs identify the batch and account number, so parallel workers can
be distinguished. Failed attempts include the step, a failure code and a stop
reason. Recent HTTP/network failures and visible GMX validation errors are
included when observed. A help redirect without a specific GMX message is
explicitly reported as an unknown rejection reason. Request bodies, raw response
bodies, session URL queries and known credentials are not logged. Ordinary failed
attempts release their worker for the next already queued account; no replacement
profiles are created after GMX redirects to registration help.

Unsuccessful registrations save a redacted image before Chrome closes, including
the GMX help page when it can be captured. Images are stored under
`data/registration-failures/<registration-id>/failure.png`, with owner-only file
permissions, separately from POP3/IMAP screenshots. Known passwords, phone numbers,
email addresses and session-query values are hidden. If Chrome or its page is
unavailable, a clearly labeled `failure.svg` diagnostic is saved instead. Profile
preparation failures use the job ID as the folder name. Storage failures are
reported in the account's log.

Select an account session to **View failure screenshot** or **Download image**.
Saved-registration rows also provide an image link; those images remain accessible
after restarting the server. The terminal log prints each saved file's location.
Files remain local, are ignored by Git, and are not removed when a POP3/IMAP batch
clears its own screenshots. Failure images provide evidence; they do not change
the requirement for a verified mailbox redirect before success is recorded.

If the HeroSMS code wait expires, the assistant clicks GMX's enabled
`resend-code-button` once and resumes checking the same activation and number.
There is at most one automatic resend per account. Disabled, missing or
CAPTCHA-blocked buttons leave manual entry and **Check SMS again** available.
A failed or uncertain resend click is never repeated automatically. Network read
failures alone do not request another SMS or buy another number.

Phone numbers are normalized and reserved in the database before submission.
HeroSMS numbers already assigned to another registration are rejected without an
automatic replacement purchase. The same registration can continue checking its
existing activation. Reservations cover parallel workers and survive restarts;
existing saved phone numbers are included when the database opens. Failed and
cancelled attempts retain their number reservations. Manual phone entry uses
the same duplicate check.

Chrome uses an isolated profile with address/payment autofill and password saving
disabled. Its native browser identity is preserved. All HTTP/HTTPS destinations
use the selected proxy, including Chrome's usual loopback bypass. QUIC is disabled
and WebRTC non-proxied UDP is disabled; DNS prefetch and background networking
remain disabled. The browser has no direct fallback when the proxy fails.
Geolocation, microphone, camera and notification permissions are denied by
default. Exit-IP verification and permanent uniqueness reservations still run
before visiting GMX. Use a static or sticky exit throughout each registration.

These browser settings do not enforce networking for other processes or the
operating system. A system firewall or isolated network environment is required
for a strict machine-wide guarantee that traffic can leave only through a proxy.

Failed attempts are reported separately. The batch runs the requested number
of attempts without creating replacement accounts automatically. **Stop batch**
cancels active and queued attempts while keeping confirmed successes. Each
registration has a 90-minute limit, including startup.

Refreshing the page reconnects to the active batch. Keep the server running;
restarting it interrupts the batch. Completed-account exports remain available
from the database through `POST /api/registration/batches/:id/export`, with the
current dashboard's CSRF token. Exports contain only completed accounts from
that batch, exclude duplicate emails and preserve colons in passwords. If no
accounts complete, the download is empty and the dashboard explains why.

Saved registrations appear in the table below the form. Passwords are revealed
on demand. Select completed accounts and upload proxies to run **IMAP / POP3**
directly from the saved records.

## POP3 / IMAP

1. Open **IMAP / POP3**.
2. Upload an accounts TXT file and a proxy TXT file, up to **2 MB each**.
3. Choose **1–8 parallel workers** and visible or headless Chrome.
4. Click **Start batch** and follow each account's progress, logs and result image.

Account TXT format:

```text
mailbox@gmx.de:password
another@gmx.de:password:containing:colons
```

The first colon separates the email from its password. Blank lines and `#`
comments are ignored. Up to 500 different accounts can run in one batch.

Both uploaders accept these proxy formats, one proxy per line:

```text
proxy.example.com:8080
proxy.example.com:8080:username:password
http://username:password@proxy.example.com:8080
https://username:password@proxy.example.com:8443
```

URI-encode special characters in URL credentials. Proxy pools support up to
1,000 entries and ignore blank lines, comments and duplicate entries.

POP3/IMAP workers lease different proxy entries while running concurrently.
Concurrency is limited by the available accounts and proxies. The browser and
CAPTCHA solver keep the same proxy for an account's flow. A proxy is never
switched during an authenticated session.

The worker logs in, opens settings and checks POP3/IMAP access. Enabled access is
left enabled; disabled access is enabled through GMX's interface. Success requires
the setting to remain enabled after refreshing the settings iframe. Each worker
saves a result image and closes Chrome when finished.

Failed screenshots hide known credentials and input values. If Chrome could not
open, the result is labeled as a diagnostic image. Previous result images are
cleared at the start of a validated new POP3/IMAP batch. Stop controls cancel the
active batch; refreshing the page restores its state while the server is running.

The single-account CLI uses `EMAIL`, `PASSWORD` and `GMX_PROXY_URL` from `.env`:

```sh
npm run automate
```

## Storage and credentials

Registration profiles and credentials are encrypted with AES-256-GCM in
`data/registrations.sqlite`. The encryption key is stored separately in
`data/registration.key`. Preserve both when moving or backing up saved accounts;
the database cannot be decrypted without its key. Exit-IP fingerprints and batch
manifests share the database. SMS codes remain in memory.

The app creates `data/` and `artifacts/` when needed. Local `.env` files, account
storage, browser profiles, uploads, generated exports, screenshots and dependencies
are excluded from Git. `.env.example` contains setup placeholders only.

Provider requests can incur charges. Account passwords and session cookies are
not sent to the CAPTCHA solver. Number purchases, CAPTCHA task creation and
sensitive form submissions are not automatically replayed after uncertain errors.
Manual verification may still be required by GMX.

## Development

```sh
npm run build     # Rebuild public/app.css
npm run dev:css   # Watch Tailwind source changes
```

Compiled CSS is included so a fresh checkout can start without a separate build.

```text
server.cjs                    Express server and application wiring
automation/registration.cjs   Registration flow, encrypted storage and API routes
automation/registration-batch.cjs  Registration queue and worker management
automation/captcha-solver.cjs  Registration CAPTCHA integration
maskify.cjs                   Maskify sticky-session configuration
random.js                     Generated profiles and HeroSMS integration
herosms-client.cjs            HeroSMS HTTPS client
batch.cjs                     POP3/IMAP queue and worker management
login.cjs                     Mailbox login automation and single-account CLI
settings.cjs                  POP3/IMAP settings automation
proxy.cjs                     Proxy parsing and local proxy forwarding
proxy-ip.cjs                  Browser-based exit-IP verification
registration-connection.cjs   Registration connection validation
inputs.cjs                    Uploaded account and proxy parsing
captcha.cjs                   POP3/IMAP CAPTCHA integration
artifacts.cjs                 Result image storage and credential redaction
ui.cjs                        Shared browser interaction helpers
public/                       Dashboard scripts, compiled CSS and images
views/                        EJS templates
styles/                       Tailwind source
```

## License

[ISC](LICENSE).
