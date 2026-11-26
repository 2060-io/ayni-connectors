#!/usr/bin/env node
/**
 * The conformance kit and a few checks of providers §5 against a real Nextcloud, by hand (never in `pnpm test`):
 *
 *   pnpm build && node packages/connector-nextcloud/scripts/nextcloud-local.mjs [--plain] [--calendar-messages] [--json report.json]
 *
 * It needs Docker running, and starts nothing else: a throwaway container of the official image `nextcloud` (on a
 * throwaway PostgreSQL: SQLite refuses the kit's concurrent writes with `database is locked`; the Team folders app
 * installed from the app store) behind HTTPS made inside the container, on a loopback port, and a throwaway Mailpit
 * for the mail Nextcloud sends, in a network of their own. The accounts are the spec's invented
 * people (Ana, Jonas) and the managing account, with passwords made in this process and written nowhere: they live in
 * the containers alone, which are removed with their volumes and network at the end, whatever happens.
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { request } from 'node:https'
import { promisify } from 'node:util'
import { runConformance } from '@ayni.org/ayni-conformance'
import { hostPolicy, startNextcloudConnector } from '../build/index.js'

const run = promisify(execFile)
const IMAGE = process.env.NEXTCLOUD_IMAGE ?? 'nextcloud:35.0.3'
const MAILPIT = process.env.MAILPIT_IMAGE ?? 'axllent/mailpit:v1.32.0'
const POSTGRES = process.env.POSTGRES_IMAGE ?? 'postgres:16-alpine'
const HOST = 'nextcloud.test'
const tag = randomBytes(4).toString('hex')
const names = { nc: `ayni-nc-${tag}`, mail: `ayni-mail-${tag}`, db: `ayni-db-${tag}`, net: `ayni-net-${tag}` }
const secret = () => randomBytes(18).toString('base64url')
const log = (...a) => process.stderr.write(`${a.join(' ')}\n`)

async function docker(...args) {
  const { stdout } = await run('docker', args, { maxBuffer: 64 * 1024 * 1024 })
  return stdout.trim()
}

/** `occ` in the container, as the web server's user; environment values given apart from the command line. */
async function occ(args, env = {}) {
  const e = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  return docker('exec', '-u', 'www-data', ...e, names.nc, 'php', 'occ', ...args)
}

async function sh(script, env = {}) {
  const e = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  return docker('exec', ...e, names.nc, 'sh', '-c', script)
}

/** A request to the Nextcloud over its HTTPS, trusting the authority made in the container. */
function nc(method, path, { user, password, headers = {}, body, ca, port }) {
  return new Promise((resolve, reject) => {
    const r = request(
      {
        hostname: HOST,
        port,
        path,
        method,
        lookup: (_h, o, cb) => (o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)),
        servername: HOST,
        ca: [ca],
        headers: {
          authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
          ...headers,
          ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      }
    )
    r.on('error', reject)
    r.end(body)
  })
}

async function waitFor(what, test, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await test()) return
    } catch {}
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`${what} did not come up`)
}

