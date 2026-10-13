import { useEffect, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Select, Toggle, TriggerCard, MiniButton } from './triggers/ui';
import { AgentSchedules, useGodId, useMissions } from './triggers/ScheduleList';
import { useHarnessConfig } from '@/hooks/useHarnessConfig';
import { useStore, type Agent } from '@/store/store';
import { type EmailCapability, type SendingMode, asSendingMode, mailboxHolder, sendersFrom, sendingMode } from '@shared/mailboxes';
import { SENDING_LABEL_KEY } from './sendingLabels';
import { useRtl } from '@/i18n/useDirection';
import type { StandingApproval } from '@shared/mailProposals';
import { missionsFor } from '@shared/missions';
import { quickbooksCapability, type QuickBooksCapability } from '@shared/quickbooks';
import { connectorGranted, connectorOn, isQuickBooksKey } from '@shared/claudeConnectors';
import { useResolvedGodName } from '@/hooks/useResolvedGodName';
import { InfoTip } from './InfoTip';
import { SHOW_MAILBOXES } from '@shared/buildFeatures';

type SectionKey = 'email' | 'connectors' | 'schedules';

/**
 * What a team member may do without asking, and the jobs it runs on a clock
 * (docs/designs/multi-mailbox.md, design review D-T3; schedules merged in by the
 * owner, 2026-09-26). Its own tab after Profile on every agent, Michael included.
 * Two sections, both closed whenever the tab opens, like every section on
 * every agent tab (owner, 2026-09-26); the header chip says what is inside:
 *
 * - Email: the section header carries the one on/off switch (owner,
 *   2026-09-26). With email on, the body is the agent's one mailbox, picked
 *   from a list (or a link to Settings when none is set up), then Sending with Draft only first chosen (6A), then
 *   the pending restart note (E2/E5).
 * - Claude connectors (docs/designs/claude-connectors.md, design D4): one row
 *   and switch per connector the owner turned on in Settings, or a link to
 *   Settings when none is. QuickBooks keeps Read only or Can make changes under
 *   its row, and before the owner chooses, roles that read the books (Oscar)
 *   are on, Read only. The hook checks every call at once; the agent restarts
 *   when idle so a new connector loads (useHive effect 8), or at Restart now.
 * - On a schedule: the agent's own jobs (docs/designs/per-agent-schedules.md),
 *   the same list and editor the Schedules tab had.
 *
 * Every change saves at once through main, which checks it and says whether
 * email just turned on; if it did and the agent is running, it is queued for a
 * restart (useHive effect 8). Main asks for a connector restart itself.
 */
