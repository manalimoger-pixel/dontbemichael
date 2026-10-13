'use strict';

/**
 * Multi-mailbox (docs/designs/multi-mailbox.md): the access rule and the mail
 * service against an injected fake IMAP/SMTP client (eng review E4, unit part).
 * The protocol-level half runs against local servers in mail-integration.test.cjs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { mailAccess, agentMailboxes, mailToolsJustAttached, mailboxIdFor, isMicrosoftAddress, mxPointsToMicrosoft, isMicrosoftMxExchange } = loadTs('src/shared/mailboxes.ts');
const { MailService, handleMailRequest, classifyMailError, setAgentCapabilities } = loadTs('src/main/mail.ts');

const server = { host: 'h', port: 993, secure: true };
const box = (id, address, provider = 'gmail') => ({ id, address, provider, imap: server, smtp: server, status: 'connected', createdAt: 1, updatedAt: 1 });

function cfg(over = {}) {
  return {
    mcpDefaults: { 'email-calendar': { enabled: true } },
    mailboxes: [box('sales', 'sales@x.com'), box('ceo', 'ceo@x.com', 'icloud')],
    agentCapabilities: {
      dwight: { email: { enabled: true, mailboxes: ['sales'], send: true } },
      pam: { email: { enabled: true, mailboxes: ['ceo'], send: false } }
    },
    ...over
  };
}

const raw = (from, subject, body, id) => Buffer.from(`From: ${from}\r\nTo: sales@x.com\r\nSubject: ${subject}\r\nMessage-ID: <${id}@x.com>\r\nDate: Fri, 25 Sep 2026 10:00:00 +0000\r\n\r\n${body}\r\n`);

function fakeImap(state) {
  let folder = 'INBOX';
  return {
    usable: true,
    async connect() { state.connects = (state.connects ?? 0) + 1; if (state.failConnect) { const e = state.failConnect; state.failConnect = state.failConnectOnce ? null : e; throw e; } },
    async logout() {},
    async list() { return [{ path: 'INBOX' }, { path: 'Drafts', specialUse: '\\Drafts' }, { path: 'Sent', specialUse: '\\Sent' }]; },
    async getMailboxLock(p) { folder = p; return { release() {} }; },
    async search(q) {
      if (q.header) return (typeof state.sentHit === 'function' ? state.sentHit(q.header['message-id']) : state.sentHit) ? [1] : [];
      return state.folders[folder].filter((m) => !q.from || m.from.includes(q.from)).map((m) => m.uid);
    },
    async *fetch(uids) { for (const m of state.folders[folder]) if (uids.includes(m.uid)) yield { uid: m.uid, envelope: { from: [{ address: m.from }], subject: m.subject, date: new Date('2026-09-25') }, flags: new Set(m.seen ? ['\\Seen'] : []) }; },
    async fetchOne(uid, query = {}) {
     const m = state.folders[folder].find((x) => String(x.uid) === String(uid));
     if (!m) return false;

     if (m.bodyStructure && query.source) {
       throw new Error('Full email source must not be downloaded for this message');
     }

     return {
       uid: m.uid,
       source: m.source,
       flags: new Set(m.seen ? ['\\Seen'] : []),
       envelope: {
         from: [{ address: m.from }],
         to: [{ address: 'sales@x.com' }],
         subject: m.subject,
         date: new Date('2026-09-25')
        },
       bodyStructure: m.bodyStructure ?? {
         part: '1',
         type: 'text/plain',
         size: m.source.length
        }
      };
    },
    async download(uid, part) {
     const m = state.folders[folder].find((x) => String(x.uid) === String(uid));
     if (!m) return {};
     
     if (part !== '1') {
       throw new Error(`Unexpected MIME part downloaded: ${part}`);
    }
     const { Readable } = require('node:stream');
     const source = m.source.toString('utf8');
     const body = source.split(/\r?\n\r?\n/).slice(1).join('\r\n\r\n');
     return {
       meta: {},
       content: Readable.from([Buffer.from(body)])
      };
    },
    async append(p, content) { state.folders[p].push({ uid: 100 + state.folders[p].length, from: '', subject: '', source: content }); }
  };
}

function setup(over = {}) {
  const state = {
    folders: {
      INBOX: [
        { uid: 1, from: 'acme@buyer.com', subject: 'Quote please', source: raw('acme@buyer.com', 'Quote please', 'Can you quote 40 units?', 'm1') },
        { uid: 2, from: 'bob@other.com', subject: 'Hello', source: raw('bob@other.com', 'Hello', 'x'.repeat(60_000), 'm2'), seen: true }
      ],
      Drafts: [], Sent: []
    },
    sends: [], statuses: []
  };
  const config = cfg(over.config);
  const deps = {
    getConfig: () => config,
    getPassword: (id) => (id === 'sales' || id === 'ceo' ? 'app-pass' : undefined),
    markStatus: (id, status, reason) => state.statuses.push({ id, status, reason }),
    createImap: () => fakeImap(state),
    createSmtp: () => ({ async sendMail(m) { if (state.smtpError) throw state.smtpError; state.sends.push(m); return { messageId: m.messageId }; }, async verify() {}, close() {} }),
    resolveMx: over.resolveMx ?? (async () => [])
  };
  const svc = new MailService(deps);
  const call = (agent, op, body) => handleMailRequest(svc, deps, agent, op, body);
  return { state, svc, call, config };
}

test('mailAccess: the one rule, in order', () => {
  const c = cfg();
  // The Claude account switch does not touch added mailboxes (owner, 2026-09-26).
  assert.equal(mailAccess({ ...c, mcpDefaults: {} }, 'dwight', 'sales', 'read').ok, true);
  assert.equal(mailAccess(c, 'pam', 'claude-account', 'read').ok, false, 'the Claude account is not a capability');
  assert.equal(mailAccess(c, 'kelly', 'sales', 'read').ok, false, 'no email capability');
  assert.equal(mailAccess(c, 'dwight', 'ceo', 'read').ok, false, 'not his mailbox');
  assert.equal(mailAccess(c, 'dwight', 'sales', 'send').ok, true);
  assert.equal(mailAccess(c, 'pam', 'ceo', 'send').ok, false, 'Draft only');
  assert.equal(mailAccess(c, 'pam', 'ceo', 'draft').ok, true);
  assert.equal(mailAccess({ ...c, mailboxes: [] }, 'dwight', 'sales', 'read').ok, false, 'removed in Settings');
  assert.equal(mailAccess(c, 'dwight', undefined, 'list').ok, true);
  assert.deepEqual(agentMailboxes({ ...c, agentCapabilities: { pam: { email: { enabled: true, mailboxes: ['ceo', 'claude-account'], send: false } } } }, 'pam'), ['ceo'], 'unknown ids dropped');
});

test('one mailbox per agent: only the first counts, and a save keeps one (owner, 2026-09-26)', () => {
  const c = cfg({ agentCapabilities: { dwight: { email: { enabled: true, mailboxes: ['sales', 'ceo'], send: true } } } });
  assert.equal(mailAccess(c, 'dwight', 'sales', 'read').ok, true);
  assert.equal(mailAccess(c, 'dwight', 'ceo', 'read').ok, false, 'a second mailbox from an older record is ignored');
  assert.deepEqual(agentMailboxes(c, 'dwight'), ['sales']);
  let saved;
  const admin = { getConfig: () => c, saveConfig: (patch) => { saved = patch; } };
  setAgentCapabilities(admin, 'dwight', { email: { enabled: true, mailboxes: ['ceo', 'sales'], send: false } });
  assert.deepEqual(saved.agentCapabilities.dwight.email.mailboxes, ['ceo']);
});

test('helpers: first enable, ids, Microsoft addresses', () => {
  assert.equal(mailToolsJustAttached(undefined, { email: { enabled: true, mailboxes: [], send: false } }), true);
  assert.equal(mailToolsJustAttached({ email: { enabled: true, mailboxes: [], send: false } }, { email: { enabled: true, mailboxes: ['a'], send: false } }), false);
  assert.equal(mailboxIdFor('Sales@Example.com'), 'sales-example-com');
  assert.equal(mailboxIdFor('sales@example.com', ['sales-example-com']), 'sales-example-com-2');
  assert.equal(isMicrosoftAddress('a@outlook.com'), true);
  assert.equal(isMicrosoftAddress('a@gmail.com'), false);
});

test('helpers: Microsoft 365 MX records catch custom domains (issue 39)', () => {
  assert.equal(isMicrosoftMxExchange('github-com.mail.protection.outlook.com'), true);
  assert.equal(isMicrosoftMxExchange('github-com.mail.protection.outlook.com.'), true);
  assert.equal(isMicrosoftMxExchange('MICROSOFT-COM.MAIL.PROTECTION.OUTLOOK.COM'), true);
  assert.equal(isMicrosoftMxExchange('aspmx.l.google.com'), false);
  assert.equal(mxPointsToMicrosoft([{ exchange: 'x' }].map((r) => r.exchange)), false);
  assert.equal(mxPointsToMicrosoft(['aspmx.l.google.com']), false);
  assert.equal(mxPointsToMicrosoft(['github-com.mail.protection.outlook.com']), true);
  assert.equal(mxPointsToMicrosoft([]), false);
});

test('list_mailboxes shows only the agent\'s own mailboxes and its sending right', async () => {
  const { call } = setup();
  const r = await call('pam', 'list_mailboxes', {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.mailboxes.map((m) => m.mailbox), ['ceo']);
  assert.equal(r.body.sending, 'draft only');
  assert.equal((await call('kelly', 'list_mailboxes', {})).status, 403);
});

test('search and read work in the agent\'s mailbox; bodies are capped', async () => {
  const { call } = setup();
  const s = await call('dwight', 'search', { mailbox: 'sales', from: 'acme' });
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.messages.map((m) => m.subject), ['Quote please']);
  const r = await call('dwight', 'read', { mailbox: 'sales', id: '1' });
  assert.equal(r.status, 200);
  assert.match(r.body.text, /40 units/);
  const big = await call('dwight', 'read', { mailbox: 'sales', id: '2' });
  assert.equal(big.body.truncated, true);
  assert.equal((await call('dwight', 'search', { mailbox: 'ceo' })).status, 403, 'not his mailbox');
});

test('reading an email does not download its attachment', async () => {
  const { state, call } = setup();

  const message = state.folders.INBOX[0];
  let downloadedPart = null;

  // Give this message a simulated 25 MB attachment.
  message.bodyStructure = {
    type: 'multipart/mixed',
    childNodes: [
      { part: '1', type: 'text/plain', size: 20 },
      {
        part: '2',
        type: 'application/pdf',
        disposition: 'attachment',
        dispositionParameters: { filename: 'report.pdf' },
        size: 25_000_000
      }
    ]
  };

  const result = await call('dwight', 'read', {
    mailbox: 'sales',
    id: '1'
  });

  assert.equal(result.status, 200);
  assert.match(result.body.text, /40 units/);
  assert.deepEqual(result.body.attachments, [
    { name: 'report.pdf', size: 25_000_000 }
  ]);
});

test('attachment-only email has an empty text body', async () => {
  const { state, call } = setup();

  state.folders.INBOX[0].bodyStructure = {
    type: 'application/pdf',
    part: '1',
    disposition: 'attachment',
    dispositionParameters: { filename: 'invoice.pdf' },
    size: 25_000_000
  };

  const result = await call('dwight', 'read', {
    mailbox: 'sales',
    id: '1'
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.text, '');
  assert.deepEqual(result.body.attachments, [
    { name: 'invoice.pdf', size: 25_000_000 }
  ]);
});
test('large email body is marked as truncated', async () => {
  const { state, call } = setup();

  const message = state.folders.INBOX[0];

  message.bodyStructure = {
    part: '1',
    type: 'text/plain',
    size: 300_000
  };

  const result = await call('dwight', 'read', {
    mailbox: 'sales',
    id: '1'
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.truncated, true);
  assert.match(result.body.text, /message cut at 50000 characters/);
});

test('draft lands in Drafts; Draft only cannot send', async () => {
  const { call, state } = setup();
  const d = await call('pam', 'draft', { mailbox: 'ceo', to: 'a@b.com', subject: 'Re: x', body: 'Draft body' });
  assert.equal(d.status, 200);
  assert.equal(state.folders.Drafts.length, 1);
  assert.match(state.folders.Drafts[0].source.toString(), /Draft body/);
  const s = await call('pam', 'send', { mailbox: 'ceo', to: 'a@b.com', subject: 'Re: x', body: 'Draft body' });
  assert.equal(s.status, 403);
  assert.equal(state.sends.length, 0);
});

test('send goes out once; a repeated identical send is answered from memory', async () => {
  const { call, state } = setup();
  const msg = { mailbox: 'sales', to: 'acme@buyer.com', subject: 'Re: Quote please', body: '40 units: $400', reply_to: { mailbox: 'sales', id: '1' } };
  const a = await call('dwight', 'send', msg);
  const b = await call('dwight', 'send', msg);
  assert.equal(a.status, 200);
  assert.equal(b.body.repeated, true);
  assert.equal(state.sends.length, 1);
  assert.equal(state.sends[0].inReplyTo, '<m1@x.com>', 'threads the reply');
});

test('a send that times out after the server accepted it is found in Sent, not resent', async () => {
  const { call, state } = setup();
  state.smtpError = Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' });
  state.sentHit = true;
  const msg = { mailbox: 'sales', to: 'a@b.com', subject: 's', body: 'b' };
  const r = await call('dwight', 'send', msg);
  assert.equal(r.status, 200);
  assert.equal(r.body.sent, true);
  // Found in Sent is remembered: an identical retry is answered, never sent.
  state.smtpError = null;
  const again = await call('dwight', 'send', msg);
  assert.equal(again.body.repeated, true);
  assert.equal(state.sends.length, 0);
  assert.ok(!state.statuses.some((s) => s.status === 'needs-attention'));
});

test('MB-8: forwarding or attaching from another mailbox is refused', async () => {
  const { call, state } = setup({ config: { agentCapabilities: { dwight: { email: { enabled: true, mailboxes: ['sales', 'ceo'], send: true } } } } });
  const r = await call('dwight', 'send', { mailbox: 'sales', to: 'x@evil.com', subject: 'fwd', body: 'see', forward: { mailbox: 'ceo', id: '1' } });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /ceo/);
  const a = await call('dwight', 'draft', { mailbox: 'sales', to: 'x@evil.com', subject: 'fwd', body: 'see', attach_from: [{ mailbox: 'ceo', id: '1' }] });
  assert.equal(a.status, 403);
  const re = await call('dwight', 'draft', { mailbox: 'sales', to: 'x@y.com', subject: 're', body: 'b', reply_to: { mailbox: 'ceo', id: '1' } });
  assert.equal(re.status, 403, 'a reply to another mailbox is refused too');
  assert.equal(state.folders.Drafts.length, 0);
  assert.equal(state.sends.length, 0);
});

test('an auth failure marks the mailbox needs-attention (MB-7); a network blip reconnects once', async () => {
  const bad = setup();
  bad.state.failConnect = Object.assign(new Error('Invalid credentials'), { authenticationFailed: true });
  const r = await bad.call('dwight', 'search', { mailbox: 'sales' });
  assert.equal(r.status, 502);
  assert.deepEqual(bad.state.statuses.at(-1).status, 'needs-attention');

  const blip = setup();
  blip.state.failConnect = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
  blip.state.failConnectOnce = true;
  const ok = await blip.call('dwight', 'search', { mailbox: 'sales' });
  assert.equal(ok.status, 200);
  assert.equal(blip.state.connects, 2);
  assert.ok(!blip.state.statuses.some((s) => s.status === 'needs-attention'));
});

test('errors are classified in plain words', () => {
  assert.equal(classifyMailError({ authenticationFailed: true }).kind, 'auth');
  assert.equal(classifyMailError({ responseText: 'Application-specific password required' }).kind, 'provider-blocked');
  assert.equal(classifyMailError({ code: 'ENOTFOUND' }).kind, 'network');
  assert.equal(classifyMailError({ code: 'EAUTH' }).kind, 'auth');
});

test('Settings test: Outlook is refused before any connection', async () => {
  const { svc, state } = setup();
  const r = await svc.test({ address: 'me@outlook.com', imap: server, smtp: server }, 'x');
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'unsupported');
  assert.equal(state.connects, undefined);
  assert.deepEqual(await svc.test({ address: 'sales@x.com', imap: server, smtp: server }, 'app-pass'), { ok: true });
});

test('send journal persists deduplication IDs to journalPath across service instances', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-journal-test-'));
  const journalPath = path.join(tmpDir, 'journal.json');

  try {
    const config = cfg();
    const sends1 = [];
    const deps1 = {
      getConfig: () => config,
      getPassword: () => 'app-pass',
      markStatus: () => {},
      createImap: () => fakeImap({ folders: { INBOX: [], Drafts: [], Sent: [] } }),
      createSmtp: () => ({ async sendMail(m) { sends1.push(m); return { messageId: '<msg-101>' }; }, async verify() {}, close() {} }),
      journalPath
    };
    const svc1 = new MailService(deps1);
    const msg = { mailbox: 'sales', to: 'customer@buyer.com', subject: 'Quote', body: 'Quote details' };

    const res1 = await handleMailRequest(svc1, deps1, 'dwight', 'send', msg);
    assert.equal(res1.status, 200);
    assert.equal(sends1.length, 1);
    assert.ok(fs.existsSync(journalPath), 'journal file was written');

    // Simulate app restart with a new MailService instance reading from journalPath
    const sends2 = [];
    const deps2 = {
      getConfig: () => config,
      getPassword: () => 'app-pass',
      markStatus: () => {},
      createImap: () => fakeImap({ folders: { INBOX: [], Drafts: [], Sent: [] } }),
      createSmtp: () => ({ async sendMail(m) { sends2.push(m); return { messageId: '<msg-102>' }; }, async verify() {}, close() {} }),
      journalPath
    };
    const svc2 = new MailService(deps2);

    const res2 = await handleMailRequest(svc2, deps2, 'dwight', 'send', msg);
    assert.equal(res2.status, 200);
    assert.equal(res2.body.repeated, true);
    assert.equal(sends2.length, 0, 'did not send again across restart');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── A send the app stopped in the middle of (TODOS: never send twice across a restart) ──

/** A mail service on its own journal. `onSend` runs when the server gets the
 *  email, before it answers: the journal as it is then is what a crash leaves.
 *  `sentHit` answers the Sent search for a Message-ID. */
