/**
 * Mail client for connected mailboxes (docs/designs/multi-mailbox.md, eng T1).
 *
 * Main process only. The broker calls `handleMailRequest` for an agent's md-mail
 * tool call; the Settings screen calls `testMailbox` before saving a mailbox.
 * Passwords never leave the main process: they are read from the secret store
 * through `deps.getPassword` at call time.
 *
 * One IMAP connection per mailbox, reused across agents and serialized per folder
 * with ImapFlow's mailbox lock; closed after it sits idle. Sends go through SMTP
 * with a Message-ID the broker chooses, so a retried send is answered from memory
 * instead of sending twice, and a send that times out is looked up in Sent before
 * it is reported (send once).
 *
 * The IMAP and SMTP factories are injected so tests can use a fake client or
 * local test servers (eng review E4).
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { resolveMx } from 'node:dns/promises';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { simpleParser } from 'mailparser';
import { writeFileAtomic } from './atomicFile';
import { SECRETS_FILE_UNREADABLE } from '../shared/secretStore';
import {
  MAIL_TOOL_OPS,
  agentMailboxes,
  asSendingMode,
  grantPaused,
  isMicrosoftAddress,
  mxPointsToMicrosoft,
  mailboxHolder,
  mailAccess,
  mailboxAddress,
  mailboxIdFor,
  mailToolsJustAttached,
  secretRefForMailbox,
  sendOnlyGrant,
  sendingFor,
  sendingMode,
  sendingWords,
  type MailAccessConfig,
  type SendingMode,
  type AgentCapabilities,
  type SendOnlyGrant,
  type MailboxRecord,
  type MailServer
} from '../shared/mailboxes';
import { OWN_SENDS_ONLY, proposalSendProblem, standingProblem, standingTooLong, threadFrom, STANDING_KIND_MAX, type MailProposal, type SendRecord, type StandingApproval, type StandingCheckEmail, type ThreadHeaders } from '../shared/mailProposals';

// Limits (eng review E6 left these to the implementer).
const CALL_TIMEOUT_MS = 30_000;
const SEND_TIMEOUT_MS = 60_000;
const MX_LOOKUP_TIMEOUT_MS = 5_000;
const SEARCH_DEFAULT = 20;
const SEARCH_MAX = 50;
const BODY_MAX_CHARS = 50_000;
const IDLE_CLOSE_MS = 5 * 60_000;
const SEND_MEMORY_MS = 10 * 60_000;
/** How long a send the app stopped in the middle of stays refused. Longer than
 *  the repeat window: whether it went out is unknown, and such sends are rare. */
const PENDING_MEMORY_MS = 24 * 60 * 60_000;
/** The most mail one send may forward or attach from, in all. */
const REFERENCE_MAX_BYTES = 25 * 1024 * 1024;
const REFERENCE_TOO_LARGE = 'That email is too large to forward or attach from (over 25 MB in all). Send a new email instead, or ask the owner to forward it.';

export type MailErrorKind = 'auth' | 'provider-blocked' | 'network' | 'not-found' | 'bad-request' | 'refused' | 'unsupported' | 'timeout' | 'unknown';

export class MailError extends Error {
  /** `uncertain`: the server may have taken the email though the send failed
   *  (issue 101), so it must not be sent again until Sent shows otherwise. */
  constructor(readonly kind: MailErrorKind, message: string, readonly uncertain = false) { super(message); }
}

/** A connection that dropped or timed out after it was made: the server may
 *  have taken the email. A server that was never reached is not uncertain
 *  (neverReachedServer). ECONNECTION is the SMTP library's "Connection closed
 *  unexpectedly", which can come after the server took the email. */
const MID_SEND_DROP = new Set(['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ESOCKET', 'ECONNECTION']);

/** A failure before the mail server took anything: the connection was never
 *  made (refused, no such host, timed out connecting) or the server never said
 *  hello. The SMTP library tags every socket error and timeout as the
 *  connection phase, so the original connect error and its own messages for
 *  these two timeouts are what tell them apart. */
export function neverReachedServer(e: unknown): boolean {
  const err = e as { syscall?: unknown; message?: unknown } | null;
  if (err?.syscall === 'connect' || err?.syscall === 'getaddrinfo') return true;
  return typeof err?.message === 'string' && /^(Connection timeout|Greeting never received)\b/.test(err.message);
}

/** The slice of ImapFlow this module uses (so tests can inject a fake). */
export interface ImapLike {
  usable?: boolean;
  connect(): Promise<void>;
  logout(): Promise<void>;
  close?(): void;
  list(): Promise<Array<{ path: string; specialUse?: string; flags?: Set<string>; delimiter?: string }>>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  search(query: Record<string, unknown>, opts?: { uid?: boolean }): Promise<number[] | false>;
  fetchOne(uid: string | number, query: Record<string, unknown>, opts?: { uid?: boolean }): Promise<any>;
  download(range: string | number, part: string, options?: { uid?: boolean; maxBytes?: number }): Promise<{ meta: Record<string, unknown>; content: NodeJS.ReadableStream }>;
  fetch(range: string | number[], query: Record<string, unknown>, opts?: { uid?: boolean }): AsyncIterable<any>;
  append(path: string, content: Buffer | string, flags?: string[]): Promise<unknown>;
  messageFlagsAdd?(range: string | number[], flags: string[], opts?: { uid?: boolean; useLabels?: boolean }): Promise<unknown>;
  messageMove?(range: string | number[], destination: string, opts?: { uid?: boolean }): Promise<unknown>;
  mailboxCreate?(path: string): Promise<unknown>;
  on?(event: string, fn: (...a: any[]) => void): unknown;
}

/**
 * Where a message is (owner, 2026-10-03: inbox zero archived mail the team
 * could then never find, and nobody could see what the owner sent). IMAP
 * numbers each folder separately, so an id carries its folder: a plain number
 * is the inbox (every id from before this), "sent:12", "archive:12", and
 * "label:Finance:12". A bare number is never read in another folder, where it
 * would open a different message.
 */
export type FolderKey = 'inbox' | 'sent' | 'archive' | { label: string };

/** The folder a search names: "inbox" (default), "sent", "archive", or a label. */
export function folderKey(folder: string | undefined): FolderKey {
  const f = (folder ?? '').trim();
  const low = f.toLowerCase();
  if (!f || low === 'inbox') return 'inbox';
  if (low === 'sent') return 'sent';
  if (low === 'archive' || low === 'archived' || low === 'all' || low === 'all mail') return 'archive';
  return { label: f.replace(/[\r\n]/g, ' ').slice(0, 60) };
}

const folderName = (key: FolderKey): string => (typeof key === 'string' ? key : key.label);

export function messageIdFor(key: FolderKey, uid: number | string): string {
  if (key === 'inbox') return String(uid);
  return typeof key === 'string' ? `${key}:${uid}` : `label:${key.label}:${uid}`;
}

type MailBodyPart = {
  part?: string;
  type?: string;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  parameters?: Record<string, string>;
  size?: number;
  childNodes?: MailBodyPart[];
};

function findMailTextParts(structure: MailBodyPart | undefined) {
  const textParts: Array<{ part: string; type: 'text/plain' | 'text/html'; size?: number  }> = [];
  const attachments: Array<{ name: string; size: number }> = [];

  function walk(node: MailBodyPart) {
    const filename =
      node.dispositionParameters?.filename ??
      node.parameters?.name;

    if (node.disposition === 'attachment' || filename) {
      attachments.push({
        name: filename ?? 'attachment',
        size: node.size ?? 0
      });
      return;
    }

    if (node.childNodes?.length) {
      for (const child of node.childNodes) walk(child);
      return;
    }

    if (node.type === 'text/plain' || node.type === 'text/html') {
      textParts.push({ part: node.part || '1', type: node.type, size: node.size });
    }
  }

  if (structure) walk(structure);

  return {
    textParts: textParts.sort((a, b) =>
      a.type === b.type ? 0 : a.type === 'text/plain' ? -1 : 1
    ),
    attachments
  };
}

/** The folder and IMAP uid an id names. Anything else is refused, never guessed. */
export function parseMessageId(id: string): { key: FolderKey; uid: string } {
  const s = String(id).trim();
  if (/^\d+$/.test(s)) return { key: 'inbox', uid: s };
  const m = /^(sent|archive):(\d+)$/.exec(s) ?? /^label:(.+):(\d+)$/.exec(s);
  if (!m) throw new MailError('bad-request', `"${s}" is not a message id from search.`);
  return { key: m[1] === 'sent' || m[1] === 'archive' ? m[1] : { label: m[1] }, uid: m[2] };
}

const uidOf = (id: string): number => Number(id.slice(id.lastIndexOf(':') + 1));

/** The most messages one archive, mark_read or mark_junk call moves. */
const ORGANIZE_MAX = 50;

/** Folder names an archive label may never be: a label is a place to file
 *  mail, and these would trash, junk or misfile it (security review,
 *  2026-10-03: the label "\\Trash" really trashed mail on Gmail). */
const RESERVED_LABELS = new Set([
  'inbox', 'trash', 'bin', 'deleted', 'deleted items', 'deleted messages', 'junk', 'junk e-mail', 'junk email',
  'spam', 'bulk mail', 'sent', 'sent items', 'sent mail', 'sent messages', 'drafts', 'draft', 'all mail',
  'important', 'starred', 'flagged', 'outbox'
]);
/** Special-use folders a label must not name either, whatever they are called. */
/** Gmail, told by its "[Gmail]/" (or "[Google Mail]/") system folders, which
 *  keep that name in every language. Another server's \All is not Gmail's. */