export function CapabilitiesTab({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const config = useHarnessConfig();
  const godName = useResolvedGodName();
  const pending = useStore((s) => s.pendingRestart[agent.id]);
  const [failed, setFailed] = useState(false);
  // A mailbox another agent holds, waiting for the owner to confirm the move.
  const [moving, setMoving] = useState<string | null>(null);
  // Add a mailbox: which one, and whether to watch its inbox or send only.
  const [adding, setAdding] = useState(false);
  const [addId, setAddId] = useState('');
  const [addKind, setAddKind] = useState<'watch' | 'send' | ''>('');
  // Removing an inbox others send from pauses their access: asked first.
  const [confirmRemove, setConfirmRemove] = useState(false);
  const agents = useStore((s) => s.agents);
  const name = agent.isGod ? godName : agent.name;
  const godId = useGodId();
  const { missions } = useMissions();
  const mine = missionsFor(missions, agent.id, godId);
  const schedulesOn = mine.filter((m) => m.enabled).length;
  const [collapsed, setCollapsed] = useState<Record<SectionKey, boolean>>({ email: true, connectors: true, schedules: true });
  // Unknown until main answers for this agent (the card stays hidden), so
  // Oscar's switch never shows off while the hook treats him as on, and
  // another agent's answer never shows.
  const [booksAnswer, setBooksAnswer] = useState<{ id: string; on: boolean } | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void window.cth.quickbooksRoleDefaults().then((ids) => { if (alive) setBooksAnswer({ id: agent.id, on: ids.includes(agent.id) }); }).catch(() => {});
    return () => { alive = false; };
  }, [agent.id]);
  const booksDefault = booksAnswer?.id === agent.id ? booksAnswer.on : undefined;
  const setFold = (key: SectionKey, open: boolean): void => setCollapsed({ ...collapsed, [key]: !open });

  if (!config) return null;
  const mailboxes = config.mailboxes ?? [];
  const email: EmailCapability = config.agentCapabilities?.[agent.id]?.email ?? { enabled: false, mailboxes: [], send: false, sending: 'draft' };

  const grant = config.agentCapabilities?.[agent.id]?.sendOnly;

  const save = async (next: EmailCapability, move = false): Promise<void> => {
    setFailed(false);
    try {
      const res = await window.cth.mailSetCapabilities(agent.id, { email: next, ...(move ? { move: true } : {}) });
      // Someone took the mailbox since the list was drawn: ask to move it.
      if (!res.ok && res.heldBy && next.mailboxes[0]) { setMoving(next.mailboxes[0]); return; }
      if (!res.ok) { setFailed(true); return; }
      setMoving(null);
      if (res.restartNeeded && agent.ptyId) useStore.getState().setPendingRestart(agent.id, { at: Date.now(), reason: 'email' });
      // A Send only grant still needs the mail tools, so its restart stays (OV10).
      if (!next.enabled && !grant && pending?.reason === 'email') useStore.getState().setPendingRestart(agent.id, undefined);
    } catch { setFailed(true); }
  };

  // Send only from another member's mailbox (docs/designs/shared-mailboxes.md):
  // its own Sending, Draft only first.
  const saveGrant = async (next: { mailbox: string; sending: SendingMode } | null): Promise<void> => {
    setFailed(false);
    try {
      const res = await window.cth.mailSetSendOnly(agent.id, next);
      if (!res.ok) { setFailed(true); return; }
      if (res.restartNeeded && agent.ptyId) useStore.getState().setPendingRestart(agent.id, { at: Date.now(), reason: 'email' });
      if (!next && !email.enabled && pending?.reason === 'email') useStore.getState().setPendingRestart(agent.id, undefined);
    } catch { setFailed(true); }
  };

  // Email is the list of addresses this member uses (owner, 2026-10-07): the
  // one inbox it watches (one member per mailbox) and the one it sends only
  // from. No on/off switch: sending never looks like it works with email off.
  const known = new Set(mailboxes.map((m) => m.id));
  const current = email.enabled ? email.mailboxes.find((id) => known.has(id)) : undefined;
  const sendFrom = grant && known.has(grant.mailbox) && grant.mailbox !== current ? grant : undefined;
  const addressOf = (id: string): string => mailboxes.find((m) => m.id === id)?.address ?? id;
  // One agent per mailbox (owner, 2026-09-27): a mailbox another agent holds
  // is moved only after the owner confirms, and the holder's email goes off.
  // An id no longer on the team (a fired or failed hire) doesn't hold anything.
  // Restorable members (the app moves everyone there at launch until they
  // respawn) still hold their mailbox, so taking it asks first (EV1).
  const onTeam = (id: string): boolean => agents.some((a) => a.id === id)
    || useStore.getState().restorableAgents.some((a) => a.id === id)
    || useStore.getState().archivedAgents.some((a) => a.id === id);
  // Reads the mailbox now: on the team, not archived (S3, EV1).
  const reads = (id: string): boolean => agents.some((a) => a.id === id) || useStore.getState().restorableAgents.some((a) => a.id === id);
  const holderOf = (id: string): string | undefined => {
    const h = mailboxHolder(config.agentCapabilities, id, agent.id);
    return h && onTeam(h) ? h : undefined;
  };
  const nameOf = (id: string): string => agents.find((a) => a.id === id)?.name
    ?? useStore.getState().restorableAgents.find((a) => a.id === id)?.name ?? id;
  // Watching starts on Draft only (design 6A).
  const watchMailbox = (id: string): void => {
    if (id === current) return;
    if (holderOf(id)) { setMoving(id); return; }
    // A left-over holder that isn't on the team is moved without asking.
    void save({ enabled: true, mailboxes: [id], send: false, sending: 'draft' }, !!mailboxHolder(config.agentCapabilities, id, agent.id));
  };
  const stopWatching = (): void => { void save({ enabled: false, mailboxes: [], send: false, sending: 'draft' }); };
  const movingHolder = moving ? holderOf(moving) : undefined;
  const movingAddress = moving ? addressOf(moving) : '';
  // Can send, Send on approval or Draft only (send-on-approval.md); `send` stays in step.
  const sending = sendingMode(email);
  const setSending = (next: SendingMode): void => { if (next !== sending) void save({ ...email, send: next === 'send', sending: next }); };
  const grantSending: SendingMode = sendFrom ? asSendingMode(sendFrom.sending) : 'draft';
  const grantHolder = sendFrom ? mailboxHolder(config.agentCapabilities, sendFrom.mailbox, agent.id) : undefined;
  const grantPausedNow = !!sendFrom && (!(grantHolder && reads(grantHolder)) || mailboxes.find((m) => m.id === sendFrom.mailbox)?.status === 'needs-attention');
  const sendingLabel = (m: SendingMode): string => t(SENDING_LABEL_KEY[m]);
  const sendingOptions = (['send', 'approval', 'draft'] as const).map((m) => ({ value: m, label: sendingLabel(m) }));
  const sendingInfo = [`${t('capabilities.canSend')}: ${t('capabilities.canSendDesc')}`, `${t('capabilities.sendOnApproval')}: ${t('capabilities.sendOnApprovalDesc')}`, `${t('capabilities.draftOnly')}: ${t('capabilities.draftOnlyDesc')}`].join(' ');
  // The owner's side (E3): who else sends from the mailbox this member watches.
  const senders = current ? sendersFrom(config.agentCapabilities, current).filter((x) => x.agentId !== agent.id && reads(x.agentId)) : [];

  // Add a mailbox: any connected address this member doesn't use yet. Watch
  // is one each, and so is Send only; a choice that can't be made is greyed
  // with its reason, never hidden.
  const canWatch = !current;
  const canSendOnly = !sendFrom;
  const addable = mailboxes.filter((m) => m.id !== current && m.id !== sendFrom?.mailbox);
  const addHolder = addId ? holderOf(addId) : undefined;
  const pickAdd = (id: string): void => {
    setAddId(id);
    // A mailbox someone else watches most likely means Send only.
    setAddKind(!id ? '' : canSendOnly && (holderOf(id) || !canWatch) ? 'send' : canWatch ? 'watch' : canSendOnly ? 'send' : '');
  };
  const closeAdd = (): void => { setAdding(false); setAddId(''); setAddKind(''); };
  const confirmAdd = (): void => {
    if (!addId || !addKind) return;
    if (addKind === 'watch') watchMailbox(addId); else void saveGrant({ mailbox: addId, sending: 'draft' });
    closeAdd();
  };
  const inUse = (current ? 1 : 0) + (sendFrom ? 1 : 0);

  const books = quickbooksCapability(config.agentCapabilities?.[agent.id]?.quickbooks, booksDefault === true);
  const saveBooks = async (next: QuickBooksCapability): Promise<void> => {
    setFailed(false);
    try {
      const res = await window.cth.quickbooksSetAccess(agent.id, next);
      if (!res.ok) setFailed(true);
    } catch { setFailed(true); }
  };
  // Turning QuickBooks on always starts Read only.
  const toggleBooks = (): void => {
    void saveBooks(books.enabled ? { enabled: false, changes: false } : { enabled: true, changes: false });
  };

  // The connectors the owner turned on, A to Z. QuickBooks waits for its role
  // default, so Oscar's switch never shows off while the hook treats him as on.
  const connectors = (config.claudeConnectors?.list ?? [])
    .filter((c) => connectorOn(config, c.key) && (!isQuickBooksKey(c.key) || booksDefault !== undefined))
    .sort((a, b) => a.key.localeCompare(b.key));
  const holds = (key: string): boolean => connectorGranted(config, agent.id, key, booksDefault === true);
  const granted = connectors.filter((c) => holds(c.key)).length;
  const setGrant = async (key: string, on: boolean): Promise<void> => {
    setFailed(false);
    try {
      const res = await window.cth.connectorsSetGrant(agent.id, key, on);
      if (!res.ok) setFailed(true);
    } catch { setFailed(true); }
  };
  const restartNow = (): void => { if (pending) useStore.getState().setPendingRestart(agent.id, { ...pending, now: true, failed: false }); };

  const openSettings = (): void => { window.dispatchEvent(new CustomEvent('cth:open-settings', { detail: { section: 'Connections' } })); };

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 }}>
      <div style={{ maxWidth: '72ch' }}>
        <div style={hint}>{t('capabilities.intro', { name })}</div>

        <div style={{ height: 8 }} />
        {/* Email: hidden in this build when SHOW_MAILBOXES is off. */}
        {SHOW_MAILBOXES && <TriggerCard
          title={t('capabilities.email')}
          blurb={t('capabilities.emailBlurb', { name })}
          summary={inUse ? t('capabilities.emailSummary', { count: inUse }) : t('capabilities.emailSummaryNone')}
          open={!collapsed.email}
          onToggle={(open) => setFold('email', open)}
        >
          <div role="list">
            {current && (
              <div role="listitem" style={{ ...mailboxRow, borderTop: 'none' }}>
                <div style={mailboxTop}>
                  <span style={address}>{addressOf(current)}</span>
                  <MiniButton onClick={() => { if (senders.length) setConfirmRemove(true); else stopWatching(); }}>{t('capabilities.removeMailbox')}</MiniButton>
                </div>
                <div style={facts}>
                  <span style={factKey}>{t('capabilities.inbox')}</span>
                  <span style={factValue}><Dot on />{t('capabilities.inboxWatches', { name })}</span>
                  <span style={factKey}>{t('capabilities.sending')}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                    <RadioRows inline label={t('capabilities.sendingFrom', { address: addressOf(current) })} value={sending} options={sendingOptions} onChange={(v) => setSending(v as SendingMode)} />
                    <InfoTip label={t('capabilities.sending')} text={sendingInfo} />
                  </span>
                </div>
                {confirmRemove && senders.length > 0 && (
                  <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap', fontSize: 13 }}>
                    <span>{t('capabilities.removeWatchedSure', { address: addressOf(current), names: senders.map((x) => nameOf(x.agentId)).join(t('profile.listJoiner')) })}</span>
                    <MiniButton tone="destructive" autoFocus onClick={() => { setConfirmRemove(false); stopWatching(); }}>{t('mailboxes.removeIt')}</MiniButton>
                    <MiniButton onClick={() => setConfirmRemove(false)}>{t('mailboxes.keep')}</MiniButton>
                  </div>
                )}
                {senders.length > 0 && (
                  <div style={{ ...hint, marginTop: 6 }}>
                    {t('capabilities.alsoSendsFromHere', { names: senders.map((x) => `${nameOf(x.agentId)} (${sendingLabel(x.sending)})`).join(t('profile.listJoiner')) })}
                  </div>
                )}
                {current && <StandingApprovals agentId={agent.id} mailbox={current} />}
              </div>
            )}
            {sendFrom && (
              <div role="listitem" style={current ? mailboxRow : { ...mailboxRow, borderTop: 'none' }}>
                <div style={mailboxTop}>
                  <span style={address}>{addressOf(sendFrom.mailbox)}</span>
                  <MiniButton onClick={() => { void saveGrant(null); }}>{t('capabilities.removeMailbox')}</MiniButton>
                </div>
                <div style={facts}>
                  <span style={factKey}>{t('capabilities.inbox')}</span>
                  <span style={factValue}>
                    <Dot />
                    {grantHolder && reads(grantHolder)
                      ? t('capabilities.inboxSendOnly', { holder: nameOf(grantHolder), name })
                      : t('capabilities.inboxNobody', { name })}
                  </span>
                  <span style={factKey}>{t('capabilities.sending')}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                    <RadioRows inline label={t('capabilities.sendingFrom', { address: addressOf(sendFrom.mailbox) })} value={grantSending} options={sendingOptions} onChange={(v) => { if (v !== grantSending) void saveGrant({ mailbox: sendFrom.mailbox, sending: v as SendingMode }); }} />
                    <InfoTip label={t('capabilities.sending')} text={sendingInfo} />
                  </span>
                </div>
                {grantPausedNow && (
                  <div role="status" style={{ ...notice, background: 'var(--cth-amber-soft)' }}>{t('capabilities.sendOnlyPaused', { name })}</div>
                )}
                <StandingApprovals agentId={agent.id} mailbox={sendFrom.mailbox} />
                <RecentSends agentId={agent.id} mailbox={sendFrom.mailbox} />
              </div>
            )}
          </div>
          {!current && !sendFrom && <div style={hint}>{t('capabilities.emailNone', { name })}</div>}

          {mailboxes.length === 0 ? (
            <div style={{ ...notice, background: 'var(--cth-neutral-soft)' }}>
              {t('capabilities.noMailboxes')}{' '}
              <button type="button" onClick={openSettings} style={link}>{t('capabilities.addInSettings')}</button>
            </div>
          ) : adding ? (
            <div style={addPanel}>
              <div style={{ ...h13, marginTop: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
                {t('capabilities.addMailboxUse')}
                <InfoTip label={t('capabilities.addMailboxUse')} text={t('capabilities.addMailboxInfo', { name })} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <Select label={t('capabilities.addMailboxUse')} value={addId} onChange={pickAdd} style={{ maxWidth: '100%', fontFamily: 'var(--cth-font-mono)', fontSize: 12 }}>
                  <option value="">{t('capabilities.pickMailbox')}</option>
                  {addable.map((m) => {
                    const holder = holderOf(m.id);
                    const desc = [holder ? t('capabilities.heldBy', { name: nameOf(holder) }) : '', m.status === 'needs-attention' ? t('mailboxes.statusNeeds') : ''].filter(Boolean).join(t('profile.listJoiner'));
                    return <option key={m.id} value={m.id}>{desc ? `${m.address} (${desc})` : m.address}</option>;
                  })}
                </Select>
                <button type="button" onClick={openSettings} style={{ ...link, marginInlineStart: 'auto' }}>{t('capabilities.addMailbox')}</button>
              </div>
              {addId && (
                <RadioRows
                  label={t('capabilities.addHow', { name })}
                  value={addKind || undefined}
                  options={[
                    {
                      value: 'watch', label: t('capabilities.addWatch'), disabled: !canWatch,
                      // Visible only when it explains a greyed choice or a consequence;
                      // what each choice means is behind the info icon.
                      desc: !canWatch ? t('capabilities.addWatchTaken', { name, address: addressOf(current!) })
                        : addHolder ? t('capabilities.addWatchMoves', { from: nameOf(addHolder), name }) : undefined
                    },
                    {
                      value: 'send', label: t('capabilities.addSendOnly'), disabled: !canSendOnly,
                      desc: !canSendOnly ? t('capabilities.addSendOnlyTaken', { name, address: addressOf(sendFrom!.mailbox) })
                        : addHolder ? undefined : t('capabilities.addSendOnlyNobody')
                    }
                  ]}
                  onChange={(v) => setAddKind(v as 'watch' | 'send')}
                />
              )}
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <MiniButton onClick={confirmAdd} disabled={!addId || !addKind}>{t('capabilities.addIt')}</MiniButton>
                <MiniButton onClick={closeAdd}>{t('capabilities.cancelAdd')}</MiniButton>
              </div>
            </div>
          ) : addable.length > 0 && (canWatch || canSendOnly) ? (
            <button type="button" onClick={() => { setAdding(true); setCollapsed({ ...collapsed, email: false }); }} style={{ ...link, display: 'block', marginTop: 10 }}>{t('capabilities.addMailboxUse')}</button>
          ) : (
            // Nothing left to add: shown greyed with why, never hidden.
            <div style={{ ...hint, marginTop: 10 }}>
              <span style={{ opacity: 0.55 }}>{t('capabilities.addMailboxUse')}</span>{' '}
              {addable.length === 0 ? (
                <button type="button" onClick={openSettings} style={link}>{t('capabilities.addMailboxNoneLeft')}</button>
              ) : t('capabilities.addMailboxBothUsed', { name })}
            </div>
          )}

          {moving && (
            <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap', fontSize: 13 }}>
              <span>{movingHolder
                ? t('capabilities.moveMailbox', { address: movingAddress, from: nameOf(movingHolder), to: name })
                : t('capabilities.moveMailboxFree', { address: movingAddress })}</span>
              <MiniButton autoFocus onClick={() => { void save({ ...email, enabled: true, mailboxes: [moving] }, true); }}>{t('capabilities.moveIt')}</MiniButton>
              <MiniButton onClick={() => setMoving(null)}>{t('capabilities.keepIt')}</MiniButton>
            </div>
          )}
        </TriggerCard>}

        <TriggerCard
          title={t('capabilities.connectors')}
          blurb={t('capabilities.connectorsBlurb', { name })}
          summary={connectors.length ? t('capabilities.connectorsSummary', { granted, total: connectors.length }) : undefined}
          open={!collapsed.connectors}
          onToggle={(open) => setFold('connectors', open)}
        >
          {connectors.length === 0 ? (
            <div style={hint}>
              {t('capabilities.connectorsNone')}{' '}
              <button type="button" onClick={openSettings} style={link}>{t('capabilities.connectorsTurnOn')}</button>
            </div>
          ) : (
            <div role="list">
              {connectors.map((c, i) => {
                const qbo = isQuickBooksKey(c.key);
                const on = holds(c.key);
                const roleDefault = qbo && booksDefault === true && !config.agentCapabilities?.[agent.id]?.quickbooks;
                return (
                  <div key={c.key} role="listitem" style={{ ...row, flexWrap: 'wrap', borderTop: i === 0 ? 'none' : row.borderTop }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600 }}>{c.key}</span>
                    {c.status === 'needs-sign-in' && <span style={hint}>{t('capabilities.needsSignIn')}</span>}
                    {c.status === 'unreachable' && <span style={hint}>{t('capabilities.unreachable')}</span>}
                    {roleDefault && <span style={hint}>{t('capabilities.booksRoleDefault')}</span>}
                    <Toggle on={on} label={t('capabilities.canUseConnector', { name, connector: c.key })} onClick={() => { if (qbo) toggleBooks(); else void setGrant(c.key, !on); }} />
                    {qbo && on && (
                      <div style={{ flexBasis: '100%', paddingInlineStart: 12 }}>
                        <RadioRows
                          label={t('capabilities.booksChanges')}
                          value={String(books.changes)}
                          options={[{ value: 'false', label: t('capabilities.booksReadOnly'), desc: t('capabilities.booksReadOnlyDesc') }, { value: 'true', label: t('capabilities.booksCanChange'), desc: t('capabilities.booksCanChangeDesc') }]}
                          onChange={(v) => { if ((v === 'true') !== books.changes) void saveBooks({ enabled: true, changes: v === 'true' }); }}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </TriggerCard>

        <TriggerCard
          title={t('capabilities.schedules')}
          blurb={t('capabilities.schedulesBlurb', { name })}
          summary={schedulesOn ? t('capabilities.schedulesOn', { count: schedulesOn }) : t('capabilities.schedulesNone')}
          open={!collapsed.schedules}
          onToggle={(open) => setFold('schedules', open)}
        >
          {!email.enabled && !grant && (
            <div role="status" style={{ ...hint, marginBottom: 8 }}>
               {name} cannot check email
            </div>
          )}
          <AgentSchedules agentId={agent.id} agentName={name} />
        </TriggerCard>

        {/* Outside the sections, so a closed Email section still shows them. */}
        <div aria-live="polite">
          {pending && (pending.reason === 'connectors' || email.enabled || !!grant) && (
            <div style={{ ...notice, background: 'var(--cth-amber-soft)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ flex: 1 }}>
                {pending.failed ? t('capabilities.restartFailed', { name })
                  : pending.now ? t('capabilities.restarting', { name })
                  : pending.reason === 'connectors' ? t('capabilities.connectorsPending', { name }) : t('capabilities.pending', { name })}
              </span>
              {!pending.now && <MiniButton onClick={restartNow}>{t('capabilities.restartNow')}</MiniButton>}
            </div>
          )}
          {failed && <div role="alert" style={{ ...notice, background: 'var(--cth-coral-soft)', color: 'var(--cth-coral-text)' }}>! {t('capabilities.saveFailed')}</div>}
        </div>
      </div>
    </div>
  );
}

/** A one-choice list (DESIGN.md 7.10a Radio row): arrow keys move and choose,
 *  only the chosen row is in the tab order (the first when none is chosen). */
function RadioRows({ label, value, options, onChange, inline = false }: {
  label: string; value: string | undefined; options: Array<{ value: string; label: string; desc?: string; disabled?: boolean }>;
  onChange: (value: string) => void;
  /** Short choices side by side, as pills (the Sending choice on a mailbox). */
  inline?: boolean;
}) {
  const at = options.findIndex((o) => o.value === value);
  const usable = options.filter((o) => !o.disabled);
  // Side by side choices run right to left in Arabic, so the arrows mirror.
  const rtl = useRtl();
  const forward = inline && rtl ? 'ArrowLeft' : 'ArrowRight';
  const back = inline && rtl ? 'ArrowRight' : 'ArrowLeft';
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.key === 'ArrowDown' || e.key === forward ? 1 : e.key === 'ArrowUp' || e.key === back ? -1 : 0;
    if (!step || usable.length === 0) return;
    e.preventDefault();
    const from = Math.max(usable.findIndex((o) => o.value === value), 0);
    const next = usable[(from + step + usable.length) % usable.length];
    onChange(next.value);
    e.currentTarget.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus();
  };
  if (inline) {
    return (
      // No overflow clipping, so a keyboard focus ring shows in full; the ends round themselves.
      <div role="radiogroup" aria-label={label} onKeyDown={onKey} style={{ display: 'inline-flex', boxShadow: 'inset 0 0 0 1px var(--cth-line-input)', borderRadius: 'var(--cth-r-sm)' }}>
        {options.map((o, i) => {
          const checked = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              data-value={o.value}
              aria-checked={checked}
              tabIndex={checked || (at < 0 && i === 0) ? 0 : -1}
              onClick={() => onChange(o.value)}
              style={{ border: 'none', borderInlineStart: i === 0 ? 'none' : '1px solid var(--cth-line)', padding: '0 10px', minHeight: 28,
                borderStartStartRadius: i === 0 ? 'var(--cth-r-sm)' : 0, borderEndStartRadius: i === 0 ? 'var(--cth-r-sm)' : 0,
                borderStartEndRadius: i === options.length - 1 ? 'var(--cth-r-sm)' : 0, borderEndEndRadius: i === options.length - 1 ? 'var(--cth-r-sm)' : 0, fontSize: 11.5, fontFamily: 'var(--cth-font-ui)', cursor: 'pointer', background: checked ? 'var(--cth-ink)' : 'transparent', color: checked ? 'var(--cth-card)' : 'var(--cth-ink)', fontWeight: checked ? 600 : 500 }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {options.map((o, i) => {
        const checked = o.value === value;
        if (o.disabled) {
          // Greyed with its reason, never hidden (owner, 2026-10-03).
          return (
            <div key={o.value} role="radio" aria-checked={false} aria-disabled="true" style={{ ...row, borderTop: i === 0 ? 'none' : row.borderTop, opacity: 0.55 }}>
              <span aria-hidden="true" style={{ width: 16, height: 16, borderRadius: '50%', flexShrink: 0, boxShadow: 'inset 0 0 0 1px var(--cth-line-input)' }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13, fontWeight: 500 }}>{o.label}</span>
                {o.desc && <span style={{ display: 'block', ...hint }}>{o.desc}</span>}
              </span>
            </div>
          );
        }
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            data-value={o.value}
            aria-checked={checked}
            tabIndex={checked || (at < 0 && i === 0) ? 0 : -1}
            onClick={() => onChange(o.value)}
            style={{ ...row, width: '100%', border: 'none', borderTop: i === 0 ? 'none' : row.borderTop, background: 'transparent', cursor: 'pointer', textAlign: 'start', fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink)' }}
          >
            <span aria-hidden="true" style={{ width: 16, height: 16, borderRadius: '50%', flexShrink: 0, boxShadow: checked ? 'none' : 'inset 0 0 0 1px var(--cth-line-input)', background: checked ? 'var(--cth-ink)' : 'var(--cth-card)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              {checked && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--cth-bg)' }} />}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: checked ? 600 : 500 }}>{o.label}</span>
              {o.desc && <span style={{ display: 'block', ...hint }}>{o.desc}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const hint: CSSProperties = { fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-3)' };
const h13: CSSProperties = { fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--cth-ink-3)', margin: '14px 0 6px' };
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: '1px solid var(--cth-line)' };
const notice: CSSProperties = { padding: '8px 10px', borderRadius: 'var(--cth-r-md)', fontSize: 12.5, lineHeight: '18px', color: 'var(--cth-ink)', marginTop: 8 };
const mailboxRow: CSSProperties = { padding: '10px 0', borderTop: '1px solid var(--cth-line)' };
const mailboxTop: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
const address: CSSProperties = { flex: 1, minWidth: 0, fontFamily: 'var(--cth-font-mono)', fontSize: 12.5, fontWeight: 500, overflowWrap: 'anywhere' };
const facts: CSSProperties = { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 12px', alignItems: 'center', marginTop: 8, fontSize: 12.5 };
const factKey: CSSProperties = { fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--cth-ink-3)' };
const factValue: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--cth-ink)' };
const addPanel: CSSProperties = { marginTop: 10, padding: 10, border: '1px solid var(--cth-line)', borderRadius: 'var(--cth-r-md)', background: 'var(--cth-card-2)' };

/** Green when this member watches the inbox, grey when someone else does. */
function Dot({ on = false }: { on?: boolean }) {
  return <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: on ? 'var(--cth-green)' : 'var(--cth-line-input)' }} />;
}

const link: CSSProperties = { border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', textDecoration: 'underline', fontFamily: 'var(--cth-font-ui)', fontSize: 12.5, color: 'var(--cth-indigo-text)' };

/** A list read from main, read again whenever mail approvals change. */
function useMailList<T>(read: () => Promise<T[]>, deps: unknown[]): T[] {
  const [list, setList] = useState<T[]>([]);
  useEffect(() => {
    let alive = true;
    const load = (): void => { void read().then((l) => { if (alive) setList(Array.isArray(l) ? l : []); }).catch(() => {}); };
    load();
    const off = window.cth.onMailProposalsUpdated(load);
    return () => { alive = false; off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return list;
}

/**
 * What a Send only member sent from that address lately (shared-mailboxes.md,
 * O1b): the owner can see who wrote as the address, since only its own sends
 * are kept and none reach the office log.
 */
function RecentSends({ agentId, mailbox }: { agentId: string; mailbox: string }) {
  const { t, i18n } = useTranslation();
  const list = useMailList(() => window.cth.mailRecentSends(agentId, mailbox), [agentId, mailbox]);
  if (!list.length) return null;
  return (
    <>
      <div style={h13}>{t('capabilities.recentSends')}</div>
      {list.map((r, i) => (
        <div key={`${r.sentAt}-${i}`} style={{ ...hint, padding: '2px 0', overflowWrap: 'anywhere' }}>
          {t('capabilities.recentSend', { subject: `\u2068${r.subject}\u2069`, to: `\u2068${r.to}\u2069`, date: new Date(r.sentAt).toLocaleDateString(i18n.language) })}
        </div>
      ))}
    </>
  );
}

/**
 * Kinds of email this agent may send without asking (standing approvals,
 * send-on-approval.md): granted by ticking the agent's offer on an approval
 * card, each revocable here. The latest sends under each show beneath it.
 */
function StandingApprovals({ agentId, mailbox }: { agentId: string; mailbox: string }) {
  const { t } = useTranslation();
  const list = useMailList<StandingApproval>(() => window.cth.listMailStanding(agentId), [agentId]);
  // One block per mailbox: its own, and the one it sends only from (3c).
  const here = list.filter((r) => r.mailbox === mailbox);
  if (!here.length) return null;
  return (
    <>
      <div style={h13}>{t('capabilities.standingTitle')}</div>
      {here.map((r) => {
        const last = r.sends?.[r.sends.length - 1];
        return (
          <div key={r.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '4px 0' }}>
            <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--cth-ink)', overflowWrap: 'anywhere' }}>
              {/* The kind is the agent's own words: its direction is its own; the line under it keeps the app's. */}
              <span dir="auto">{r.kind}</span>
              {last && <div style={{ ...hint, marginTop: 2 }}>{t('capabilities.standingLast', { count: r.sends?.length ?? 0, subject: `\u2068${last.subject}\u2069` })}</div>}
            </div>
            <MiniButton onClick={() => { void window.cth.revokeMailStanding(r.id); }}>{t('capabilities.standingRevoke')}</MiniButton>
          </div>
        );
      })}
    </>
  );
}