function journalSetup(journalPath, { sentHit = false, onSend, config = cfg(), audit } = {}) {
  const state = { folders: { INBOX: [], Drafts: [], Sent: [] }, sentHit, sends: [] };
  const deps = {
    getConfig: () => config,
    getPassword: () => 'app-pass',
    markStatus: () => {},
    createImap: () => fakeImap(state),
    createSmtp: () => ({ async sendMail(m) { if (onSend) await onSend(m); state.sends.push(m); return { messageId: m.messageId }; }, async verify() {}, close() {} }),
    journalPath
  };
  const svc = new MailService(deps);
  const brokerDeps = { getConfig: () => config, ...(audit ? { audit } : {}) };
  return { state, call: (body, agent = 'dwight') => handleMailRequest(svc, brokerDeps, agent, 'send', body) };
}

function withJournalDir(run) {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail journal '));
  return Promise.resolve(run(dir, fs, path)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const quote = { mailbox: 'sales', to: 'customer@buyer.com', subject: 'Quote', body: 'Quote details' };

/** Sends once and keeps the journal as it was while the server had the email:
 *  the state a crash at that moment leaves on disk. */
async function journalAtCrash(dir, fs, path, { body = quote, config } = {}) {
  const journalPath = path.join(dir, 'journal.json');
  let atCrash = null;
  const first = journalSetup(journalPath, { config, onSend: () => { atCrash = fs.readFileSync(journalPath, 'utf8'); } });
  const res = await first.call(body);
  assert.equal(res.status, 200);
  const crashed = path.join(dir, 'after-crash.json');
  fs.writeFileSync(crashed, atCrash);
  return { crashed, messageId: res.body.messageId };
}

/** Moves every entry in a journal back in time. */
function ageJournal(fs, file, ms) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const v of Object.values(j)) v.at -= ms;
  fs.writeFileSync(file, JSON.stringify(j));
}