async function main() {
  try {
    await docker('info', '--format', '{{.ServerVersion}}')
  } catch {
    log('Docker is not running: nothing was started.')
    process.exit(2)
  }
  const pw = { admin: secret(), db: secret(), ana: secret(), jonas: secret(), 'ayni-manager': secret() }
  const cleanup = async () => {
    for (const c of [names.nc, names.mail, names.db]) await docker('rm', '-f', '-v', c).catch(() => undefined)
    await docker('network', 'rm', names.net).catch(() => undefined)
  }
  process.on('SIGINT', () => void cleanup().then(() => process.exit(130)))
  try {
    await docker('network', 'create', names.net)
    let mail = false
    try {
      await docker('run', '-d', '--rm', '--name', names.mail, '--network', names.net, '-p', '127.0.0.1::8025', MAILPIT)
      mail = true
    } catch {
      log('Mailpit could not start: the tests of messages are skipped.')
    }
    await docker(
      'run',
      '-d',
      '--name',
      names.db,
      '--network',
      names.net,
      '-e',
      'POSTGRES_USER=nextcloud',
      '-e',
      'POSTGRES_DB=nextcloud',
      '-e',
      `POSTGRES_PASSWORD=${pw.db}`,
      POSTGRES
    )
    await waitFor('PostgreSQL', async () => {
      // over TCP: the image's first start runs a server on its socket alone, then the real one
      await docker('exec', names.db, 'pg_isready', '-h', '127.0.0.1', '-U', 'nextcloud', '-d', 'nextcloud')
      return true
    })
    await docker(
      'run',
      '-d',
      '--name',
      names.nc,
      '--network',
      names.net,
      '-p',
      '127.0.0.1::443',
      '-e',
      `POSTGRES_HOST=${names.db}`,
      '-e',
      'POSTGRES_DB=nextcloud',
      '-e',
      'POSTGRES_USER=nextcloud',
      '-e',
      `POSTGRES_PASSWORD=${pw.db}`,
      '-e',
      'NEXTCLOUD_ADMIN_USER=nc-admin',
      '-e',
      `NEXTCLOUD_ADMIN_PASSWORD=${pw.admin}`,
      '-e',
      `NEXTCLOUD_TRUSTED_DOMAINS=${HOST} localhost`,
      IMAGE
    )
    log(`started ${IMAGE} as ${names.nc}`)
    // installed, and served: the image's entrypoint installs, then starts Apache in the foreground
    await waitFor('Nextcloud', async () =>
      (await sh('curl -s http://localhost/status.php')).includes('"installed":true')
    )
    const version = JSON.parse(await occ(['status', '--output=json'])).versionstring
    log(`Nextcloud ${version} installed`)
    // HTTPS inside the container, under an authority made there; its certificate alone comes out
    await sh(
      [
        'set -e',
        'cd /etc/ssl',
        'openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 -subj "/CN=Ayni test authority" -keyout ca.key -out ca.pem -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign 2>/dev/null',
        `openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=${HOST}" -keyout nc.key -out nc.csr 2>/dev/null`,
        `printf "subjectAltName=DNS:${HOST}\\nbasicConstraints=CA:FALSE\\nkeyUsage=digitalSignature\\nextendedKeyUsage=serverAuth\\n" > nc.ext`,
        'openssl x509 -req -in nc.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 -extfile nc.ext -out nc.pem 2>/dev/null',
        'a2enmod ssl >/dev/null',
        `printf '<VirtualHost *:443>\\nServerName ${HOST}\\nDocumentRoot /var/www/html\\nSSLEngine on\\nSSLCertificateFile /etc/ssl/nc.pem\\nSSLCertificateKeyFile /etc/ssl/nc.key\\n<Directory /var/www/html>\\nAllowOverride All\\nRequire all granted\\n</Directory>\\n</VirtualHost>\\n' > /etc/apache2/sites-enabled/ayni-ssl.conf`,
        'apachectl -k graceful',
      ].join(' && ')
    )
    const ca = await sh('cat /etc/ssl/ca.pem')
    const port = Number((await docker('port', names.nc, '443/tcp')).split(':').pop())
    await occ(['config:system:set', 'trusted_domains', '10', `--value=${HOST}:${port}`])
    await occ(['config:system:set', 'overwriteprotocol', '--value=https'])
    await occ(['config:system:set', 'skeletondirectory', '--value='])
    await occ(['config:system:set', 'auth.bruteforce.protection.enabled', '--value=false', '--type=boolean'])
    if (mail) {
      for (const [k, v] of [
        ['mail_smtpmode', 'smtp'],
        ['mail_smtphost', names.mail],
        ['mail_smtpport', '1025'],
        ['mail_from_address', 'cloud'],
        ['mail_domain', 'example.org'],
      ])
        await occ(['config:system:set', k, `--value=${v}`])
    }
    let teamFolders = true
    try {
      await occ(['app:install', 'groupfolders'])
    } catch (e) {
      if (!String(e.stderr ?? e.stdout ?? e).includes('already')) {
        teamFolders = false
        log('the Team folders app could not be installed (no app store?): team-roots is not tested')
      }
    }
    const people = [
      ['ana', 'Ana Example', 'ana@example.org'],
      ['jonas', 'Jonas Example', 'jonas@example.org'],
      ['ayni-manager', 'Ayni Manager', 'ayni-manager@example.org'],
    ]
    for (const [id, name, email] of people)
      await occ(['user:add', '--password-from-env', `--display-name=${name}`, `--email=${email}`, id], {
        OC_PASS: pw[id],
      })
    await occ(['group:adduser', 'admin', 'ayni-manager'])
    await waitFor(
      'HTTPS',
      async () => (await nc('GET', '/status.php', { user: 'ana', password: pw.ana, ca, port })).status === 200,
      30
    )

    // ---- the locations and fixtures, made with the server's own interfaces ------------------------------------
    const as =
      (user) =>
      (method, path, opts = {}) =>
        nc(method, path, { user, password: pw[user], ca, port, ...opts })
    const ana = as('ana')
    const jonas = as('jonas')
    const propfindId = async (who, path) => {
      const r = await who('PROPFIND', path, {
        headers: { depth: '0', 'content-type': 'application/xml' },
        body: '<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/></d:prop></d:propfind>',
      })
      return /<oc:fileid>(\d+)<\/oc:fileid>/.exec(r.body)?.[1]
    }
    await ana('MKCOL', '/remote.php/dav/files/ana/Conformance')
    const first = await propfindId(ana, '/remote.php/dav/files/ana/Conformance')
    await jonas('MKCOL', '/remote.php/dav/files/jonas/Shared%20with%20Ana')
    await jonas('PUT', '/remote.php/dav/files/jonas/Shared%20with%20Ana/Budget%20plan.md', { body: '# Budget plan\n' })
    const second = await propfindId(jonas, '/remote.php/dav/files/jonas/Shared%20with%20Ana')
    const shared = await jonas('POST', '/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', {
      headers: { 'ocs-apirequest': 'true', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        path: '/Shared with Ana',
        shareType: '0',
        shareWith: 'ana',
        permissions: '1',
        sendMail: 'false',
      }).toString(),
    })
    if (shared.status !== 200) throw new Error(`the share of the second location failed: ${shared.status}`)
    const cal = '/remote.php/dav/calendars'
    const tz =
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Ayni//EN\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Paris\r\nBEGIN:STANDARD\r\nDTSTART:19701025T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:19700329T020000\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\nEND:VCALENDAR\r\n'
    await ana('PROPPATCH', `${cal}/ana/personal/`, {
      headers: { 'content-type': 'application/xml' },
      body: `<d:propertyupdate xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><c:calendar-timezone><![CDATA[${tz}]]></c:calendar-timezone></d:prop></d:set></d:propertyupdate>`,
    })
    await jonas('MKCOL', `${cal}/jonas/team-alpha/`, {
      headers: { 'content-type': 'application/xml' },
      body: '<d:mkcol xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Team Alpha</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:set></d:mkcol>',
    })
    await jonas('POST', `${cal}/jonas/team-alpha/`, {
      headers: { 'content-type': 'application/xml' },
      body: '<cs:share xmlns:d="DAV:" xmlns:cs="http://owncloud.org/ns"><cs:set><d:href>principal:principals/users/ana</d:href></cs:set></cs:share>',
    })
    const floating =
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Ayni//EN\r\nBEGIN:VEVENT\r\nUID:floating-1\r\nDTSTAMP:20261101T000000Z\r\nDTSTART:20270112T090000\r\nDTEND:20270112T100000\r\nSUMMARY:A floating morning\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
    const conference =
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Ayni//EN\r\nBEGIN:VEVENT\r\nUID:conference-1\r\nDTSTAMP:20261101T000000Z\r\nDTSTART:20270114T150000Z\r\nDTEND:20270114T160000Z\r\nSUMMARY:A call\r\nCONFERENCE;VALUE=URI;FEATURE=VIDEO;LABEL=Talk:https://cloud.example.org/call/abc123\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
    for (const [name, body] of [
      ['floating-1.ics', floating],
      ['conference-1.ics', conference],
    ])
      await ana('PUT', `${cal}/ana/personal/${name}`, { headers: { 'content-type': 'text/calendar' }, body })

    // ---- the connector, trusting the container's authority and listing its loopback host ----------------------
    const logs = []
    const logger = Object.fromEntries(
      ['debug', 'info', 'warn', 'error'].map((l) => [l, (f, m) => logs.push(JSON.stringify({ l, m, ...f }))])
    )
    const connector = await startNextcloudConnector({
      logger,
      policy: hostPolicy([HOST]),
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      ca: [ca],
      // a paused container answers nothing: a short bound keeps the run of FEAT-CORE-007 short
      timeoutMs: 5000,
      port: 0,
      host: '127.0.0.1',
    })
    const origin = `https://${HOST}:${port}`
    const account = (id, email) => ({
      headers: { 'Ayni-Nextcloud': origin, 'Ayni-Dav-Username': id, 'Ayni-Dav-Password': pw[id] },
      address: email,
      secrets: [pw[id]],
    })
    const mailPort = mail ? Number((await docker('port', names.mail, '8025/tcp')).split(':').pop()) : 0
    const messages = async (address) => {
      const res = await fetch(
        `http://127.0.0.1:${mailPort}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}&limit=200`
      )
      const list = (await res.json()).messages ?? []
      const out = []
      for (const m of list) {
        const full = await (await fetch(`http://127.0.0.1:${mailPort}/api/v1/message/${m.ID}`)).json()
        out.push({ to: address, subject: full.Subject, text: `${full.Text ?? ''}\n${full.HTML ?? ''}` })
      }
      return out
    }
    const base = {
      url: connector.url,
      accounts: {
        A: account('ana', 'ana@example.org'),
        B: account('jonas', 'jonas@example.org'),
        ...(teamFolders ? { M: account('ayni-manager', 'ayni-manager@example.org') } : {}),
      },
      organization: { noAccount: 'nobody@example.org' },
      era: 'modern',
    }
    const hooks = (withMessages) => ({
      stopService: async () => void (await docker('pause', names.nc)),
      startService: async () => void (await docker('unpause', names.nc)),
      logs: async () => logs.join('\n'),
      ...(withMessages && mail ? { messages } : {}),
    })
    const reports = []
    log('the conformance kit, Files, with the messages of Mailpit')
    reports.push(
      await runConformance({
        ...base,
        files: { first: { ref: first, path: '/Conformance' }, second: { ref: second, path: '/Shared with Ana' } },
        hooks: hooks(true),
      })
    )
    log('the conformance kit, Calendar')
    reports.push(
      await runConformance({
        ...base,
        calendar: {
          first: { ref: `${cal}/ana/personal/` },
          second: { ref: `${cal}/ana/team-alpha_shared_by_jonas/` },
          bCalendar: `${cal}/jonas/personal/`,
          fixtures: {
            floating: { ref: `${cal}/ana/personal/floating-1.ics`, start: '2027-01-12T09:00:00+01:00' },
            conference: `${cal}/ana/personal/conference-1.ics`,
          },
        },
        hooks: hooks(false),
      })
    )
    if (process.argv.includes('--plain')) {
      // the same server through the plain path (providers §3, §4): its WebDAV by path, its CalDAV found from its root
      const plain = (id, email) => ({
        headers: {
          'Ayni-Dav-Files': `${origin}/remote.php/dav/files/${id}/`,
          'Ayni-Dav-Calendars': `${origin}/`,
          'Ayni-Dav-Username': id,
          'Ayni-Dav-Password': pw[id],
        },
        address: email,
        secrets: [pw[id]],
      })
      await ana('MKCOL', '/remote.php/dav/files/ana/Conformance%20plain')
      log('the conformance kit through the plain path, Files and Calendar')
      const viaPlain = await runConformance({
        url: connector.url,
        accounts: { A: plain('ana', 'ana@example.org'), B: plain('jonas', 'jonas@example.org') },
        organization: { noAccount: 'nobody@example.org' },
        era: 'modern',
        files: {
          first: { ref: '/Conformance plain', path: '/Conformance plain' },
          second: { ref: '/Shared with Ana', path: '/Shared with Ana' },
        },
        calendar: {
          first: { ref: `${cal}/ana/personal/` },
          second: { ref: `${cal}/ana/team-alpha_shared_by_jonas/` },
          bCalendar: `${cal}/jonas/personal/`,
        },
        hooks: hooks(false),
      })
      for (const r of viaPlain.results) r.profile = `${r.profile} (plain path)`
      reports.push(viaPlain)
    }
    if (process.argv.includes('--calendar-messages') && mail) {
      // what Nextcloud sends of invitations, changes and answers: FEAT-CAL-042 fails here by design, the connector
      // refusing a cancellation's comment that CalDAV's scheduling carries to nobody
      log('the conformance kit, Calendar, with the messages of Mailpit')
      const withMessages = await runConformance({
        ...base,
        calendar: {
          first: { ref: `${cal}/ana/personal/` },
          second: { ref: `${cal}/ana/team-alpha_shared_by_jonas/` },
          bCalendar: `${cal}/jonas/personal/`,
        },
        hooks: hooks(true),
      })
      for (const r of withMessages.results) r.profile = `${r.profile} (with messages)`
      reports.push(withMessages)
    }
    await connector.running.close()
    const rows = reports.flatMap((r) => r.results)
    const totals = {}
    for (const r of rows) {
      totals[r.profile] ??= { pass: 0, fail: 0, skip: 0, manual: 0, 'not-applicable': 0 }
      totals[r.profile][r.status]++
    }
    process.stdout.write(`Nextcloud ${version}\n${JSON.stringify(totals, null, 2)}\n`)
    for (const r of rows.filter((x) => x.status !== 'pass'))
      process.stdout.write(`${r.status.toUpperCase()} ${r.profile} ${r.id}: ${r.detail ?? ''}\n`)
    const out = process.argv.indexOf('--json')
    if (out > 0 && process.argv[out + 1]) {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(process.argv[out + 1], JSON.stringify({ version, totals, results: rows }, null, 2))
    }
    process.exitCode = rows.some((r) => r.status === 'fail') ? 1 : 0
  } finally {
    await cleanup()
    log('containers, their volumes and the network removed')
  }
}

await main()