function isGmail(list: Array<{ path: string }>): boolean {
  return list.some((f) => /^\[(?:gmail|google mail)\]\//i.test(f.path));
}

const RESERVED_USES = new Set(['\\Trash', '\\Junk', '\\Sent', '\\Drafts', '\\All', '\\Flagged', '\\Important']);
/** Folders a label search never opens: spam, trash and drafts. */
const OFF_LIMITS_USES = new Set(['\\Trash', '\\Junk', '\\Drafts']);
const OFF_LIMITS_NAMES = /^(?:\[(?:gmail|google mail)\]\/(?:spam|trash|bin|drafts)|(?:inbox[./])?(?:junk|spam|junk e-?mail|bulk|bulk mail|trash|deleted items|deleted messages|bin|drafts?))$/i;

/** Why an archive label is refused, or null when it is a plain label. */
export function labelProblem(label: string): string | null {
  if (/^\\/.test(label)) return 'A label cannot start with a backslash.';
  if (/[\u0000-\u001f\u007f(){}"%*\]]/.test(label)) return 'A label can use letters, numbers, spaces and simple punctuation only.';
  const name = label.trim().toLowerCase().replace(/^\[gmail\]\//, '').replace(/^inbox[./]/, '');
  // Its first level too: a folder inside the trash is emptied with it.
  const top = name.split(/[./]/)[0].trim();
  if (RESERVED_LABELS.has(name) || RESERVED_LABELS.has(top)) return `"${label}" is a system folder, not a label: archive files mail, it never trashes or junks it.`;
  return null;
}

export interface SmtpLike {
  sendMail(msg: Record<string, unknown>): Promise<{ messageId?: string; accepted?: unknown[] }>;
  verify?(): Promise<unknown>;
  close?(): void;
}

export interface MailDeps {
  getConfig(): MailAccessConfig;
  getPassword(mailboxId: string): string | undefined;
  /** MB-7: record connected / needs-attention on the mailbox. */
  markStatus(mailboxId: string, status: 'connected' | 'needs-attention', reason?: string): void;
  createImap?(server: MailServer, user: string, pass: string): ImapLike;
  createSmtp?(server: MailServer, user: string, pass: string): SmtpLike;
  /** MX lookup for the Microsoft 365 check (issue 39). Injected so tests run offline. */
  resolveMx?(domain: string): Promise<Array<{ exchange: string }>>;
  log?(line: string): void;
  /** Where the sends of the last SEND_MEMORY_MS are kept on disk, so a repeat
   *  after a restart still gets the first result back instead of a second email.
   *  A send is written here before the server sees it, so one the app stopped
   *  in the middle of is not sent a second time either (for PENDING_MEMORY_MS).
   *  Without it the record lives in memory only. */
  journalPath?: string;
}

function defaultImap(server: MailServer, user: string, pass: string): ImapLike {
  return new ImapFlow({
    host: server.host, port: server.port, secure: server.secure,
    auth: { user, pass }, logger: false, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000
  }) as unknown as ImapLike;
}

function defaultSmtp(server: MailServer, user: string, pass: string): SmtpLike {
  return nodemailer.createTransport({
    host: server.host, port: server.port, secure: server.secure,
    auth: { user, pass }, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 45_000
  }) as unknown as SmtpLike;
}

/** Plain-language classification of an IMAP or SMTP failure. */
export function classifyMailError(e: unknown): MailError {
  if (e instanceof MailError) return e;
  const err = e as { code?: string; authenticationFailed?: boolean; responseText?: string; response?: string; message?: string };
  const text = `${err?.responseText ?? ''} ${err?.response ?? ''} ${err?.message ?? ''}`;
  if (/application-specific password required|web login required|basic auth(entication)? (is )?(disabled|blocked)|app passwords? (are |is )?(not allowed|disabled)|please log ?in via your web browser/i.test(text)) {
    return new MailError('provider-blocked', 'This provider no longer accepts the app password for this mailbox.');
  }
  if (err?.authenticationFailed || err?.code === 'EAUTH' || /AUTHENTICATIONFAILED|invalid credentials|authentication failed|535/i.test(text)) {
    return new MailError('auth', "The mailbox didn't accept that password. Check it's an app password, not your normal one.");
  }
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ESOCKET', 'ECONNECTION', 'EPIPE', 'NoConnection'].includes(err?.code ?? '')) {
    return new MailError('network', "Couldn't reach the mail server. Check the server name and your connection.");
  }
  if (/timed out/i.test(text)) return new MailError('timeout', 'The mail server took too long to answer.');
  return new MailError('unknown', `The mail server returned an error: ${String(err?.message ?? e).slice(0, 200)}`);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new MailError('timeout', `${what} took longer than ${Math.round(ms / 1000)} seconds.`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function addrText(a: any): string {
  if (!a) return '';
  if (Array.isArray(a)) return a.map(addrText).filter(Boolean).join(', ');
  if (typeof a === 'string') return a;
  if (a.text) return a.text;
  if (a.address) return a.name ? `${a.name} <${a.address}>` : a.address;
  if (Array.isArray(a.value)) return a.value.map(addrText).join(', ');
  return '';
}

export interface MailRef { mailbox: string; id: string }

export interface ComposeInput {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  /** Reply to a message in the same mailbox (threading headers). */
  replyTo?: MailRef;
  /** Forward a message (MB-8: only by reference, only from the sending mailbox). */
  forward?: MailRef;
  /** Attach the attachments of other messages (same rule). */
  attachFrom?: MailRef[];
  /** Threading headers from the member's own send record (a reply under a
   *  Send only grant): set instead of replyTo, so nothing is fetched (E1b). */
  thread?: ThreadHeaders;
}

interface OpenBox { client: ImapLike; timer?: ReturnType<typeof setTimeout> }

export class MailService {
  private readonly boxes = new Map<string, OpenBox>();
  /** Last status written per mailbox, so a working call does not rewrite
   *  config on every tool call. */
  private readonly lastStatus = new Map<string, 'connected' | 'needs-attention'>();
  private readonly sent = new Map<string, { at: number; result: { messageId: string } }>();
  /** Sends handed to the server whose answer has not come back, saved before
   *  the server sees them. Outside a running send, one is left over from a run
   *  that stopped mid-send: it may have gone out, so it is not sent again. */
  private readonly pending = new Map<string, { at: number; messageId: string }>();
  /** Sends in progress by the same key, so an identical send that overlaps
   *  waits for the first and gets its result instead of sending again. */
  private readonly inFlight = new Map<string, Promise<{ sent: boolean; messageId: string }>>();
  private readonly createImap: NonNullable<MailDeps['createImap']>;
  private readonly createSmtp: NonNullable<MailDeps['createSmtp']>;
  private readonly resolveMx: NonNullable<MailDeps['resolveMx']>;

  constructor(private readonly deps: MailDeps) {
    this.createImap = deps.createImap ?? defaultImap;
    this.createSmtp = deps.createSmtp ?? defaultSmtp;
    this.resolveMx = deps.resolveMx ?? resolveMx;
    this.loadJournal();
  }

  /** Reload the recent sends a previous run recorded, dropping any too old to count. */
  private loadJournal(): void {
    if (!this.deps.journalPath) return;
    try {
      if (!existsSync(this.deps.journalPath)) return;
      const raw = JSON.parse(readFileSync(this.deps.journalPath, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const now = Date.now();
        for (const [k, v] of Object.entries(raw as Record<string, { at?: number; messageId?: string; pending?: boolean }>)) {
          if (v && typeof v.at === 'number' && typeof v.messageId === 'string') {
            if (v.pending === true) {
              if (now - v.at <= PENDING_MEMORY_MS) this.pending.set(k, { at: v.at, messageId: v.messageId });
            } else if (now - v.at <= SEND_MEMORY_MS) {
              this.sent.set(k, { at: v.at, result: { messageId: v.messageId } });
            }
          }
        }
      }
    } catch { /* best-effort */ }
  }

  /** False only when the journal could not be written. */
  private saveJournal(): boolean {
    if (!this.deps.journalPath) return true;
    try {
      const data: Record<string, { at: number; messageId: string; pending?: true }> = {};
      for (const [k, v] of this.sent) {
        data[k] = { at: v.at, messageId: v.result.messageId };
      }
      for (const [k, v] of this.pending) {
        data[k] = { at: v.at, messageId: v.messageId, pending: true };
      }
      writeFileAtomic(this.deps.journalPath, JSON.stringify(data, null, 2), 0o600);
      return true;
    } catch { return false; }
  }

  private recordSent(key: string, at: number, messageId: string): void {
    this.pending.delete(key);
    this.sent.set(key, { at, result: { messageId } });
    this.saveJournal();
  }

  private record(id: string): MailboxRecord {
    const rec = (this.deps.getConfig().mailboxes ?? []).find((m) => m.id === id);
    if (!rec) throw new MailError('not-found', `The mailbox "${id}" was removed in Settings.`);
    return rec;
  }

  private password(id: string): string {
    const pass = this.deps.getPassword(id);
    if (!pass) throw new MailError('auth', 'This mailbox has no saved password. Fix it in Settings.');
    return pass;
  }

  /** Mark the mailbox from the outcome of a real call (MB-7). Only auth and
   *  provider-blocked mark it; a network blip does not. */
  private note(id: string, err?: MailError): void {
    try {
      if (!err) {
        if (this.lastStatus.get(id) === 'connected') return;
        this.deps.markStatus(id, 'connected');
        this.lastStatus.set(id, 'connected');
      } else if (err.kind === 'auth' || err.kind === 'provider-blocked') {
        this.deps.markStatus(id, 'needs-attention', err.message);
        this.lastStatus.set(id, 'needs-attention');
      }
    } catch { /* status is best-effort */ }
  }

  private async imap(id: string): Promise<ImapLike> {
    const open = this.boxes.get(id);
    if (open && open.client.usable !== false) { this.touch(id, open); return open.client; }
    if (open) this.drop(id);
    const rec = this.record(id);
    const client = this.createImap(rec.imap, rec.address, this.password(id));
    client.on?.('error', () => this.drop(id));
    client.on?.('close', () => this.drop(id));
    try {
      await withTimeout(client.connect(), CALL_TIMEOUT_MS, 'Connecting to the mailbox');
    } catch (e) {
      // A failed login leaves a half-open socket: close it, or every failed
      // attempt leaks a connection.
      try { client.close?.(); } catch { /* already gone */ }
      throw e;
    }
    const box: OpenBox = { client };
    this.boxes.set(id, box);
    this.touch(id, box);
    return client;
  }

  private touch(id: string, box: OpenBox): void {
    if (box.timer) clearTimeout(box.timer);
    box.timer = setTimeout(() => this.drop(id), IDLE_CLOSE_MS);
    (box.timer as { unref?: () => void }).unref?.();
  }

  private drop(id: string): void {
    const box = this.boxes.get(id);
    if (!box) return;
    this.boxes.delete(id);
    if (box.timer) clearTimeout(box.timer);
    box.client.logout().catch(() => box.client.close?.());
  }

  /** Close every connection (app quit, reset, mailbox removed). */
  closeAll(): void { for (const id of [...this.boxes.keys()]) this.drop(id); }
  close(id: string): void { this.drop(id); }

  /** Run `fn` with the folder locked; one reconnect after a dropped socket
   *  (sleep and wake), then a classified error. */
  private async inFolder<T>(id: string, folder: (c: ImapLike) => Promise<string>, fn: (c: ImapLike, path: string) => Promise<T>, what: string): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const client = await this.imap(id);
        const path = await folder(client);
        const lock = await withTimeout(client.getMailboxLock(path), CALL_TIMEOUT_MS, what);
        try {
          const out = await withTimeout(fn(client, path), CALL_TIMEOUT_MS, what);
          this.note(id);
          return out;
        } finally { lock.release(); }
      } catch (e) {
        const err = classifyMailError(e);
        if (err.kind === 'network' && attempt === 0) { this.drop(id); continue; }
        if (err.kind === 'network' || err.kind === 'timeout') this.drop(id);
        this.note(id, err);
        throw err;
      }
    }
    throw new MailError('network', "Couldn't reach the mail server.");
  }

  private static async special(client: ImapLike, use: '\\Drafts' | '\\Sent', names: string[]): Promise<string> {
    const list = await client.list();
    const hit = list.find((f) => f.specialUse === use) ?? list.find((f) => names.some((n) => f.path.toLowerCase() === n.toLowerCase()));
    if (!hit) throw new MailError('not-found', use === '\\Drafts' ? 'This mailbox has no Drafts folder.' : 'This mailbox has no Sent folder.');
    return hit.path;
  }
  private static inbox = async (): Promise<string> => 'INBOX';
  /** The folder a search looks in (owner, 2026-10-03: inbox zero archived mail
   *  the team could then never find). `archive` is Gmail's All Mail, which
   *  holds every message but spam and trash; elsewhere it is the archive
   *  folder. A label is a Gmail label, or a folder of that name. */
  private static folderOf = (key: FolderKey) => async (c: ImapLike): Promise<string> => {
    if (key === 'inbox') return 'INBOX';
    if (key === 'sent') return MailService.sentBox(c);
    const list = await c.list();
    if (key === 'archive') {
      // Gmail's All Mail leaves out spam and trash; another server's \All may
      // not (RFC 6154), so elsewhere the archive is its \Archive folder.
      const gmail = isGmail(list);
      const hit = (gmail ? list.find((f) => f.specialUse === '\\All') : undefined) ?? list.find((f) => f.specialUse === '\\Archive') ?? list.find((f) => /^(inbox\.)?archive$/i.test(f.path));
      if (!hit) throw new MailError('not-found', 'This mailbox has no archive folder yet: nothing has been archived.');
      return hit.path;
    }
    const label = key.label.toLowerCase();
    const hit = list.find((f) => f.path.toLowerCase() === label) ?? list.find((f) => f.path.toLowerCase() === `inbox${f.delimiter ?? '.'}${label}`);
    if (!hit) throw new MailError('not-found', `This mailbox has no label or folder called "${key.label}".`);
    // Spam, trash and the owner's unsent drafts are not team mail (ship review
    // 2026-10-03): spam is where injected instructions live, and a draft is the
    // owner's own unsent words. Sent and the archive have their own names.
    // The folder or any folder it sits in ("Trash/Old", "INBOX.Junk.2025").
    const parts = hit.delimiter ? hit.path.split(hit.delimiter) : [hit.path];
    const offLimits = parts.some((_, i) => {
      const at = parts.slice(0, i + 1).join(hit.delimiter ?? '');
      const f = list.find((x) => x.path === at);
      return OFF_LIMITS_USES.has(f?.specialUse ?? '') || OFF_LIMITS_NAMES.test(at);
    });
    if (offLimits) {
      throw new MailError('bad-request', `"${key.label}" is spam, trash or drafts, which the team does not read.`);
    }
    return hit.path;
  };
  private static drafts = (c: ImapLike): Promise<string> => MailService.special(c, '\\Drafts', ['Drafts', '[Gmail]/Drafts', 'INBOX.Drafts', 'Draft']);
  private static sentBox = (c: ImapLike): Promise<string> => MailService.special(c, '\\Sent', ['Sent', '[Gmail]/Sent Mail', 'Sent Messages', 'INBOX.Sent', 'Sent Items']);

  async search(id: string, q: { text?: string; from?: string; subject?: string; since?: string; unread?: boolean; limit?: number; page?: number; folder?: string }) {
    const limit = Math.min(Math.max(1, Math.floor(q.limit ?? SEARCH_DEFAULT)), SEARCH_MAX);
    const page = Math.max(0, Math.floor(q.page ?? 0));
    const key = folderKey(q.folder);
    return this.inFolder(id, MailService.folderOf(key), async (c) => {
      const query: Record<string, unknown> = {};
      if (q.text) query.text = q.text;
      if (q.from) query.from = q.from;
      if (q.subject) query.subject = q.subject;
      if (q.since) { const d = new Date(q.since); if (!Number.isNaN(d.getTime())) query.since = d; }
      if (q.unread) query.seen = false;
      if (!Object.keys(query).length) query.all = true;
      // Never the owner's unsent drafts: Gmail's All Mail (the archive) holds them too.
      query.draft = false;
      const uids = (await c.search(query, { uid: true })) || [];
      const newest = [...uids].sort((a, b) => b - a);
      const slice = newest.slice(page * limit, page * limit + limit);
      const messages: Array<{ id: string; from: string; subject: string; date: string; unread: boolean }> = [];
      if (slice.length) {
        for await (const m of c.fetch(slice, { uid: true, envelope: true, flags: true }, { uid: true })) {
          messages.push({
            id: messageIdFor(key, m.uid),
            from: addrText(m.envelope?.from),
            subject: m.envelope?.subject ?? '',
            date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : '',
            unread: !(m.flags instanceof Set ? m.flags.has('\\Seen') : false)
          });
        }
      }
      messages.sort((a, b) => uidOf(b.id) - uidOf(a.id));
      // An empty inbox is not "no such mail": inbox zero archives everything
      // with an outcome, and the owner's replies live in Sent. Say so in the
      // answer itself (owner, 2026-10-04: Pam searched only the inbox after the
      // folders shipped and concluded her tool could not see the rest).
      const hint = key === 'inbox' && !newest.length
        ? { hint: 'Nothing in the inbox. Archived mail is in folder "archive" and mail the owner or the team sent is in folder "sent": search there too.' }
        : {};
      return { folder: folderName(key), messages, total: newest.length, page, more: newest.length > (page + 1) * limit, ...hint };
    }, 'Searching the mailbox');
  }

  /**
   * Inbox zero (owner, 2026-10-03): take messages out of the inbox without
   * deleting any. `archive` marks them read and moves them to the archive, or,
   * with a label, to that label (a Gmail label, or a folder of that name on
   * other servers, made when missing). `mark_junk` marks them read and moves
   * them to the junk folder. `mark_read` leaves them where they are. Every
   * outcome can be undone in the mailbox.
   */
  async organize(id: string, action: 'archive' | 'mark_read' | 'mark_junk', uids: number[], label?: string) {
    if (!uids.length) throw new MailError('bad-request', `${action} needs the message ids from search.`);
    return this.inFolder(id, MailService.inbox, async (c) => {
      if (!c.messageFlagsAdd || !c.messageMove) throw new MailError('unsupported', 'This mailbox cannot move messages.');
      // Only the asked-for ids are searched, not the whole inbox.
      const present = new Set(((await c.search({ uid: uids.join(',') }, { uid: true })) || []).map(Number));
      const found = uids.filter((u) => present.has(u));
      const missing = uids.filter((u) => !present.has(u));
      if (!found.length) throw new MailError('not-found', 'None of those messages are in the inbox any more.');
      if (action === 'mark_read') {
        await c.messageFlagsAdd(found, ['\\Seen'], { uid: true });
        return { done: found.map(String), missing: missing.map(String) };
      }
      // Where they go is settled before anything changes, so a mailbox with no
      // junk folder leaves the messages exactly as they were.
      const folders = await c.list();
      // The same test as a search's archive, so archived mail is where the
      // team later looks for it (Codex adversarial review, 2026-10-04).
      const gmail = isGmail(folders) && folders.some((f) => f.specialUse === '\\All');
      let destination: string;
      if (action === 'mark_junk') {
        const junk = folders.find((f) => f.specialUse === '\\Junk') ?? folders.find((f) => /^(junk|spam|junk e-?mail|\[gmail\]\/spam|inbox\.junk)$/i.test(f.path));
        if (!junk) throw new MailError('not-found', 'This mailbox has no junk folder.');
        destination = junk.path;
      } else if (label && folders.some((f) => {
        if (!f.specialUse || !RESERVED_USES.has(f.specialUse)) return false;
        const sys = f.path.toLowerCase();
        const l = label.toLowerCase();
        // The folder itself, or one inside it, whatever its name in this language.
        return l === sys || [f.delimiter, '/', '.'].some((d) => !!d && l.startsWith(sys + d));
      })) {
        throw new MailError('bad-request', `"${label}" is a system folder, not a label.`);
      } else if (gmail) {
        // Gmail: the label is added in place, then the message leaves the inbox
        // for All Mail, where it keeps every label.
        if (label) await c.messageFlagsAdd(found, [label], { uid: true, useLabels: true });
        destination = folders.find((f) => f.specialUse === '\\All')!.path;
      } else {
        const archive = folders.find((f) => f.specialUse === '\\Archive') ?? folders.find((f) => /^(inbox\.)?archive$/i.test(f.path));
        destination = label ?? archive?.path ?? 'Archive';
        if (!folders.some((f) => f.path === destination)) await c.mailboxCreate?.(destination);
      }
      await c.messageFlagsAdd(found, ['\\Seen'], { uid: true });
      await c.messageMove(found, destination, { uid: true });
      return { done: found.map(String), missing: missing.map(String), ...(label ? { label } : {}) };
    }, action === 'mark_read' ? 'Marking mail read' : action === 'mark_junk' ? 'Moving mail to junk' : 'Archiving mail');
  }

  /** The threading headers of the message a reply answers, without its body. */
  private async replyHeaders(id: string, ref: MailRef): Promise<{ messageId?: string; references?: string | string[] }> {
    const { key, uid } = parseMessageId(ref.id);
    return this.inFolder(id, MailService.folderOf(key), async (c) => {
      const m = await c.fetchOne(uid, { uid: true, headers: ['message-id', 'references'] }, { uid: true }).catch(() => null) as { headers?: Buffer | string } | false | null;
      if (m && m.headers) {
        const parsed = await simpleParser(Buffer.isBuffer(m.headers) ? m.headers : Buffer.from(String(m.headers)));
        return { messageId: parsed.messageId, references: parsed.references };
      }
      // A server that gives no headers part: read the message itself.
      const parsed = await simpleParser(await this.source(c, uid, key));
      return { messageId: parsed.messageId, references: parsed.references };
    }, 'Fetching the referenced message');
  }

  private async source(c: ImapLike, uid: string, key: FolderKey = 'inbox', maxBytes?: number): Promise<Buffer> {
    if (maxBytes) {
      // Its size first, so a huge message is refused before it is downloaded.
      const head = await c.fetchOne(uid, { uid: true, size: true }, { uid: true }).catch(() => null) as { size?: number } | false | null;
      if (head && typeof head.size === 'number' && head.size > maxBytes) throw new MailError('bad-request', REFERENCE_TOO_LARGE);
    }
    const m = await c.fetchOne(uid, { uid: true, source: true, flags: true }, { uid: true });
    if (!m || !m.source) {
      // A plain number is an inbox id, and mail leaves the inbox when it is
      // archived. Say where to look, so an agent searches the archive instead of
      // deciding archived mail is out of reach (owner, 2026-10-04: Pam read an
      // old inbox id after inbox zero and asked the owner to restart her mail).
      throw new MailError('not-found', key === 'inbox'
        ? `No message with id ${uid} in the inbox. If it was archived or sent, search with folder "archive" or "sent" and read the id that search gives.`
        : `No message with id ${uid} in that folder. Search again for its current id.`);
    }
    // A draft is the owner's own unsent words, whichever folder holds it.
    const flags: Set<string> = m.flags instanceof Set ? m.flags : new Set(Array.isArray(m.flags) ? m.flags : []);
    if (flags.has('\\Draft')) throw new MailError('bad-request', 'That message is an unsent draft, which the team does not read.');
    return Buffer.isBuffer(m.source) ? m.source : Buffer.from(m.source);
  }

  async read(id: string, messageId: string) {
    const { key, uid } = parseMessageId(messageId);
    return this.inFolder(id, MailService.folderOf(key), async (c) => {
      const info = await c.fetchOne(uid, { uid: true, envelope: true, bodyStructure: true, flags: true }, { uid: true });
      if(!info){
        throw new MailError('not-found', `No message with id ${uid} in that folder.`);
      }
      const flags: Set<string> = info.flags instanceof Set
       ? info.flags
       : new Set(Array.isArray(info.flags) ? info.flags : []);

      if (flags.has('\\Draft')) {
       throw new MailError('bad-request', 'That message is an unsent draft, which the team does not read.');
      }
      const structure = info.bodyStructure;
      const { textParts, attachments } = findMailTextParts(structure);
      const selectedPart = textParts[0];

      const downloaded = selectedPart
       ? await c.download(uid, selectedPart.part, { uid: true, maxBytes: 256_000 })
       : null;
      const chunks: Buffer[] = [];

       if (downloaded?.content) {
         for await (const chunk of downloaded.content) {
         chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        }

      const downloadedText = Buffer.concat(chunks).toString('utf8');
      
      const contentType = selectedPart?.type ?? 'text/plain';

      const parsed = await simpleParser(`Content-Type: ${contentType}; charset=utf-8\r\n\r\n${downloadedText}`);
      let text = parsed.text ?? (typeof parsed.html === 'string' ? parsed.html.replace(/<[^>]+>/g, ' ') : '') ?? '';
      const truncated = text.length > BODY_MAX_CHARS || (selectedPart?.size !== undefined && selectedPart.size > 256_000);
      if (truncated) text = `${text.slice(0, BODY_MAX_CHARS)}\n\n[message cut at ${BODY_MAX_CHARS} characters]`;
      return {
        id: messageId,
        from: (info.envelope?.from ?? []).map((a: { name?: string; address?: string }) => a.address ?? a.name ?? '').join(', '),
        to: (info.envelope?.to ?? []).map((a: { name?: string; address?: string }) => a.address ?? a.name ?? '').join(', '),
        cc: (info.envelope?.cc ?? []).map((a: { name?: string; address?: string }) => a.address ?? a.name ?? '').join(', '),
        subject: info.envelope?.subject ?? '',
        date: info.envelope?.date ? new Date(info.envelope.date).toISOString() : '',
        messageId: info.envelope?.messageId ?? '',
        text, truncated,
        attachments
      };
    }, 'Reading the message');
  }

  /** Build the MIME for a draft or send. References are fetched here, from the
   *  sending mailbox only (MB-8 is checked by the caller first). */
  private async compose(id: string, from: string, input: ComposeInput, messageId: string): Promise<Record<string, unknown>> {
    const msg: Record<string, unknown> = { from, to: input.to, cc: input.cc, subject: input.subject, text: input.body, messageId };
    if (input.thread) {
      msg.inReplyTo = input.thread.inReplyTo;
      msg.references = [...input.thread.references];
    }
    const refs = [input.replyTo, input.forward, ...(input.attachFrom ?? [])].filter(Boolean) as MailRef[];
    if (!refs.length) return msg;
    // Each reference is read from its own folder: a reply to sent or archived
    // mail names it by an id that says where it is.
    // Referenced mail is loaded whole, so its size is capped (one email and all
    // of them together): a huge one is refused in plain words, never freezing the app.
    let total = 0;
    const fetch = async (ref: MailRef) => {
      const { key, uid } = parseMessageId(ref.id);
      const buf = await this.inFolder(id, MailService.folderOf(key), (c) => this.source(c, uid, key, REFERENCE_MAX_BYTES), 'Fetching the referenced message');
      total += buf.length;
      if (buf.length > REFERENCE_MAX_BYTES || total > REFERENCE_MAX_BYTES) throw new MailError('bad-request', REFERENCE_TOO_LARGE);
      return buf;
    };
    const attachments: Array<Record<string, unknown>> = [];
    if (input.replyTo) {
      // A reply needs only the parent's Message-ID and References, so only its
      // headers are fetched: no size cap applies, however large the email.
      const parsed = await this.replyHeaders(id, input.replyTo);
      if (parsed.messageId) {
        msg.inReplyTo = parsed.messageId;
        const prior = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
        msg.references = [...prior, parsed.messageId];
      }
    }
    if (input.forward) {
      attachments.push({ filename: 'forwarded-message.eml', content: await fetch(input.forward), contentType: 'message/rfc822' });
    }
    for (const ref of input.attachFrom ?? []) {
      const parsed = await simpleParser(await fetch(ref));
      for (const a of parsed.attachments ?? []) attachments.push({ filename: a.filename ?? 'attachment', content: a.content, contentType: a.contentType });
    }
    if (attachments.length) msg.attachments = attachments;
    return msg;
  }

  private static build(msg: Record<string, unknown>): Promise<Buffer> {
    return new Promise((resolve, reject) => new MailComposer(msg as never).compile().build((e: Error | null, out: Buffer) => (e ? reject(e) : resolve(out))));
  }

  private static newMessageId(address: string): string {
    return `<${randomBytes(12).toString('hex')}@${address.split('@')[1] ?? 'dontbemichael.local'}>`;
  }

  async draft(id: string, input: ComposeInput) {
    const rec = this.record(id);
    const msg = await this.compose(id, rec.address, input, MailService.newMessageId(rec.address));
    const raw = await MailService.build(msg);
    await this.inFolder(id, MailService.drafts, async (c, path) => { await c.append(path, raw, ['\\Draft', '\\Seen']); }, 'Saving the draft');
    return { saved: true, messageId: String(msg.messageId) };
  }

  /** `beforeSmtp` runs once the message is built, just before it goes to the
   *  server: a reason refuses the send (the owner changed access meanwhile). */
  async send(agentId: string, id: string, input: ComposeInput, beforeSmtp?: () => string | null): Promise<{ sent: boolean; messageId: string; repeated?: boolean }> {
    // Send once: the same agent sending the same message to the same people from
    // the same mailbox within 10 minutes gets the first result back.
    const key = createHash('sha256').update(JSON.stringify([agentId, id, input.to, input.cc ?? '', input.subject, input.body, input.replyTo ?? null, input.forward ?? null, input.attachFrom ?? [], input.thread?.inReplyTo ?? null])).digest('hex');
    const now = Date.now();
    let pruned = false;
    for (const [k, v] of this.sent) {
      if (now - v.at > SEND_MEMORY_MS) {
        this.sent.delete(k);
        pruned = true;
      }
    }
    for (const [k, v] of this.pending) {
      if (now - v.at > PENDING_MEMORY_MS) {
        this.pending.delete(k);
        pruned = true;
      }
    }
    if (pruned) this.saveJournal();
    const prior = this.sent.get(key);
    if (prior) return { ...prior.result, sent: true, repeated: true };
    const running = this.inFlight.get(key);
    if (running) return { ...(await running), repeated: true };
    // Not running, yet saved as handed to the server: the app stopped in the
    // middle of this send, so it is looked for in Sent instead of sent again.
    const left = this.pending.get(key);
    const attempt = left ? this.settleInterrupted(key, id, left) : this.sendOnce(key, now, id, input, beforeSmtp);
    this.inFlight.set(key, attempt);
    try { return await attempt; } finally { this.inFlight.delete(key); }
  }

  /** A send the app stopped in the middle of: if its Message-ID is in Sent, the
   *  server took it and the first result comes back. That is not marked
   *  repeated: the stopped run never got to record the send (grant, standing
   *  approval, office log), so this caller records it once. If it is not in
   *  Sent, it may still have gone out (only Gmail files sent mail itself; for
   *  the rest the app adds the copy after the server answers), so it is refused. */
  private async settleInterrupted(key: string, id: string, left: { at: number; messageId: string }): Promise<{ sent: boolean; messageId: string }> {
    const mayHaveGone = 'This email may already have gone out: sending it was interrupted, and it is not in Sent yet. Do not send it again; tell Michael, so the owner can check with the recipient.';
    let found: boolean;
    try { found = await this.inSent(id, left.messageId); } catch (e) {
      const err = classifyMailError(e);
      // Only a passing problem is worth another try; any other leaves it unknown.
      if (err.kind === 'network' || err.kind === 'timeout') {
        throw new MailError(err.kind, `Not sent now. Sending this email was interrupted before, and Sent could not be checked for it: ${err.message} Try again in a moment.`);
      }
      throw new MailError('refused', mayHaveGone);
    }
    if (!found) throw new MailError('refused', mayHaveGone);
    // The repeat window starts now: the stop may have been long before.
    this.recordSent(key, Date.now(), left.messageId);
    return { sent: true, messageId: left.messageId };
  }

  private async sendOnce(key: string, now: number, id: string, input: ComposeInput, beforeSmtp?: () => string | null): Promise<{ sent: boolean; messageId: string }> {
    const rec = this.record(id);
    const messageId = MailService.newMessageId(rec.address);
    const msg = await this.compose(id, rec.address, input, messageId);
    const stop = beforeSmtp?.();
    if (stop) throw new MailError('refused', `Not sent. ${stop}`);
    const smtp = this.createSmtp(rec.smtp, rec.address, this.password(id));
    try {
      // Saved before the server sees it, so a stop before its answer never
      // leads to a second copy. If that can't be saved, nothing goes out.
      this.pending.set(key, { at: now, messageId });
      if (!this.saveJournal()) throw new MailError('unknown', 'The app could not record this send before sending it. Try again in a moment.');
      await withTimeout(smtp.sendMail(msg), SEND_TIMEOUT_MS, 'Sending');
    } catch (e) {
      const err = classifyMailError(e);
      if (err.kind === 'timeout' || err.kind === 'network') {
        // The server may have accepted it before the line dropped: look in Sent.
        const found = await this.inSent(id, messageId).catch(() => false);
        if (found) { this.recordSent(key, now, messageId); return { sent: true, messageId }; }
        // Not in Sent yet, but a drop mid-send may still have delivered it
        // (issue 101): it stays recorded as pending, so a repeat is checked in
        // Sent instead of sent, and an approved card stays sending.
        const code = (e as { code?: unknown } | null)?.code;
        if ((err.kind === 'timeout' || (typeof code === 'string' && MID_SEND_DROP.has(code))) && !neverReachedServer(e)) {
          this.note(id, err);
          throw new MailError(err.kind, 'This email may already have gone out: the connection dropped before the mail server answered, and it is not in Sent yet. Do not send it again; tell Michael, so the owner can check Sent.', true);
        }
      }
      // Reported as not sent, so a retry may send it.
      this.pending.delete(key);
      this.saveJournal();
      this.note(id, err);
      throw new MailError(err.kind, `Not sent. ${err.message}`);
    } finally { smtp.close?.(); }
    this.note(id);
    this.recordSent(key, now, messageId);
    // Gmail files sent mail itself; other services need the copy appended.
    if (rec.provider !== 'gmail' && rec.provider !== 'google-workspace') {
      const raw = await MailService.build(msg).catch(() => null);
      if (raw) await this.inFolder(id, MailService.sentBox, async (c, path) => { await c.append(path, raw, ['\\Seen']); }, 'Saving to Sent').catch(() => undefined);
    }
    return { sent: true, messageId };
  }

  private async inSent(id: string, messageId: string): Promise<boolean> {
    return this.inFolder(id, MailService.sentBox, async (c) => {
      const hits = await c.search({ header: { 'message-id': messageId } }, { uid: true });
      return Array.isArray(hits) && hits.length > 0;
    }, 'Checking Sent');
  }

  /** True when the address domain MX records point at Microsoft 365 (issue 39).
   *  Fail open: any lookup problem returns false so a working mailbox is never
   *  blocked by DNS. Businesses behind a mail filter keep their old behaviour. */
  private async domainUsesMicrosoft365(address: string): Promise<boolean> {
    const domain = address.split('@')[1]?.trim().toLowerCase();
    if (!domain) return false;
    try {
      const records = await withTimeout(this.resolveMx(domain), MX_LOOKUP_TIMEOUT_MS, 'Looking up the mail server');
      return mxPointsToMicrosoft((records ?? []).map((r) => r.exchange));
    } catch { return false; }
  }

  /** Settings "Test and save": log in to IMAP and SMTP with the given password
   *  before anything is stored. */
  async test(rec: Pick<MailboxRecord, 'address' | 'imap' | 'smtp'>, password: string): Promise<{ ok: true } | { ok: false; kind: MailErrorKind; reason: string }> {
    if (isMicrosoftAddress(rec.address)) {
      return { ok: false, kind: 'unsupported', reason: 'Outlook and Microsoft 365 mailboxes stopped accepting app passwords, so they cannot be connected yet.' };
    }
    // Issue 39: most small businesses on Microsoft 365 use their own domain,
    // so the address check never fires. Look at the domain MX records. Any
    // lookup failure falls through to the normal IMAP test, so a working
    // mailbox is never blocked by DNS.
    if (await this.domainUsesMicrosoft365(rec.address)) {
      return { ok: false, kind: 'unsupported', reason: 'Outlook and Microsoft 365 mailboxes stopped accepting app passwords, so they cannot be connected yet.' };
    }
    const client = this.createImap(rec.imap, rec.address, password);
    try {
      await withTimeout(client.connect(), CALL_TIMEOUT_MS, 'Connecting to the mailbox');
      await client.logout().catch(() => undefined);
    } catch (e) {
      const err = classifyMailError(e);
      client.close?.();
      return { ok: false, kind: err.kind, reason: err.message };
    }
    const smtp = this.createSmtp(rec.smtp, rec.address, password);
    try {
      if (smtp.verify) await withTimeout(smtp.verify(), CALL_TIMEOUT_MS, 'Checking outgoing mail');
    } catch (e) {
      const err = classifyMailError(e);
      return { ok: false, kind: err.kind, reason: `Incoming mail works, but sending does not. ${err.message}` };
    } finally { smtp.close?.(); }
    return { ok: true };
  }
}

// ── The broker's mail route ─────────────────────────────────────────────────

export interface MailRequestResult { status: number; body: Record<string, unknown> }

/** Send on approval (shared/mailProposals.ts): main keeps the proposals. */
export interface ProposalStore {
  /** Files a proposal for the owner and returns it with its id. */
  file(p: Omit<MailProposal, 'id' | 'createdAt' | 'state'>): MailProposal;
  get(id: string): MailProposal | undefined;
  markSent(id: string, messageId: string): void;
  /** Recorded before an approved email goes out (throws when it can't be). */
  markSending(id: string): void;
  unmarkSending(id: string): void;
  /** Standing approvals (owner, 2026-10-05): kinds an agent may send without asking. */
  standing(agentId?: string): StandingApproval[];
  getStanding(id: string): StandingApproval | undefined;
  recordStandingSend(id: string, email: { to: string; subject: string }): void;
  /** Withdraws a proposal the app can't send (shared-mailboxes.md, ER4, OV5). */
  cancel(match: { id: string } | { agentId: string; mailbox: string }, reason: string): number;
  /** Sends under a Send only grant (E1b): kept, looked up, listed. */
  recordSend(rec: SendRecord): void;
  sendRecord(agentId: string, mailbox: string, messageId: string): SendRecord | undefined;
  recentSends(agentId: string, mailbox: string, limit?: number): SendRecord[];
}

/** The separate check that an email fits a standing approval. Null when it
 *  could not run, which counts as not fitting. */
export type StandingFitCheck = (kind: string, email: StandingCheckEmail) => Promise<{ fits: true } | { fits: false; reason: string } | null>;

/** What each Sending choice lets the agent do, for list_mailboxes. The Sending
 *  changed notice says the same in shared/mailProposals.ts SENDING_CHANGE; change both. */
const SENDING_HOW: Record<SendingMode, string> = {
  send: 'send goes out at once. propose is refused: nothing goes on Ask me, so you decide, and you ask Michael when you are unsure about an email.',
  approval: 'propose puts the email on Ask me for the owner; when they approve it you get a message, then call send with its proposal id. For a kind listed in standing_approvals, call send with the full email and that standing id instead. When your memory notes show the owner approving one kind of email unchanged again and again, offer it with offer_standing on your next proposal.',
  draft: 'draft saves the email in the mailbox\'s Drafts for the owner to send; send and propose are refused.'
};

/** Approved proposals being sent right now, so two parallel sends of one card
 *  never both go out (the send once memory is set only after SMTP answers). */
const sendingProposals = new Set<string>();
/** Standing sends being checked or sent right now, by their content. */
const sendingStanding = new Set<string>();
/** Approved proposals that went out but could not be marked sent (a failed
 *  write): a later send repeats the result instead of sending again. */
const sentUnrecorded = new Map<string, string>();

/** What Send only means, for a grant's list_mailboxes entry. */
const SEND_ONLY_HOW = 'You send only from this mailbox: draft, propose and send follow its sending, below; search, read, archive, mark_read, mark_junk, forward and attach_from do not. Its owner reads the replies, and Michael passes on what is yours. To follow up in the same thread, reply_to with this mailbox and the message_id of one of your_recent_sends.';

function str(v: unknown, max = 5000): string | undefined {
  return typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined;
}

function ref(v: unknown): MailRef | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  return typeof o.mailbox === 'string' && (typeof o.id === 'string' || typeof o.id === 'number') ? { mailbox: o.mailbox, id: String(o.id) } : undefined;
}

type MailRequestDeps = Pick<MailDeps, 'getConfig' | 'log'> & { audit?: (event: Record<string, unknown>) => void; proposals?: ProposalStore; fitCheck?: StandingFitCheck; present?: (agentId: string) => boolean };

/**
 * One md-mail tool call, already authenticated by the broker token (so `agentId`
 * is trusted). Checks `mailAccess` for the op, MB-8 for references, then runs it.
 * Never throws: every outcome is a status and a JSON body the MCP server relays.
 *
 * Each call writes one line to `deps.log` (multi-mailbox.md §8): agent, mailbox,
 * operation, result and duration. Ids only, never a recipient, subject or body.
 */
export async function handleMailRequest(
  svc: MailService,
  deps: MailRequestDeps,
  agentId: string,
  op: string,
  body: Record<string, unknown>
): Promise<MailRequestResult> {
  const started = Date.now();
  const res = await runMailRequest(svc, deps, agentId, op, body);
  try {
    // The mailbox and op come from the agent: keep them to one plain token each.
    const mailbox = (str(body.mailbox, 100) ?? '-').replace(/[^\w.@-]/g, '?');
    const kind = typeof res.body.kind === 'string' ? ` ${res.body.kind}` : '';
    deps.log?.(`[mail] ${agentId} ${mailbox} ${Object.prototype.hasOwnProperty.call(MAIL_TOOL_OPS, op) ? op : 'unknown'} ${res.status}${kind} ${Date.now() - started}ms`);
  } catch { /* the call stands */ }
  return res;
}

async function runMailRequest(
  svc: MailService,
  deps: MailRequestDeps,
  agentId: string,
  op: string,
  body: Record<string, unknown>
): Promise<MailRequestResult> {
  const cfg = deps.getConfig();
  const mop = MAIL_TOOL_OPS[op];
  if (!mop) return { status: 404, body: { error: `Unknown mail tool "${op}".` } };
  const mailbox = str(body.mailbox, 100);
  const proposalId = str(body.proposal, 100);
  const standingId = op === 'send' && !proposalId ? str(body.standing, 100) : undefined;
  const attachRefs = Array.isArray(body.attach_from) ? (body.attach_from.map(ref).filter(Boolean) as MailRef[]).slice(0, 10) : undefined;
  // Send on approval lets a send through with an approved proposal or a
  // standing approval; the broker checks either one below.
  const access = mailAccess(cfg, agentId, mailbox, mop, proposalId ?? standingId, {
    refs: { forward: !!ref(body.forward), attachFrom: !!attachRefs?.length },
    present: deps.present
  });
  if (!access.ok) return { status: 403, body: { error: access.reason } };
  // A Send only grant on the named mailbox (shared-mailboxes.md).
  const grant = sendOnlyGrant(cfg, agentId);
  const underGrant = !!grant && !!mailbox && grant.mailbox === mailbox;
  // Can send puts nothing on Ask me (owner, 2026-10-09): a standing id from an
  // older memory note is ignored and the email goes out as any other send.
  const canSend = !!mailbox && sendingFor(cfg, agentId, mailbox) === 'send';

  if (op === 'list_mailboxes') {
    const recs = cfg.mailboxes ?? [];
    const email = cfg.agentCapabilities?.[agentId]?.email;
    const own = agentMailboxes(cfg, agentId);
    // Standing approvals apply only under Send on approval, so they are listed only then.
    const standingFor = (mid: string, mode: SendingMode) => (mode !== 'approval' ? [] : (deps.proposals?.standing(agentId) ?? []).filter((r) => r.mailbox === mid).map((r) => ({ standing: r.id, kind: r.kind })));
    const entries: Array<Record<string, unknown>> = own.map((mid) => {
      const r = recs.find((m) => m.id === mid);
      return { mailbox: mid, address: r?.address, status: r?.status };
    });
    if (grant) {
      const r = recs.find((m) => m.id === grant.mailbox);
      entries.push({
        mailbox: grant.mailbox, address: r?.address, status: r?.status,
        access: 'send only',
        ...(grantPaused(cfg, grant.mailbox, deps.present) ? { paused: `Nobody reads ${r?.address ?? grant.mailbox} right now, so nothing goes out from it; tell Michael.` } : {}),
        sending: sendingWords(grant.sending),
        how: `${SEND_ONLY_HOW} ${SENDING_HOW[grant.sending]}`,
        standing_approvals: standingFor(grant.mailbox, grant.sending),
        // Its own sends from here, for reply_to (its own words, nothing from the mailbox).
        your_recent_sends: (deps.proposals?.recentSends(agentId, grant.mailbox, 20) ?? []).map((x) => ({ message_id: x.messageId, to: x.to, subject: x.subject, sent_at: new Date(x.sentAt).toISOString() }))
      });
    }
    return {
      status: 200,
      body: {
        mailboxes: entries,
        // The member's own mailbox; a grant carries its own sending and how.
        ...(own.length ? {
          sending: sendingWords(sendingMode(email)),
          how: SENDING_HOW[sendingMode(email)],
          // Kinds the owner let this agent send without asking (send with standing).
          standing_approvals: standingFor(own[0], sendingMode(email))
        } : {}),
        // Where this access comes from, so a limit is never blamed on a setting
        // the owner does not have (owner, 2026-10-03).
        source: 'Settings, Connections, Mailboxes (the app\'s own mail connection, not a Claude connector)',
        // Can send or Draft only is the owner's choice per member, not a limit
        // of the connection (owner, 2026-10-05).
        sending_set_in: 'your Access tab, Email, Sending (the owner chooses Can send, Send on approval or Draft only for you; the mailbox connection itself can send)',
        ...(own.length ? { folders: 'search looks in the inbox, or in "sent", "archive" (Gmail: All Mail) or a label' } : {})
      }
    };
  }

  // MB-8: forwards and attachments only by reference, and only from the mailbox
  // doing the sending. Pasted text is not traceable and is not checked. A
  // proposal is held to it too, or an approved card could send the wrong
  // email from the sending mailbox (eng review ER4, D1).
  const input: ComposeInput = {
    to: str(body.to, 2000) ?? '', cc: str(body.cc, 2000), subject: str(body.subject, 500) ?? '', body: str(body.body, 200_000) ?? '',
    replyTo: ref(body.reply_to), forward: ref(body.forward), attachFrom: attachRefs
  };
  const refs = [input.replyTo, input.forward, ...(input.attachFrom ?? [])].filter(Boolean) as MailRef[];
  const foreign = refs.find((r) => r.mailbox !== mailbox);
  if (foreign && (op === 'draft' || op === 'send' || op === 'propose')) {
    return { status: 403, body: { error: `You can't forward, attach or reply to mail from "${foreign.mailbox}" while writing from "${mailbox}".` } };
  }
  // Under a grant a reply names one of the member's own sends; its thread
  // headers come from that record, and nothing is read from the mailbox. Any
  // other id gets the same refusal, before any lookup (E1b).
  if (underGrant && input.replyTo) {
    const rec = deps.proposals?.sendRecord(agentId, mailbox!, input.replyTo.id);
    if (!rec) return { status: 403, body: { error: OWN_SENDS_ONLY } };
    input.thread = threadFrom(rec);
    input.replyTo = undefined;
  }
  // Keeps a send under a grant for later replies; the send stands if this fails.
  const recordGrantSend = (out: { messageId?: unknown }, email: ComposeInput): void => {
    if (!underGrant || !out?.messageId) return;
    try {
      deps.proposals?.recordSend({ agentId, mailbox: mailbox!, messageId: String(out.messageId), references: email.thread ? [...email.thread.references] : [], to: email.to.slice(0, 2000), subject: email.subject.slice(0, 500), sentAt: Date.now() });
    } catch (e) { console.error('[mail] send record not kept:', agentId, mailbox, String(out.messageId), e); }
  };
  const grantFlag = underGrant ? { grant: true } : {};

  try {
    // Send on approval: the approved version the app kept goes out, never text
    // from the call, so nothing changes between the owner's yes and the send.
    if (op === 'send' && proposalId) {
      if (!deps.proposals) return { status: 503, body: { error: 'Approvals are not available right now. Tell Michael.' } };
      const p = deps.proposals.get(proposalId);
      // Sent in this session but not marked sent: the same result again.
      const unrecorded = p && p.agentId === agentId ? sentUnrecorded.get(p.id) : undefined;
      if (unrecorded !== undefined) return { status: 200, body: { sent: true, repeated: true, messageId: unrecorded } };
      if (p && p.agentId === agentId && sendingProposals.has(p.id)) return { status: 409, body: { error: 'This email is being sent right now. Do not send it again.' } };
      const problem = proposalSendProblem(p, agentId, mailbox!);
      if (problem) return { status: 409, body: { error: problem } };
      if (p!.state === 'sent') return { status: 200, body: { sent: true, repeated: true, messageId: p!.messageId } };
      // The references stored on the card meet the same rules as a call's
      // (OV5, ER4): from the sending mailbox only, and none under a grant.
      const stored = [p!.replyTo, p!.forward, ...(p!.attachFrom ?? [])].filter(Boolean) as MailRef[];
      const storedForeign = stored.find((r) => r.mailbox !== mailbox);
      const refused = storedForeign
        ? `You can't forward, attach or reply to mail from "${storedForeign.mailbox}" while writing from "${mailbox}".`
        : underGrant && stored.length ? 'You send only from this mailbox, so this email can\'t forward, attach or reply to mail in it.' : null;
      if (refused) {
        deps.proposals.cancel({ id: p!.id }, refused);
        return { status: 403, body: { error: `${refused} The email was withdrawn; write it again without that.` } };
      }
      const approved: ComposeInput = { to: p!.to, cc: p!.cc, subject: p!.approved?.subject ?? p!.subject, body: p!.approved?.body ?? p!.body, replyTo: p!.replyTo, forward: p!.forward, attachFrom: p!.attachFrom, thread: p!.thread };
      // Recorded as sending first: if that can't be saved nothing goes out, and
      // a restart after the send never sends it again.
      try { deps.proposals.markSending(p!.id); } catch {
        return { status: 503, body: { error: 'The app could not record this send, so nothing was sent. Try again in a moment.' } };
      }
      sendingProposals.add(p!.id);
      let out: Awaited<ReturnType<MailService['send']>>;
      // Checked again once the message is built, just before the server: a
      // withdraw or an access change while it was being prepared stops it.
      const stillSendable = (): string | null => {
        if (deps.proposals!.get(p!.id)?.state !== 'sending') return 'The owner withdrew this email while it was being prepared.';
        const a = mailAccess(deps.getConfig(), agentId, mailbox, 'send', p!.id, { present: deps.present });
        return a.ok ? null : a.reason;
      };
      try { out = await svc.send(agentId, mailbox!, approved, stillSendable); } catch (e) {
        // A send that may have gone out keeps the card sending, so it is never
        // sent a second time (issue 101); any other failure returns it to approved.
        if (!(e instanceof MailError && e.uncertain)) {
          try { deps.proposals.unmarkSending(p!.id); } catch { /* stays sending: never resent */ }
        }
        throw e;
      } finally { sendingProposals.delete(p!.id); }
      // The email is out: bookkeeping that fails is logged, never reported as a failed send.
      try { deps.proposals.markSent(p!.id, String(out.messageId ?? '')); } catch (e) {
        sentUnrecorded.set(p!.id, String(out.messageId ?? ''));
        console.error('[mail] mark sent failed:', p!.id, e);
      }
      recordGrantSend(out, approved);
      try { deps.audit?.({ kind: 'mail-sent-approved', agentId, mailbox, proposal: p!.id, ...grantFlag }); } catch { /* the send stands */ }
      return { status: 200, body: out };
    }
    // A standing approval: fixed facts first, then the separate check. An email
    // that does not plainly fit goes to the owner on Ask me instead, so a
    // generous reading never sends it.
    if (op === 'send' && standingId && !canSend) {
      if (!deps.proposals) return { status: 503, body: { error: 'Approvals are not available right now. Tell Michael.' } };
      const rule = deps.proposals.getStanding(standingId);
      const problem = standingProblem(rule, agentId, mailbox!, input);
      if (problem) return { status: 409, body: { error: problem } };
      if (!input.to || !input.subject || !input.body.trim()) return { status: 400, body: { error: 'send needs "to", "subject" and "body".' } };
      // The same email sent again while the first is still being checked or sent
      // waits for nothing and never goes out twice.
      const sendKey = JSON.stringify([agentId, mailbox, input.to, input.cc ?? '', input.subject, input.body, input.replyTo ?? null, input.thread?.inReplyTo ?? null]);
      if (sendingStanding.has(sendKey)) return { status: 409, body: { error: 'This email is being sent right now. Do not send it again.' } };
      sendingStanding.add(sendKey);
      try {
        // A reply is checked with the message it answers (ship D8). One under a
        // grant answers mail its sender can't read, so the owner decides.
        let answers: StandingCheckEmail['answers'];
        let unreadable = !!input.thread;
        if (input.replyTo) {
          try {
            const parent = await svc.read(mailbox!, input.replyTo.id);
            answers = { from: String(parent.from ?? ''), subject: String(parent.subject ?? ''), text: String(parent.text ?? '') };
            if (parent.truncated) unreadable = true;
          } catch { unreadable = true; }
        }
        const checked: StandingCheckEmail = { to: input.to, cc: input.cc, subject: input.subject, body: input.body, ...(answers ? { answers } : {}) };
        // An email longer than the check reads never goes out unchecked (fail closed).
        const tooLong = standingTooLong(checked);
        const verdict = !tooLong && !unreadable && deps.fitCheck ? await deps.fitCheck(rule!.kind, checked).catch(() => null) : null;
        // The check can take a minute: the approval, the access and the grant are
        // checked again before anything leaves, so a revoke in that time holds.
        const now = deps.getConfig();
        if (sendingFor(now, agentId, mailbox!) === 'send') {
          // Switched to Can send while the check ran: the standing approval no
          // longer applies and nothing goes on Ask me (owner, 2026-10-09), so
          // the email goes out as any other send, whatever the check said.
          const out = await svc.send(agentId, mailbox!, input, () => {
            const a = mailAccess(deps.getConfig(), agentId, mailbox, 'send', undefined, { present: deps.present });
            return a.ok ? null : a.reason;
          });
          if (underGrant && !(out as { repeated?: boolean }).repeated) {
            recordGrantSend(out, input);
            try { deps.audit?.({ kind: 'mail-sent', agentId, mailbox, messageId: String(out.messageId ?? ''), grant: true }); } catch { /* the send stands */ }
          }
          return { status: 200, body: out };
        }
        const still = deps.proposals.getStanding(standingId);
        const stillProblem = standingProblem(still, agentId, mailbox!, input);
        const stillAccess = mailAccess(now, agentId, mailbox, 'send', standingId, { present: deps.present });
        if (stillProblem || !stillAccess.ok) return { status: 409, body: { error: stillProblem ?? (stillAccess.ok ? '' : stillAccess.reason) } };
        if (!verdict?.fits) {
          const why = unreadable ? 'It answers an email the check could not read in full, so the owner decides.'
            : tooLong ? 'It is longer than the check can read, so the owner decides.'
              : verdict && !verdict.fits ? verdict.reason : 'The check could not confirm it fits.';
          const p = deps.proposals.file({ agentId, mailbox: mailbox!, to: input.to, cc: input.cc, subject: input.subject, body: input.body, replyTo: input.replyTo, forward: input.forward, attachFrom: input.attachFrom, ...(input.thread ? { thread: input.thread } : {}) });
          try { deps.audit?.({ kind: 'mail-standing-refused', agentId, mailbox, standing: rule!.id, proposal: p.id }); } catch { /* the filing stands */ }
          return { status: 200, body: { sent: false, proposal: p.id, state: 'waiting for the owner on Ask me', why: `Not sent under your standing approval: ${why}`, next: 'It is on Ask me now. You will get a message when the owner decides; then send it with this proposal id.' } };
        }
        const out = await svc.send(agentId, mailbox!, input, () => {
          const problemNow = standingProblem(deps.proposals!.getStanding(standingId), agentId, mailbox!, input);
          const a = mailAccess(deps.getConfig(), agentId, mailbox, 'send', standingId, { present: deps.present });
          return problemNow ?? (a.ok ? null : a.reason);
        });
        // A repeat of an email that already went out is not a new send: nothing
        // is recorded or logged twice.
        if (!(out as { repeated?: boolean }).repeated) {
          try { deps.proposals.recordStandingSend(rule!.id, input); } catch (e) { console.error('[mail] standing send record failed:', rule!.id, e); }
          recordGrantSend(out, input);
          try { deps.audit?.({ kind: 'mail-sent-standing', agentId, mailbox, standing: rule!.id, ...grantFlag }); } catch { /* the send stands */ }
        }
        return { status: 200, body: out };
      } finally { sendingStanding.delete(sendKey); }
    }
    if (op === 'search') {
      return { status: 200, body: await svc.search(mailbox!, {
        text: str(body.text, 200), from: str(body.from, 200), subject: str(body.subject, 200), since: str(body.since, 40),
        unread: body.unread === true, limit: typeof body.limit === 'number' ? body.limit : undefined, page: typeof body.page === 'number' ? body.page : undefined,
        folder: str(body.folder, 80)
      }) };
    }
    if (op === 'read') {
      // Long enough for the longest id search gives: "label:" + a 60 character label + ":" + uid.
      const id = str(body.id, 100) ?? (typeof body.id === 'number' ? String(body.id) : undefined);
      if (!id) return { status: 400, body: { error: 'read needs the message id from search.' } };
      return { status: 200, body: await svc.read(mailbox!, id) };
    }
    if (op === 'archive' || op === 'mark_read' || op === 'mark_junk') {
      const raw = Array.isArray(body.ids) ? body.ids : body.id !== undefined ? [body.id] : [];
      // Only inbox mail is archived, marked or moved: anything else is already out of the inbox.
      const outside = raw.find((v) => typeof v === 'string' && /^(sent|archive|label):/.test(v.trim()));
      if (outside !== undefined) return { status: 400, body: { error: `${op} works on inbox messages only; "${outside}" is already out of the inbox.` } };
      const uids = [...new Set(raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))];
      if (!uids.length) return { status: 400, body: { error: `${op} needs "ids": the message ids from search.` } };
      if (uids.length > ORGANIZE_MAX) return { status: 400, body: { error: `At most ${ORGANIZE_MAX} messages per call.` } };
      const label = op === 'archive' ? str(body.label, 60)?.trim().replace(/[\r\n]/g, ' ') : undefined;
      const problem = label ? labelProblem(label) : null;
      if (problem) return { status: 400, body: { error: problem } };
      const done = await svc.organize(mailbox!, op, uids, label);
      // Every move is written to the office log, so the owner can see what an
      // agent cleared from the inbox and where it went.
      try { deps.audit?.({ kind: 'mail-organize', agentId, mailbox, action: op, ids: done.done, ...(label ? { label } : {}) }); } catch { /* the move stands */ }
      return { status: 200, body: done };
    }
    if (!input.to || !input.subject) return { status: 400, body: { error: `${op} needs "to" and "subject".` } };
    if (op === 'draft') return { status: 200, body: await svc.draft(mailbox!, input) };
    if (op === 'propose') {
      if (!deps.proposals) return { status: 503, body: { error: 'Approvals are not available right now. Tell Michael.' } };
      if (!input.body.trim()) return { status: 400, body: { error: 'propose needs a "body".' } };
      const offer = str(body.offer_standing, STANDING_KIND_MAX)?.replace(/\s+/g, ' ').trim();
      const p = deps.proposals.file({ agentId, mailbox: mailbox!, to: input.to, cc: input.cc, subject: input.subject, body: input.body, replyTo: input.replyTo, forward: input.forward, attachFrom: input.attachFrom, ...(input.thread ? { thread: input.thread } : {}), ...(offer ? { offerStanding: offer } : {}) });
      return { status: 200, body: { proposal: p.id, state: 'waiting for the owner on Ask me', ...(p.replaces ? { replaced: p.replaces, note: `This replaces your earlier proposal ${p.replaces} for the same email; that id no longer works.` } : {}), next: 'Nothing is sent yet. You will get a message when the owner decides: approved (then call send with this proposal id), changes asked, or not sent. Do not send it another way.' } };
    }
    const out = await svc.send(agentId, mailbox!, input, () => {
      const a = mailAccess(deps.getConfig(), agentId, mailbox, 'send', undefined, { present: deps.present });
      return a.ok ? null : a.reason;
    });
    if (underGrant && !out.repeated) {
      recordGrantSend(out, input);
      // Who wrote as another member's address, by id only: the office log is
      // committed to git and agents read it, so no recipient or subject (D14).
      try { deps.audit?.({ kind: 'mail-sent', agentId, mailbox, messageId: String(out.messageId ?? ''), grant: true }); } catch { /* the send stands */ }
    }
    return { status: 200, body: out };
  } catch (e) {
    const err = classifyMailError(e);
    const status = err.kind === 'not-found' ? 404 : err.kind === 'bad-request' ? 400 : err.kind === 'timeout' ? 504 : 502;
    return { status, body: { error: err.message, kind: err.kind } };
  }
}

// ── Settings: add, fix, remove mailboxes; set Capabilities ─────────────────

export interface MailAdminDeps {
  getConfig(): MailAccessConfig & { mailboxes?: MailboxRecord[] };
  saveConfig(patch: { mailboxes?: MailboxRecord[]; agentCapabilities?: MailAccessConfig['agentCapabilities'] }): void;
  setSecret(ref: string, value: string): { ok: boolean; error?: string };
  /** False when the secret may still be stored (the file could not be read or written). */
  deleteSecret(ref: string): boolean;
  /** A Send only grant ended: withdraw its emails, revoke its standing
   *  approvals (D13). Optional so tests can leave it out. */
  endGrant?(agentId: string, mailbox: string, reason: string): void;
  /** Withdraw an agent's waiting and approved emails from a mailbox. */
  cancelFor?(agentId: string, mailbox: string, reason: string): void;
  /** The owner changed an agent's Sending on a mailbox it keeps: tell it,
   *  note it in its memory, and on Can send hand back its waiting emails. */
  sendingChanged?(agentId: string, mailbox: string, address: string, sending: SendingMode, handBack: boolean): void;
  /** Whether a team member is on the roster, for a grant's pause. Absent: assumed. */
  present?(agentId: string): boolean;
  /** Whether this computer can encrypt a password right now. Absent: assumed. */
  canStoreSecrets?(): boolean;
}

/** What the owner reads when the password could not be kept encrypted on this
 *  computer: the OS secret store (Keychain, DPAPI, or a Linux keyring) is
 *  unavailable or refused. Says what to do, never the raw error. */
/** Why a password that passed the encryption check was still not saved: the
 *  keychain went away meanwhile, or the secrets file is damaged (its own plain
 *  words), or anything else. Never the raw error, which goes to the log. */
function storeFailedReason(admin: MailAdminDeps, error: string | undefined): string {
  if (admin.canStoreSecrets && !admin.canStoreSecrets()) return cannotStoreReason();
  if (error === SECRETS_FILE_UNREADABLE) return error;
  return "Couldn't store the password securely on this computer, so nothing was saved. Try again.";
}

export function cannotStoreReason(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') {
    return 'This Mac could not store the password safely in its keychain, so nothing was saved. If macOS asks whether this app may use your keychain, choose Allow. Then try again, and restart the Mac if it keeps happening.';
  }
  if (platform === 'linux') {
    return 'This computer could not store the password safely because no keyring is unlocked, so nothing was saved. Set up a keyring such as GNOME Keyring or KWallet, unlock it, then try again.';
  }
  return 'This computer could not store the password safely, so nothing was saved. Restart the computer, then try again.';
}

export interface AddMailboxInput {
  /** Present when fixing an existing mailbox (new password or servers). */
  id?: string;
  provider: MailboxRecord['provider'];
  address: string;
  password: string;
  imap?: MailServer;
  smtp?: MailServer;
}

/** Test first, then store: nothing is saved for a mailbox that does not work
 *  (design review 3A: failure shows its reason and "Try again"). */
export async function saveMailbox(svc: MailService, admin: MailAdminDeps, presets: Record<string, { imap: MailServer; smtp: MailServer }>, input: AddMailboxInput): Promise<{ ok: true; record: MailboxRecord } | { ok: false; kind: MailErrorKind | 'invalid'; reason: string }> {
  const address = (input.address ?? '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return { ok: false, kind: 'invalid', reason: 'That does not look like an email address.' };
  if (!input.password || !input.password.trim()) return { ok: false, kind: 'invalid', reason: 'Enter the app password.' };
  const preset = presets[input.provider];
  const imap = preset?.imap ?? input.imap;
  const smtp = preset?.smtp ?? input.smtp;
  if (!imap?.host || !smtp?.host) return { ok: false, kind: 'invalid', reason: 'Enter the incoming and outgoing mail servers.' };
  const cfg = admin.getConfig();
  const existing = cfg.mailboxes ?? [];
  // Fixing a mailbox keeps its id; any other save (including a made up id)
  // must not add a second record for an address that is already connected.
  const fixing = input.id ? existing.find((m) => m.id === input.id) : undefined;
  if (existing.some((m) => m.address.toLowerCase() === address.toLowerCase() && m.id !== fixing?.id)) {
    return { ok: false, kind: 'invalid', reason: `${address} is already connected.` };
  }
  // A password this computer cannot encrypt is never saved, so say so before
  // logging in to the provider, not after a test that worked.
  if (admin.canStoreSecrets && !admin.canStoreSecrets()) return { ok: false, kind: 'unsupported', reason: cannotStoreReason() };
  const password = input.password.replace(/\s+/g, '');
  const tested = await svc.test({ address, imap, smtp }, password);
  if (!tested.ok) return { ok: false, kind: tested.kind, reason: tested.reason };

  const id = fixing ? fixing.id : mailboxIdFor(address, existing.map((m) => m.id));
  const stored = admin.setSecret(secretRefForMailbox(id), password);
  if (!stored.ok) {
    console.error('[mail] password not stored:', id, stored.error);
    return { ok: false, kind: 'unknown', reason: storeFailedReason(admin, stored.error) };
  }
  const now = Date.now();
  const prior = existing.find((m) => m.id === id);
  const record: MailboxRecord = { id, address, provider: input.provider, imap, smtp, status: 'connected', createdAt: prior?.createdAt ?? now, updatedAt: now };
  admin.saveConfig({ mailboxes: prior ? existing.map((m) => (m.id === id ? record : m)) : [...existing, record] });
  svc.close(id); // a fixed password must not reuse the old connection
  return { ok: true, record };
}

/** Remove a mailbox, its password and every agent's grant to it (design 8A). */
export function removeMailbox(svc: MailService, admin: MailAdminDeps, id: string): { ok: boolean; affected: string[] } {
  const cfg = admin.getConfig();
  const affected: string[] = [];
  const caps = { ...(cfg.agentCapabilities ?? {}) };
  const address = mailboxAddress(cfg, id);
  const ended: string[] = [];
  // Its owner loses it too: the same rule as a grant (ship D3). Read before
  // the save below changes the record.
  for (const [agentId, c] of Object.entries(caps)) {
    if (c.email?.enabled && c.email.mailboxes[0] === id) ended.push(agentId);
  }
  for (const [agentId, c] of Object.entries(caps)) {
    // A removed mailbox drops its Send only grants (3b).
    if (c.sendOnly?.mailbox === id) {
      const { sendOnly: _gone, ...rest } = caps[agentId];
      caps[agentId] = rest;
      if (!ended.includes(agentId)) ended.push(agentId);
      if (!affected.includes(agentId)) affected.push(agentId);
    }
    if (c.email?.mailboxes.includes(id)) {
      // Only the first listed mailbox is ever in use (one per agent), so an
      // older record listing two must not fall through to the second one.
      if (c.email.mailboxes[0] === id && !affected.includes(agentId)) affected.push(agentId);
      caps[agentId] = { ...caps[agentId], email: { ...c.email, mailboxes: c.email.mailboxes.slice(0, 1).filter((m) => m !== id) } };
    }
  }
  admin.saveConfig({ mailboxes: (cfg.mailboxes ?? []).filter((m) => m.id !== id), agentCapabilities: caps });
  for (const agentId of ended) {
    try { admin.endGrant?.(agentId, id, `${address} was removed in Settings.`); } catch (e) { console.error('[mail] end grant:', e); }
  }
  if (admin.deleteSecret(secretRefForMailbox(id)) === false) console.error('[mail] the mailbox was removed, but its saved password could not be:', id);
  svc.close(id);
  return { ok: true, affected };
}

/** Save one agent's Capabilities. Unknown mailbox ids are dropped. Returns
 *  whether the mail tools just became attached (email on or a Send only grant;
 *  E2: that agent needs a restart to get md-mail). */
export function setAgentCapabilities(
  admin: MailAdminDeps,
  agentId: string,
  next: { email?: { enabled: boolean; mailboxes: string[]; send: boolean; sending?: SendingMode }; move?: boolean }
): { ok: boolean; restartNeeded: boolean; heldBy?: string; movedFrom?: string } {
  const cfg = admin.getConfig();
  const known = new Set((cfg.mailboxes ?? []).map((m) => m.id));
  const before = cfg.agentCapabilities?.[agentId];
  // The renderer is not trusted with the shape: anything that is not a list of
  // strings becomes no mailbox.
  const picked = Array.isArray(next.email?.mailboxes) ? next.email.mailboxes.filter((m): m is string => typeof m === 'string') : [];
  // Sending is one of three; `send` is kept in step for older readers.
  const sending = next.email ? sendingMode(next.email) : undefined;
  const email = next.email && sending
    ? { enabled: next.email.enabled === true, mailboxes: picked.filter((m) => known.has(m)).slice(0, 1), send: sending === 'send', sending }
    : undefined;
  // One agent per mailbox (owner, 2026-09-27). Giving a held mailbox to another
  // agent is refused unless the owner confirmed the move, which turns the
  // holder's email off in the same write.
  const caps = { ...(cfg.agentCapabilities ?? {}) };
  let movedFrom: string | undefined;
  // Checked only when the mailbox changes, so an agent that already shared one
  // before this rule can still change its other settings.
  const changed = email?.mailboxes[0] !== (before?.email?.enabled ? before.email.mailboxes[0] : undefined);
  if (email?.enabled && email.mailboxes[0] && changed) {
    const holder = mailboxHolder(caps, email.mailboxes[0], agentId);
    if (holder && next.move !== true) return { ok: false, restartNeeded: false, heldBy: holder };
    if (holder) {
      caps[holder] = { ...caps[holder], email: { enabled: false, mailboxes: [], send: false, sending: 'draft' } };
      movedFrom = holder;
    }
  }
  const after: AgentCapabilities = { ...(before ?? {}), email };
  // Owning the mailbox it sent only from covers the grant: the grant goes,
  // and its proposals and standing approvals stay, keyed by agent and mailbox (EV8).
  if (after.sendOnly && email?.enabled && email.mailboxes[0] === after.sendOnly.mailbox) delete after.sendOnly;
  admin.saveConfig({ agentCapabilities: { ...caps, [agentId]: after } });
  // Its own mailbox follows the Send only rule (owner, 2026-10-07, ship D3):
  // losing the mailbox withdraws its emails from there and revokes its standing
  // approvals; Draft only withdraws its emails.
  const address = (m: string): string => mailboxAddress(cfg, m);
  const ownedBefore = before?.email?.enabled ? before.email.mailboxes[0] : undefined;
  const ownedAfter = email?.enabled ? email.mailboxes[0] : undefined;
  // Each cleanup on its own, so one failing never skips the other.
  try {
    if (movedFrom && email?.mailboxes[0]) admin.endGrant?.(movedFrom, email.mailboxes[0], `The owner gave ${address(email.mailboxes[0])} to another team member.`);
  } catch (e) { console.error('[mail] mailbox move:', e); }
  try {
    if (ownedBefore && ownedBefore !== ownedAfter) {
      admin.endGrant?.(agentId, ownedBefore, ownedAfter ? `The owner gave you ${address(ownedAfter)} instead of ${address(ownedBefore)}.` : `The owner turned your email from ${address(ownedBefore)} off.`);
    } else if (ownedBefore && ownedBefore === ownedAfter && sending && sending !== sendingMode(before!.email)) {
      if (sending === 'draft') admin.cancelFor?.(agentId, ownedBefore, `The owner set you to Draft only from ${address(ownedBefore)}.`);
      admin.sendingChanged?.(agentId, ownedBefore, address(ownedBefore), sending, true);
    }
  } catch (e) { console.error('[mail] mailbox change:', e); }
  return { ok: true, restartNeeded: mailToolsJustAttached(before, after), ...(movedFrom ? { movedFrom } : {}) };
}

/**
 * Save one member's Send only grant (shared-mailboxes.md), or clear it with
 * null. The mailbox must be connected and not the member's own; Sending is one
 * of three, Draft only when unsure. Removing the grant withdraws its emails and
 * revokes its standing approvals (D13); switching it to Draft only withdraws
 * its emails. Returns whether the member needs a restart to get the mail tools.
 */
export function setSendOnly(
  admin: MailAdminDeps,
  agentId: string,
  next: { mailbox?: unknown; sending?: unknown } | null
): { ok: boolean; restartNeeded: boolean } {
  const cfg = admin.getConfig();
  const before = cfg.agentCapabilities?.[agentId];
  const prior = before?.sendOnly;
  let grant: SendOnlyGrant | undefined;
  if (next) {
    const mailbox = typeof next.mailbox === 'string' ? next.mailbox : '';
    const known = (cfg.mailboxes ?? []).some((m) => m.id === mailbox);
    const own = !!before?.email?.enabled && before.email.mailboxes[0] === mailbox;
    if (!known || own) return { ok: false, restartNeeded: false };
    const sending: SendingMode = asSendingMode(next.sending);
    grant = { mailbox, sending };
  }
  const after: AgentCapabilities = { ...(before ?? {}) };
  if (grant) after.sendOnly = grant; else delete after.sendOnly;
  admin.saveConfig({ agentCapabilities: { ...(cfg.agentCapabilities ?? {}), [agentId]: after } });
  const address = (m: string): string => mailboxAddress(cfg, m);
  try {
    if (prior?.mailbox && prior.mailbox !== grant?.mailbox) {
      admin.endGrant?.(agentId, prior.mailbox, `The owner removed your Send only access to ${address(prior.mailbox)}.`);
    } else if (prior && grant && grant.sending !== asSendingMode(prior.sending)) {
      if (grant.sending === 'draft') admin.cancelFor?.(agentId, grant.mailbox, `The owner set you to Draft only from ${address(grant.mailbox)}.`);
      // A paused grant can't send, so its waiting emails stay on Ask me (Codex
      // review): handing them back would strand them.
      admin.sendingChanged?.(agentId, grant.mailbox, address(grant.mailbox), grant.sending, !grantPaused(admin.getConfig(), grant.mailbox, admin.present));
    }
  } catch (e) { console.error('[mail] grant change:', e); }
  return { ok: true, restartNeeded: mailToolsJustAttached(before, after) };
}