const savedAs = (fs, file) => Object.values(JSON.parse(fs.readFileSync(file, 'utf8'))).map((v) => [v.messageId, v.pending]);

test('send journal: a send is saved as pending before the server sees it, and as sent after', () => withJournalDir(async (dir, fs, path) => {
  const journalPath = path.join(dir, 'journal.json');
  let during = null;
  const { call } = journalSetup(journalPath, { onSend: () => { during = savedAs(fs, journalPath); } });
  const res = await call(quote);
  assert.equal(res.status, 200);
  assert.deepEqual(during, [[res.body.messageId, true]], 'on disk before the server answered');
  assert.deepEqual(savedAs(fs, journalPath), [[res.body.messageId, undefined]]);
}));

test('send journal: after a stop mid-send, a retry finds that Message-ID in Sent and gets the first result, never a second copy', () => withJournalDir(async (dir, fs, path) => {
  const { crashed, messageId } = await journalAtCrash(dir, fs, path);
  ageJournal(fs, crashed, 11 * 60_000); // restarted after the repeat window
  const looked = [];
  const restarted = journalSetup(crashed, { sentHit: (id) => { looked.push(id); return id === messageId; } });
  const res = await restarted.call(quote);
  assert.equal(res.status, 200);
  assert.equal(res.body.messageId, messageId, 'the first Message-ID');
  assert.equal(res.body.repeated, undefined, 'not marked repeated: the stopped run never recorded it, so this caller does');
  assert.deepEqual(looked, [messageId], 'Sent was searched for the pending Message-ID');
  assert.equal(restarted.state.sends.length, 0, 'nothing went to the server');
  const again = await restarted.call(quote);
  assert.equal(again.body.messageId, messageId);
  assert.equal(again.body.repeated, true, 'settled: a later repeat is an ordinary repeat, its window starting now');
  assert.deepEqual(savedAs(fs, crashed), [[messageId, undefined]], 'saved as sent');
}));

test('send journal: a grant send settled after a stop is written to the office log once', () => withJournalDir(async (dir, fs, path) => {
  // Dwight sends only from Pam's mailbox.
  const config = cfg();
  config.agentCapabilities.dwight.sendOnly = { mailbox: 'ceo', sending: 'send' };
  const body = { ...quote, mailbox: 'ceo' };
  const { crashed, messageId } = await journalAtCrash(dir, fs, path, { body, config });
  const audit = [];
  const restarted = journalSetup(crashed, { config, sentHit: (id) => id === messageId, audit: (e) => audit.push(e) });
  assert.equal((await restarted.call(body)).status, 200);
  assert.equal((await restarted.call(body)).status, 200);
  assert.deepEqual(audit, [{ kind: 'mail-sent', agentId: 'dwight', mailbox: 'ceo', messageId, grant: true }]);
  assert.equal(restarted.state.sends.length, 0);
}));

test('send journal: two identical retries during the Sent check share one check and one result', () => withJournalDir(async (dir, fs, path) => {
  const { crashed, messageId } = await journalAtCrash(dir, fs, path);
  let checks = 0;
  const restarted = journalSetup(crashed, { sentHit: (id) => { checks++; return id === messageId; } });
  const [a, b] = await Promise.all([restarted.call(quote), restarted.call(quote)]);
  assert.deepEqual([a.status, b.status, a.body.messageId, b.body.messageId], [200, 200, messageId, messageId]);
  assert.deepEqual([a.body.repeated, b.body.repeated], [undefined, true], 'recorded by one caller only');
  assert.equal(checks, 1);
}));

test('send journal: after a stop mid-send with no copy in Sent, the retry is refused in plain words, and stays refused after another restart', () => withJournalDir(async (dir, fs, path) => {
  const { crashed } = await journalAtCrash(dir, fs, path);
  const restarted = journalSetup(crashed, { sentHit: false });
  for (let i = 0; i < 2; i++) {
    const res = await restarted.call(quote);
    assert.deepEqual([res.status, res.body.kind], [502, 'refused']);
    assert.match(res.body.error, /may already have gone out: sending it was interrupted, and it is not in Sent yet\. Do not send it again; tell Michael/);
  }
  const again = journalSetup(crashed, { sentHit: false });
  assert.equal((await again.call(quote)).body.kind, 'refused', 'a second restart still refuses it');
  assert.equal(restarted.state.sends.length + again.state.sends.length, 0);
  // Changed in any way, it is a different email and goes out.
  assert.equal((await again.call({ ...quote, body: 'Quote details, revised' })).status, 200);
  assert.equal(again.state.sends.length, 1);
}));

test('send journal: when Sent cannot be reached after a stop, nothing is sent and a later try checks again', () => withJournalDir(async (dir, fs, path) => {
  const { crashed, messageId } = await journalAtCrash(dir, fs, path);
  const restarted = journalSetup(crashed, { sentHit: (id) => id === messageId });
  restarted.state.failConnect = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const res = await restarted.call(quote);
  assert.deepEqual([res.status, res.body.kind], [502, 'network']);
  assert.match(res.body.error, /Sent could not be checked for it.*Try again in a moment/);
  assert.equal(restarted.state.sends.length, 0);
  restarted.state.failConnect = null;
  const later = await restarted.call(quote);
  assert.equal(later.status, 200);
  assert.equal(later.body.messageId, messageId);
  assert.equal(restarted.state.sends.length, 0);
}));

test('send journal: when Sent cannot be checked for a lasting reason after a stop, it is refused, not retried', () => withJournalDir(async (dir, fs, path) => {
  const { crashed } = await journalAtCrash(dir, fs, path);
  const restarted = journalSetup(crashed, { sentHit: true });
  restarted.state.failConnect = Object.assign(new Error('Invalid credentials'), { authenticationFailed: true });
  const res = await restarted.call(quote);
  assert.deepEqual([res.status, res.body.kind], [502, 'refused']);
  assert.match(res.body.error, /may already have gone out/);
  assert.equal(restarted.state.sends.length, 0);
}));

test('send journal: a send that cannot be recorded first does not go out', () => withJournalDir(async (dir, fs, path) => {
  const { call, state } = journalSetup(path.join(dir, 'missing folder', 'journal.json'));
  const res = await call(quote);
  assert.deepEqual([res.status, res.body.kind], [502, 'unknown']);
  assert.match(res.body.error, /^Not sent\. The app could not record this send before sending it/);
  assert.equal(state.sends.length, 0);
}));

test('a dropped connection mid-send with no copy in Sent is held, and a repeat is not sent (issue 101)', () => withJournalDir(async (dir, fs, path) => {
  // Value: protects=a customer never gets the same email twice after a flaky connection; fails_when=an uncertain drop reads as not sent and the retry sends a second copy; why_new=issue 101; seam=fake SMTP
  let tries = 0;
  const { call, state } = journalSetup(path.join(dir, 'journal.json'), { onSend: () => { tries++; throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); } });
  const first = await call(quote);
  assert.equal(first.status, 502);
  assert.match(first.body.error, /may already have gone out: the connection dropped before the mail server answered, and it is not in Sent yet\. Do not send it again; tell Michael/);
  const again = await call(quote);
  assert.deepEqual([again.status, again.body.kind], [502, 'refused']);
  assert.match(again.body.error, /may already have gone out: sending it was interrupted/);
  assert.equal(tries, 1, 'the server saw the email once');
  assert.equal(state.sends.length, 0);
}));

test('a mail server that was never reached is not held: the retry goes out (issue 101)', () => withJournalDir(async (dir, fs, path) => {
  // Value: protects=an email that surely never left can be sent again; fails_when=a refused connection is held like a drop; why_new=issue 101; seam=fake SMTP
  let down = true;
  const { call, state } = journalSetup(path.join(dir, 'journal.json'), { onSend: () => { if (down) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); } });
  const first = await call(quote);
  assert.equal(first.status, 502);
  assert.match(first.body.error, /^Not sent\./);
  down = false;
  assert.equal((await call(quote)).status, 200);
  assert.equal(state.sends.length, 1);
}));

test('send journal: a send the server refused is cleared, so a retry goes out', () => withJournalDir(async (dir, fs, path) => {
  const journalPath = path.join(dir, 'journal.json');
  let refuse = true;
  const { call, state } = journalSetup(journalPath, { onSend: () => { if (refuse) throw Object.assign(new Error('Message rejected'), { responseCode: 550 }); } });
  assert.notEqual((await call(quote)).status, 200);
  assert.deepEqual(savedAs(fs, journalPath), [], 'nothing left pending');
  refuse = false;
  assert.equal((await call(quote)).status, 200);
  assert.equal(state.sends.length, 1);
}));

test('send journal: a send left pending stays refused past the repeat window, for a day', () => withJournalDir(async (dir, fs, path) => {
  const { crashed } = await journalAtCrash(dir, fs, path);
  ageJournal(fs, crashed, 11 * 60_000);
  assert.equal((await journalSetup(crashed).call(quote)).body.kind, 'refused', 'past the 10 minute repeat window, still refused');
  ageJournal(fs, crashed, 24 * 60 * 60_000);
  const later = journalSetup(crashed);
  assert.equal((await later.call(quote)).status, 200, 'a day on, it is a new send');
  assert.equal(later.state.sends.length, 1);
}));

test('Settings test: a custom domain on Microsoft 365 gets the same message (issue 39)', async () => {
  const { svc, state } = setup({ resolveMx: async () => [{ exchange: 'github-com.mail.protection.outlook.com', priority: 0 }] });
  const r = await svc.test({ address: 'test@github.com', imap: server, smtp: server }, 'x');
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'unsupported');
  assert.match(r.reason, /Microsoft 365/);
  assert.equal(state.connects, undefined);
});

test('Settings test: a DNS failure never blocks a working mailbox (issue 39)', async () => {
  const { svc } = setup({ resolveMx: async () => { throw Object.assign(new Error('queryMx ENOTFOUND'), { code: 'ENOTFOUND' }); } });
  assert.deepEqual(await svc.test({ address: 'sales@x.com', imap: server, smtp: server }, 'app-pass'), { ok: true });
});
