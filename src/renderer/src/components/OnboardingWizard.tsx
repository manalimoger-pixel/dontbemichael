import { CompanyProfileFields, localCurrency, localTimeZone } from './CompanyProfileFields';
import { cityLine, cleanCompanyProfile, missingProfileFields, prefillLegalName, type CompanyProfile, type RequiredProfileField } from '@shared/companyProfile';
import { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { OnboardingStudio } from '@/scene/studio/OnboardingStudio';
import { PersonAvatar } from '@/scene/office/props';
import lockupLight from '@brandkit/logo/lockup/dbm-lockup-horizontal-light.svg?url';
import lockupDark from '@brandkit/logo/lockup/dbm-lockup-horizontal-dark.svg?url';
import { PixelButton } from './PixelButton';
import { Icon, type IconName } from './Icon';
import { InfoTip } from './InfoTip';
import { SpritePortrait } from './SpritePortrait';
import { ProviderLogo } from './ProviderLogo';
import { modelsForProvider, onboardingEngineChoices, teamDefaultsFromMichael, type AgentProvider, type HarnessConfig } from '@/store/config';
import { isClaudeProvider, providerPreset } from '@shared/agentProvider';
import { GetMichaelReady, GetMichaelReadyInfo } from './GetMichaelReady';
import {
  classifyEngineAvailability, engineAvailabilityBadge, engineAvailabilityMessage, engineBlocksOnboarding
} from '@shared/engineAvailability';
import type { ToolStatus } from '@shared/toolCatalog';
import type { OfficePack } from '@shared/officePack';
import type { AgentDefinitionV2 } from '@shared/agentDefinition';
import {
  OFFICE_KEY, folderNames, initialPicks, folderFor, michaelFolderFor, connectionsNeeded, teamPlan,
  type FolderSuggestions
} from '@shared/teamPlan';
import { missingBusinessFields, type BusinessField } from '@shared/businessProfile';
import { useResolvedGodName } from '@/hooks/useResolvedGodName';
import { teamPlanFromRecord, type OfficeRecord } from '@shared/officeRecord';
import { COLLECT_USAGE_STATS } from '@shared/buildFeatures';

export interface OnboardingWizardProps {
  onComplete: (config: HarnessConfig) => void;
  /** Open on a later step with the first answers filled in. Only for the
   *  reference screens (tools/studio-lab/reference.tsx); the app never sets it. */
  preview?: { step: 'business' | 'welcome' | 'team' | 'ready'; businessType: string; businessName: string };
}

type Step = 'resume' | 'business' | 'details' | 'team' | 'welcome' | 'home' | 'orchestrator' | 'permissions' | 'ready' | 'done';

/** The "no pack fits" tile. Not an error path: Michael asks a few questions and
 *  builds from the core pack, so the grid always resolves to something. */
const OTHER_BUSINESS = '__other__';

/** Pack `glyph` names → the emoji we draw in the tile. Pack glyphs are data, not
 *  icons (DESIGN.md 10.3), so an unrecognised one falls back rather than breaking. */
const GLYPH_EMOJI: Record<string, string> = {
  bowl: '🍜',
  bag: '🛍',
  clipboard: '📋',
  laptop: '💻',
  scissors: '✂',
  wrench: '🔧',
  sparkles: '✨'
};
const glyphFor = (glyph?: string): string =>
  (glyph && (GLYPH_EMOJI[glyph] ?? (/\p{Extended_Pictographic}/u.test(glyph) ? glyph : undefined))) ?? '?';

// First-run showcase — the highest-value features a brand-new owner should grasp
// before any setup.
interface Feature {
  icon: IconName;
  labelKey: string;
  descKey: string;
}
const FEATURES: Feature[] = [
  {
    icon: 'sparkle',
    labelKey: 'onboarding.welcome.features.team.label',
    descKey: 'onboarding.welcome.features.team.desc'
  },
  {
    icon: 'gear',
    labelKey: 'onboarding.welcome.features.manager.label',
    descKey: 'onboarding.welcome.features.manager.desc'
  },
  {
    icon: 'ledger',
    labelKey: 'onboarding.welcome.features.memory.label',
    descKey: 'onboarding.welcome.features.memory.desc'
  },
  {
    icon: 'expand',
    labelKey: 'onboarding.welcome.features.commandCenter.label',
    descKey: 'onboarding.welcome.features.commandCenter.desc'
  },
  {
    icon: 'check',
    labelKey: 'onboarding.welcome.features.guardrails.label',
    descKey: 'onboarding.welcome.features.guardrails.desc'
  },
  {
    icon: 'plus',
    labelKey: 'onboarding.welcome.features.hires.label',
    descKey: 'onboarding.welcome.features.hires.desc'
  }
];

/** Anthropic's plan comparison, linked from the manager step's Max plan note. */
const CLAUDE_PLANS_URL = 'https://claude.com/pricing';

// One-liner of what each engine is, shown under its row on the orchestrator step.
const PROVIDER_BLURB_KEYS: Partial<Record<AgentProvider, string>> = {
  gemini: 'onboarding.providerBlurb.gemini',
  claude: 'onboarding.providerBlurb.claude',
  codex: 'onboarding.providerBlurb.codex',
  antigravity: 'onboarding.providerBlurb.antigravity',
  qwen: 'onboarding.providerBlurb.qwen',
  cursor: 'onboarding.providerBlurb.cursor'
};

export function OnboardingWizard({ onComplete, preview }: OnboardingWizardProps) {
  const { t } = useTranslation();
  // Onboarding runs before god exists in the store, so read the persisted name.
  const godName = useResolvedGodName();
  const [step, setStep] = useState<Step>(preview?.step ?? 'business');

  // WHAT BUSINESS THIS IS — the first and most consequential question, because it
  // decides the suggested cast, the office hours, and every agent's starting tool
  // levels. It replaced "are you technical or non-technical?": that question asked
  // the owner to classify themselves before the app had earned anything, and it
  // forked every subsequent string into two registers. There is one register now,
  // and it is the plain one.
  const [businessType, setBusinessType] = useState<string | undefined>(preview?.businessType);
  const [businessName, setBusinessName] = useState(preview?.businessName ?? '');
  // The company profile (src/shared/companyProfile.ts): the essentials on step
  // 1, everything else optional on step 2. Time zone and currency start from
  // the Mac's own settings.
  const [profile, setProfile] = useState<CompanyProfile>(() => ({ timeZone: localTimeZone(), currency: localCurrency() }));
  // Step 2's legal name starts as the step 1 business name, and follows a
  // rename on step 1 until the owner types a legal name of their own.
  const legalNameFilled = useRef<string | undefined>(undefined);
  // A settings file that could not be read is why setup starts again: say so,
  // and where its copy is kept (issue 98).
  const [damagedCopy, setDamagedCopy] = useState<string | null>(null);
  useEffect(() => {
    if (preview) return;
    let alive = true;
    void window.cth.damagedConfigCopy?.().then((p) => { if (alive) setDamagedCopy(p); }).catch(() => {});
    return () => { alive = false; };
  }, [preview]);
  useEffect(() => {
    if (step !== 'details') return;
    const next = prefillLegalName(profile, businessName, legalNameFilled.current);
    legalNameFilled.current = next.filled;
    if (next.profile !== profile) setProfile(next.profile);
    // Only on arriving at step 2: re-running on every keystroke would refill a
    // field the owner just cleared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);
  // The city line older parts of the app still read (businessCity).
  const businessCity = cityLine(profile.address) ?? '';
  // Name, type, CEO and the headquarters address are required (businessProfile.ts,
  // companyProfile.ts). Gaps are only SHOWN after the owner has tried to
  // continue: flagging empty fields the moment the screen opens reads as
  // scolding before they've typed anything. After that the message is live,
  // shrinking as each field is filled in.
  const [triedBusiness, setTriedBusiness] = useState(false);
  const profileGaps = missingProfileFields(cleanCompanyProfile(profile), businessType === OTHER_BUSINESS);
  const businessGaps = [
    ...missingBusinessFields({ name: businessName, location: businessCity || '-', type: businessType }),
    ...profileGaps
  ];
  const gapShown = (field: BusinessField) => triedBusiness && businessGaps.includes(field);
  const gapMessage: Record<BusinessField | RequiredProfileField, string> = {
    name: t('onboarding.business.errName'),
    location: t('onboarding.business.errLocation'),
    type: t('onboarding.business.errType'),
    ceo: t('companyProfile.missing.ceo'),
    street: t('companyProfile.missing.street'),
    city: t('companyProfile.missing.city'),
    country: t('companyProfile.missing.country'),
    industry: t('companyProfile.missing.industry')
  };

  // The bundled Office Packs, each already merged with core. `undefined` = not
  // back yet; `problems` names any pack that could not be read. A pack that fails
  // to load is reported beside the grid, never allowed to empty it.
  const [packs, setPacks] = useState<OfficePack[] | undefined>();
  const [packProblems, setPackProblems] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await window.cth.packsList();
        if (cancelled) return;
        setPacks(res.packs.map((p) => p.pack));
        setCorePack(res.core);
        setPackProblems(res.problems.length);
      } catch {
        if (!cancelled) { setPacks([]); setPackProblems(1); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ─── Your team (Decisions 44, 47) ─────────────────────────────────────────
  // The picked business's suggested cast, each agent with the folder it will work
  // in. "Something else" starts from the core pack alone. The rules live in
  // shared/teamPlan.ts; this is just the state they read.
  const [corePack, setCorePack] = useState<OfficePack | undefined>();
  const teamPack: OfficePack | undefined =
    businessType === OTHER_BUSINESS ? corePack : packs?.find((p) => p.businessType === businessType);
  const teamAgents = teamPack?.agents ?? [];
  const coreIds = new Set((corePack?.agents ?? []).map((a) => a.id));
  const [teamPicked, setTeamPicked] = useState<Record<string, boolean>>({});
  /** Folders the owner pointed somewhere other than the suggestion, keyed by agent id (or OFFICE_KEY). */
  const [folderOverrides, setFolderOverrides] = useState<Record<string, string>>({});
  const [folderSuggestions, setFolderSuggestions] = useState<(FolderSuggestions & { home: string }) | undefined>();

  // A different business is a different cast: start over from its suggested picks.
  useEffect(() => {
    setTeamPicked(teamPack ? initialPicks(teamPack) : {});
    setFolderOverrides({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamPack?.businessType]);

  // Where each folder goes by default, which depends on the business name, or on
  // the folder the owner picked for Michael: the Office and the team's folders
  // sit inside his. Asked only while the team step is showing; nothing is
  // created until finish.
  const teamFolderKey = folderNames(teamAgents).join('|');
  const pickedMichaelFolder = folderOverrides[OFFICE_KEY];
  useEffect(() => {
    if (step !== 'team' || !teamPack) return;
    let cancelled = false;
    window.cth.foldersSuggest(businessName, folderNames(teamAgents), pickedMichaelFolder)
      .then((sug) => {
        if (cancelled) return;
        if (sug.rootRefused) {
          // The home folder or a system folder can't hold an office: say so and
          // go back to the suggested one.
          setError(t('onboarding.team.errMichaelFolder'));
          setFolderOverrides((o) => { const n = { ...o }; delete n[OFFICE_KEY]; return n; });
        }
        setFolderSuggestions(sug);
      })
      .catch(() => { if (!cancelled) setFolderSuggestions(undefined); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, businessName, teamFolderKey, pickedMichaelFolder]);

  const plan = teamPlan(teamAgents, teamPicked, folderSuggestions, folderOverrides);
  const needed = connectionsNeeded(teamAgents, teamPicked);
  const pickedCount = teamAgents.filter((a) => teamPicked[a.id]).length;
  /** `/Users/me/Documents/Pho` → `~/Documents/Pho`: shorter, and what an owner recognises. */
  const tildePath = (p: string) => {
    const h = folderSuggestions?.home;
    return h && (p === h || p.startsWith(h + '/')) ? '~' + p.slice(h.length) : p;
  };
  const chooseTeamFolder = async (key: string) => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (!res.ok) { if (res.error !== 'cancelled') setError(res.error); return; }
    // Michael's folder is private to him, so it can't be a team member's own
    // folder (src/shared/folderAccess.ts).
    const same = (a?: string) => !!a && a.replace(/[\\/]+$/, '').toLowerCase() === res.path.replace(/[\\/]+$/, '').toLowerCase();
    if (key !== OFFICE_KEY && same(michaelFolderFor(folderSuggestions, folderOverrides))) {
      setError(t('addAgent.errFolderShared'));
      return;
    }
    setFolderOverrides((o) => ({ ...o, [key]: res.path }));
  };
  const resetTeamFolder = (key: string) =>
    setFolderOverrides((o) => { const n = { ...o }; delete n[key]; return n; });
  const connLabel: Record<string, string> = {
    email: t('onboarding.team.conn.email'),
    quickbooks: t('onboarding.team.conn.quickbooks'),
    'google-business': t('onboarding.team.conn.google-business'),
    meta: t('onboarding.team.conn.meta'),
    calendar: t('onboarding.team.conn.calendar'),
    shopify: t('onboarding.team.conn.shopify'),
    website: t('onboarding.team.conn.website'),
    mailchimp: t('onboarding.team.conn.mailchimp'),
    crm: t('onboarding.team.conn.crm'),
    github: t('onboarding.team.conn.github')
  };
  const agentChips = (a: AgentDefinitionV2): TeamChip[] => {
    const chips: TeamChip[] = [];
    if (businessType !== OTHER_BUSINESS && coreIds.has(a.id)) chips.push({ tone: 'core', label: t('onboarding.team.inEveryPack') });
    for (const c of a.connections) {
      const what = connLabel[c.id] ?? c.id;
      chips.push(c.required
        ? { tone: 'need', label: t('onboarding.team.needs', { what }) }
        : { tone: 'optional', label: t('onboarding.team.optional', { what }) });
    }
    if (a.connections.length === 0) chips.push({ tone: 'ok', label: t('onboarding.team.nothingToConnect') });
    return chips;
  };
  const folderLabels = {
    worksIn: t('onboarding.team.worksIn'),
    change: t('onboarding.team.change'),
    useSuggested: t('onboarding.team.useSuggested')
  };

  const [home, setHome] = useState<string>('');
  const [autoMode, setAutoMode] = useState<boolean>(true);
  // Anonymous usage stats (TELEMETRY.md). Shown and saved only while
  // COLLECT_USAGE_STATS (buildFeatures.ts) is on; off in this build.
  const [shareStats, setShareStats] = useState<boolean>(true);
  const [godProvider, setGodProvider] = useState<AgentProvider>('claude');
  const [godModel, setGodModel] = useState<string | undefined>(
    providerPreset('claude').recommendedOrchestratorModel
  );
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  // Which engine CLIs are actually on this machine. The picker used to record the
  // choice blind; the first check happened when Michael spawned, and for a
  // provider with no installer that meant a first run where nothing ever booted.
  // `undefined` = probe not back yet (or failed): rows show no badge and nothing
  // is blocked, because a broken probe must not lock a new user out.
  const [engines, setEngines] = useState<ToolStatus[] | undefined>();
  const [probing, setProbing] = useState(false);
  const probeEngines = async () => {
    setProbing(true);
    try { setEngines(await window.cth.toolsStatus()); }
    catch { /* leave undefined: unknown, never blocking */ }
    finally { setProbing(false); }
  };
  useEffect(() => { void probeEngines(); }, []);
  const selectedEngine = classifyEngineAvailability(engines, godProvider);
  const engineBlocked = engineBlocksOnboarding(selectedEngine);
  // Get Michael ready (docs/designs/get-michael-ready.md): with Claude, setup
  // ends on a Ready step that installs it and signs the owner in, where they
  // can see it. Open the office waits for it; Set up later does not.
  const withReady = isClaudeProvider(godProvider);
  const lastStep: Step = withReady ? 'ready' : 'permissions';
  const [engineReady, setEngineReady] = useState(false);

  // Permissions & reliability toggles. These apply IMMEDIATELY on change (their
  // own IPC / OS state) — they are NOT part of finish()'s config write. First-run
  // defaults: notifications off (config default), login-item off (fresh install);
  // each reconciles to the real state the IPC returns.
  const [strongKeepalive, setStrongKeepalive] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [openAtLogin, setOpenAtLogin] = useState(false);

  const toggleStrongKeepalive = async (v: boolean) => {
    setStrongKeepalive(v); // optimistic
    try { setStrongKeepalive((await window.cth.updateConfig({ strongKeepalive: v })).strongKeepalive === true); }
    catch { setStrongKeepalive(!v); }
  };
  const toggleNotifications = async (v: boolean) => {
    setNotifications(v); // optimistic
    try { await window.cth.setNotifications(v); }
    catch { setNotifications(!v); } // revert on failure
  };
  const toggleOpenAtLogin = async (v: boolean) => {
    setOpenAtLogin(v); // optimistic
    try { setOpenAtLogin(await window.cth.setLoginItem(v)); } // reconcile to OS truth
    catch { setOpenAtLogin(!v); }
  };
  const openSettings = (url: string) => { void window.cth.openExternal(url); };

  // Power-settings deep-link differs per OS (macOS/Windows have one, Linux
  // doesn't have a universal settings URI across desktop environments) —
  // drive the copy and the button off the actual platform instead of
  // hardcoding one OS's instructions.
  const platform = window.cth.platform;
  const stayAwakeOs: 'mac' | 'windows' | 'linux' =
    platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'linux';
  const stayAwakeUrl =
    stayAwakeOs === 'mac' ? 'x-apple.systempreferences:com.apple.preference.battery' :
    stayAwakeOs === 'windows' ? 'ms-settings:powersleep' :
    null;

  // Default-suggest a sensible harness home on first render.
  //
  // This used to read `window.process.env.HOME`, which is ALWAYS undefined here:
  // the window runs with `contextIsolation: true` / `nodeIntegration: false` and
  // the preload bridges exactly one object (`cth`), so the renderer's main world
  // has no `process`. The suggestion therefore always collapsed to '' and the
  // field rendered empty — leaving the copy above promising a default the user
  // could not accept, and Finish failing with "Pick a harness home folder first."
  //
  // Suggest the literal `~/HarnessAgents` instead. That is exactly the string
  // #140's normalizeHiveHome()/expandTilde() were built to absorb: it is expanded
  // at the config-write boundary AND at ensureHarnessHome's mkdir, so every
  // downstream reader still sees one absolute path. No new IPC surface.
  useEffect(() => {
    if (!home) setHome(DEFAULT_HOME);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // An office already in the suggested home folder (a reinstall, or a new data
  // folder): offer to continue it exactly as it is, by folder. Continuing never
  // depends on the business name typed this time (officeRecord.ts).
  const [found, setFound] = useState<{ path: string; record: OfficeRecord } | null>(null);
  const [resuming, setResuming] = useState(false);
  const foundPlan = found ? teamPlanFromRecord(found.record) : null;
  useEffect(() => {
    let alive = true;
    void window.cth.officeFind(DEFAULT_HOME)
      .then((f) => {
        // Offer it only when it can really be continued: a team, and folders
        // for all of it (an older office whose folders share nothing would
        // otherwise fail at Finish with no way forward).
        if (!alive || !f.hasOffice || !f.path || !f.record || !teamPlanFromRecord(f.record).ok) return;
        setFound({ path: f.path, record: f.record });
        // Only take over the first screen if the owner has not started on it yet.
        setStep((s) => (s === 'business' ? 'resume' : s));
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);
  const continueOffice = () => {
    if (!found) return;
    const r = found.record;
    setBusinessName(r.businessName ?? '');
    setProfile((p) => ({ ...p, ...(r.companyProfile ?? {}) }));
    if (r.businessType) setBusinessType(r.businessType);
    setHome(found.path);
    setResuming(true);
    setError(undefined);
    setStep('orchestrator');
  };
  const startNewOffice = async () => {
    // A new office needs its own folder: setting it up in this one would mix a
    // second team into the office that is already there. Suggest the first
    // free "~/HarnessAgents N"; if none is free (or the check fails), leave the
    // field empty so the home step asks the owner to pick one.
    setBusy(true);
    let free = '';
    for (let n = 2; n <= NEW_OFFICE_SUGGESTIONS; n++) {
      const candidate = `${DEFAULT_HOME} ${n}`;
      const st = await window.cth.homeStatus(candidate).catch(() => null);
      if (!st) break;
      if (!st.exists) { free = candidate; break; }
    }
    setHome(free);
    setResuming(false);
    setError(undefined);
    setBusy(false);
    setStep('business');
  };

  const pickHome = async () => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok) setHome(res.path);
    else if (res.error !== 'cancelled') setError(res.error);
  };


  const finish = async () => {
    setBusy(true);
    setError(undefined);
    // Continuing an office keeps its recorded team and folders; a new office
    // uses the team and folders picked in setup.
    const finishPlan = resuming && foundPlan ? foundPlan : plan;
    // The team's folders must be resolvable before anything is created.
    if (!finishPlan.ok) { setError(t('onboarding.team.errNoFolders')); setBusy(false); setStep('team'); return; }
    const harnessHome = home.trim(); // whitespace-only is not a folder
    if (!harnessHome) { setError(t('onboarding.errPickHome')); setBusy(false); setStep('home'); return; }
    // The orchestrator step already refuses to advance on this, but a late probe
    // result can change the answer after the user has moved on. Never write a
    // godProvider that is known to be unable to boot.
    if (engineBlocked) {
      setError(t('onboarding.errEngineNotInstalled', { label: providerPreset(godProvider).label }));
      setBusy(false); setStep('orchestrator'); return;
    }
    // Every await below can reject (IPC down, disk error). Without a catch the
    // button stayed on "Saving" forever with nothing on screen.
    try {
      const ensure = await window.cth.ensureHarnessHome(harnessHome);
      if (!ensure.ok) {
        // Plain words for the owner (EACCES and the like mean nothing to them;
        // the reading-file reasons in plainReason.ts do not fit a folder that
        // could not be made). The raw reason goes to the log.
        if (ensure.error) console.error('[onboarding] could not create the home folder:', ensure.error);
        setError(t('onboarding.errCreateHome'));
        setBusy(false);
        return;
      }
      // Make Michael's folder and each agent's. Only missing folders are
      // created; one the owner picked (or already had) is left exactly as it is.
      const made = await window.cth.foldersEnsure(finishPlan.folders);
      const failed = made.find((r): r is { ok: false; path: string; reason: string } => !r.ok);
      if (failed) {
        setError(t('onboarding.team.errFolder', { path: tildePath(failed.path), reason: failed.reason }));
        setBusy(false); setStep('team'); return;
      }
      // Michael's engine and model become the team's default too: the starter
      // team and later hires start on what the owner picked here.
      const config = await window.cth.getConfig();
      const next = await window.cth.updateConfig({
        onboardingComplete: true,
        // The pack drives the starter cast. '__other__' is recorded as unset: no
        // pack applies, so Michael asks rather than silently picking one.
        businessType: businessType === OTHER_BUSINESS ? undefined : businessType,
        businessName: businessName.trim() || undefined,
        businessCity: businessCity.trim() || undefined,
        companyProfile: cleanCompanyProfile(profile),
        harnessHome, // the same trimmed value we just mkdir'd, not the raw field
        // Where the office works (Decision 44). The running office starts each
        // agent inside its folder; the folders also become the hire dialog's
        // quick-picks, which is what registeredRepos has always fed.
        businessFolder: finishPlan.business,
        businessTeam: finishPlan.team,
        registeredRepos: finishPlan.folders,
        autoMode,
        godProvider,
        godModel,
        ...teamDefaultsFromMichael(config, godProvider, godModel),
        // Only written when the choice was shown (buildFeatures.ts).
        ...(COLLECT_USAGE_STATS ? { telemetryEnabled: shareStats } : {})
      });
      setBusy(false);
      onComplete(next);
    } catch (e) {
      // Plain words for the owner; the raw IPC error is for the log.
      console.error('[onboarding] finish failed:', e);
      setError(t('onboarding.errSaveSetup'));
      setBusy(false);
    }
  };

  // Design v2 onboarding (branding/DESIGN.md 7.25): a full window with the
  // lockup and the step indicator on top, the step's card on the left, and the
  // studio on the right filling with the team as it is picked.
  const steps: readonly Step[] = withReady ? ORDERED_STEPS : ORDERED_STEPS.filter((s) => s !== 'ready');
  const stepIndex = steps.indexOf(step);
  const stepTitle = t(`onboarding.stepTitle.${step}`, { godName });
  const studioPicked = step === 'team' ? teamAgents.filter((a) => teamPicked[a.id]) : teamAgents.filter((a) => teamPicked[a.id] ?? true);
  const studioUnpicked = step === 'team' ? teamAgents.filter((a) => !teamPicked[a.id]) : [];
  const toSeat = (a: AgentDefinitionV2) => ({ id: a.id, character: a.character, description: a.role });
  // The card is centered whenever the studio isn't showing (Business, Details,
  // Resume, or no team yet) and sits in its column when it is; the move and the
  // glow follow this one flag (docs/designs/onboarding-centered.md).
  const hasStudio = (step === 'team' || step === 'welcome' || step === 'home' || step === 'orchestrator' || step === 'permissions' || step === 'ready') && teamAgents.length > 0;
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200, overflowY: 'auto',
      background: 'var(--cth-bg)',
      display: 'flex', flexDirection: 'column'
    }}>
      <div className={`cth-onb-glow${hasStudio ? ' is-studio' : ''}`} aria-hidden />
      <div className="cth-titlebar-drag" style={{
        flexShrink: 0, height: 72, display: 'flex', alignItems: 'center', gap: 20,
        paddingInlineStart: 88, paddingInlineEnd: 28
      }}>
        <img className="cth-lockup-light" src={lockupLight} alt="Don't Be Michael" style={{ height: 24, width: 'auto' }} />
        <img className="cth-lockup-dark" src={lockupDark} alt="Don't Be Michael" style={{ height: 24, width: 'auto' }} />
        {stepIndex >= 0 && <StepIndicator steps={steps} current={stepIndex} />}
        {stepIndex >= 0 && (
          <span style={{ marginInlineStart: 'auto', fontSize: 12, color: 'var(--cth-ink-3)' }}>
            {t('onboarding.stepOf', { n: stepIndex + 1, total: steps.length })}
          </span>
        )}
      </div>
      {/* `margin: auto` centers while the card fits and falls back to a normal
          scroll once it doesn't (a centered flex item that overflows is clipped
          at the top and cannot be scrolled to). */}
      {/* Three tracks: equal side tracks center the card; with the studio the
          start track closes and the end track holds it. The fr values animate. */}
      <div className="cth-onb-body" style={{
        flex: 1, display: 'grid', columnGap: 0, padding: '8px 28px 28px', width: '100%', maxWidth: 1440, margin: '0 auto', boxSizing: 'border-box',
        gridTemplateColumns: hasStudio ? 'minmax(0, 0fr) minmax(0, 560px) minmax(0, 1fr)' : 'minmax(0, 1fr) minmax(0, 560px) minmax(0, 1fr)'
      }}>
        <div style={{ gridColumn: 2, gridRow: 1, minWidth: 0, margin: step === 'team' ? '0' : 'auto 0' }}>
          <div role="region" aria-label={stepTitle} style={{
            background: 'var(--cth-card)', borderRadius: 'var(--cth-r-2xl)',
            // clip, not hidden: hidden would make the card a scroll box and
            // stop the footer sticking to the window.
            boxShadow: 'inset 0 0 0 1px var(--cth-line), var(--cth-shadow-lg)', overflow: 'clip'
          }}>
          <div style={{ padding: '22px 22px 4px' }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.03em', color: 'var(--cth-ink)', display: 'flex', alignItems: 'center', gap: 8 }}>
              {stepTitle}
              {step === 'ready' && <GetMichaelReadyInfo />}
            </h1>
          </div>
          <div style={{ padding: '14px 22px 22px', display: 'flex', flexDirection: 'column', gap: 16 }}>

            {damagedCopy && (step === 'business' || step === 'resume') && (
              <div role="status" data-damaged-config style={{
                borderRadius: 'var(--cth-r-md)', padding: '8px 10px',
                background: 'var(--cth-amber-soft)', color: 'var(--cth-amber-text)',
                fontSize: 13, lineHeight: '19px'
              }}>
                {t('onboarding.damagedConfig')}{' '}
                <span dir="ltr" style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 12, wordBreak: 'break-all' }}>{damagedCopy}</span>
              </div>
            )}

            {step === 'resume' && found && (
              <>
                <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--cth-ink-2)' }}>
                  {t('onboarding.resume.headline')}
                </div>
                <p style={{ margin: 0, lineHeight: '22px' }}>
                  {t('onboarding.resume.desc', {
                    business: found.record.businessName ?? t('onboarding.resume.unnamed'),
                    count: found.record.team.length,
                    // Isolated so a path reads left to right inside Arabic text.
                    folder: `\u2066${tildePath(found.path)}\u2069`
                  })}
                </p>
                {/* Where the team will keep working: shown before Continue so the
                    owner can see exactly which folders this office uses. */}
                <div style={{ fontSize: 14, lineHeight: '18px', color: 'var(--cth-ink-700)' }}>
                  <div style={{ marginBottom: 4 }}>{t('onboarding.resume.foldersHead')}</div>
                  <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                    {foundPlan?.ok && foundPlan.folders.map((f) => (
                      <li key={f} dir="ltr" style={{ textAlign: 'start' }}>{tildePath(f)}</li>
                    ))}
                  </ul>
                </div>
                <div style={{ fontSize: 14, lineHeight: '18px', color: 'var(--cth-ink-500)' }}>
                  {t('onboarding.resume.newNote')}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <PixelButton variant="primary" size="md" onClick={continueOffice} disabled={busy}>
                    {t('onboarding.resume.continue')}
                  </PixelButton>
                  <PixelButton variant="secondary" size="md" onClick={() => { void startNewOffice(); }} disabled={busy}>
                    {t('onboarding.resume.startNew')}
                  </PixelButton>
                </div>
              </>
            )}

            {step === 'business' && (
              <>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{
                    borderRadius: 'var(--cth-r-md)',
                    width: 56, height: 56, flexShrink: 0,
                    background: 'var(--cth-sky-light)',
                    boxShadow: 'inset 0 0 0 1.5px var(--cth-indigo)',
                    display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden'
                  }}>
                    <SpritePortrait character="michael" scale={2} />
                  </div>
                  <div>
                    <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 14, lineHeight: '20px' }}>
                      {t('onboarding.business.headline', { godName })}
                    </div>
                    <div style={{ fontSize: 14, color: 'var(--cth-ink-700)', lineHeight: '20px' }}>
                      {t('onboarding.business.body')}
                    </div>
                  </div>
                </div>

                {/* Name and location are required: agents write as this business, so
                    they need to know what it's called and where it is. Neither is
                    ever used as an id or a path. */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10 }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 14, color: 'var(--cth-ink-700)' }}>
                      {t('onboarding.business.nameLabel')} *
                    </span>
                    <input
                      value={businessName}
                      onChange={(e) => setBusinessName(e.target.value)}
                      placeholder={t('onboarding.business.namePlaceholder')}
                      aria-required
                      aria-invalid={gapShown('name')}
                      className="cth-input"
                      style={inputStyle}
                    />
                  </label>

                </div>

                <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 14, fontWeight: 600, color: 'var(--cth-ink-2)' }}>
                  {t('onboarding.business.ask')} *
                </div>

                {/* Tiles come from the pack registry, so a community pack appears
                    here without a code change. Titles/taglines are pack data and
                    are NOT translated (DESIGN.md 7.11). */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8 }}>
                  {packs?.map((p) => (
                    <PackTile
                      key={p.businessType}
                      glyph={glyphFor(p.glyph)}
                      title={p.displayName}
                      subtitle={p.tagline}
                      selected={businessType === p.businessType}
                      missing={gapShown('type')}
                      onClick={() => { setBusinessType(p.businessType); setError(undefined); }}
                    />
                  ))}
                  {/* Always last, always present: the grid must never dead-end. */}
                  <PackTile
                    glyph="?"
                    title={t('onboarding.business.otherTitle')}
                    subtitle={t('onboarding.business.otherDesc', { godName })}
                    selected={businessType === OTHER_BUSINESS}
                    missing={gapShown('type')}
                    onClick={() => { setBusinessType(OTHER_BUSINESS); setError(undefined); }}
                  />
                </div>

                {packProblems > 0 && (
                  <div style={{ fontSize: 14, color: 'var(--cth-ink-500)' }}>
                    {t('onboarding.business.packsProblem')}
                  </div>
                )}

                {/* The rest of the essentials: every agent works from these
                    (companyProfile.ts). The industry line appears only when no
                    business type fits. */}
                <CompanyProfileFields
                  value={profile}
                  onChange={setProfile}
                  parts={['essentials']}
                  needsIndustry={businessType === OTHER_BUSINESS}
                  missing={triedBusiness ? profileGaps : []}
                />

                {triedBusiness && businessGaps.length > 0 && (
                  <div role="alert" style={{
                    borderRadius: 'var(--cth-r-md)',
                    padding: '6px 10px',
                    background: 'var(--cth-coral-light)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
                    fontSize: 14, color: 'var(--cth-ink-900)'
                  }}>
                    {businessGaps.map((g) => gapMessage[g]).join(' ')}
                  </div>
                )}
              </>
            )}

            {step === 'details' && (
              <>
                <div style={{ fontSize: 14, color: 'var(--cth-ink-700)', lineHeight: '19px' }}>
                  {t('onboarding.details.intro', { godName })}
                </div>
                <CompanyProfileFields value={profile} onChange={setProfile} parts={['details', 'hint']} />
              </>
            )}

            {step === 'welcome' && (
              <>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <div style={{
                    borderRadius: 'var(--cth-r-md)',
                    width: 56, height: 56, flexShrink: 0,
                    background: 'var(--cth-sky-light)',
                    boxShadow: 'inset 0 0 0 1.5px var(--cth-indigo)',
                    display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden'
                  }}>
                    <SpritePortrait character="michael" scale={2} />
                  </div>
                  <div>
                    <div style={{
                      fontFamily: 'var(--cth-font-display)',
                      fontSize: 14, lineHeight: '18px'
                    }}>{t('onboarding.welcome.headline')}</div>
                    <div style={{ fontSize: 14, color: 'var(--cth-ink-700)', lineHeight: '18px' }}>
                      {t('onboarding.welcome.desc')}
                    </div>
                  </div>
                </div>

                {/* What the office does, one quiet row each with its explanation
                    behind an info icon (review, 2026-10-01: a grid of tinted
                    tiles, one in coral, with six paragraphs). */}
                <div style={{ display: 'flex', flexDirection: 'column', borderRadius: 'var(--cth-r-lg)', boxShadow: 'inset 0 0 0 1px var(--cth-line)' }}>
                  {FEATURES.map((f, i) => (
                    <div key={f.labelKey} style={{
                      display: 'flex', gap: 10, alignItems: 'center', padding: '9px 12px',
                      borderTop: i ? '1px solid var(--cth-line)' : undefined
                    }}>
                      <span style={{ width: 26, height: 26, flexShrink: 0, display: 'grid', placeItems: 'center', borderRadius: 'var(--cth-r-md)', background: 'var(--cth-neutral-soft)', color: 'var(--cth-ink-2)' }}>
                        <Icon name={f.icon} />
                      </span>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: 'var(--cth-ink)' }}>{t(f.labelKey, { godName })}</span>
                      <InfoTip text={t(f.descKey)} align="end" />
                    </div>
                  ))}
                </div>
              </>
            )}

            {step === 'home' && (
              <>
                <p style={{ margin: 0, lineHeight: '22px' }}>
                  {t('onboarding.home.desc')}
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={home}
                    onChange={(e) => setHome(e.target.value)}
                    placeholder={t('onboarding.home.placeholder')}
                    className="cth-input"
                    // A folder path: mono, as DESIGN.md 4.1 sets for paths.
                    style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)', fontSize: 12.5 }}
                  />
                  <PixelButton variant="secondary" size="md" onClick={pickHome}>
                    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                      <Icon name="folder" /> {t('onboarding.home.createPick')}
                    </span>
                  </PixelButton>
                </div>
                <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                  {t('onboarding.home.note')}
                </div>

                {/* This folder holds the app's live machinery, and cloud sync breaks
                    all of it: the hive is a git repo committed thousands of times,
                    agents' permission hooks connect through a Unix socket here
                    (hooks.sock), and team memory is a SQLite database (palace/).
                    Sync clients fight git's lock files, cannot carry a socket, and
                    corrupt a database copied mid-write. Warned about up front
                    because an owner's instinct is to keep business things in
                    Dropbox or Drive, and the damage shows up much later. */}
                <div role="note" style={{
                  borderRadius: 'var(--cth-r-md)',
                  display: 'flex', gap: 10, alignItems: 'flex-start', padding: 10,
                  background: 'var(--cth-lemon-light)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-line-2)'
                }}>
                  <span style={{
                    borderRadius: 'var(--cth-r-md)',
                    width: 28, height: 28, flexShrink: 0, display: 'flex',
                    alignItems: 'center', justifyContent: 'center',
                    background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-line-2)'
                  }}>
                    <Icon name="info" />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600, lineHeight: '16px', marginBottom: 3 }}>
                      {t('onboarding.home.syncWarningTitle')}
                    </div>
                    <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
                      {t('onboarding.home.syncWarning')}
                    </div>
                  </div>
                </div>
              </>
            )}

            {step === 'orchestrator' && (
              <>
                <p style={{ margin: 0, lineHeight: '22px' }}>
                  {t('onboarding.orchestrator.desc')}
                </p>

                <div style={{
                  borderRadius: 'var(--cth-r-md)',
                  display: 'flex', gap: 8, alignItems: 'flex-start', padding: 10,
                  background: 'var(--cth-lemon-light)', boxShadow: 'inset 0 0 0 1px var(--cth-line-2)',
                  fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-700)'
                }}>
                  <span style={{ flexShrink: 0, marginTop: 1 }}><Icon name="sparkle" /></span>
                  <span>
                    <Trans i18nKey="onboarding.orchestrator.cliAgent" components={{ strong: <span style={{ color: 'var(--cth-ink-900)' }} /> }}>
                      <strong>Claude Code</strong>, made by Anthropic, is the AI that powers
                      your office. It runs right here on this computer. <strong>Your manager</strong> is
                      always on and runs your whole office. We recommend Opus 5.5, the newest model.
                    </Trans>
                  </span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {onboardingEngineChoices().eligible.map((p) => {
                    const sel = godProvider === p.id;
                    return (
                      <label key={p.id} style={{
                        borderRadius: 'var(--cth-r-md)',
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '8px 10px',
                        background: sel ? 'var(--cth-mint-light)' : 'var(--cth-paper-100)',
                        boxShadow: `inset 0 0 0 ${sel ? 2 : 1}px ${sel ? 'var(--cth-mint)' : 'var(--cth-ink-300)'}`,
                        cursor: 'pointer'
                      }}>
                        <input
                          type="radio"
                          name="godProvider"
                          value={p.id}
                          checked={sel}
                          onChange={() => {
                            setGodProvider(p.id);
                            // Reset the model to the new provider's recommended pick so the
                            // dropdown below always shows a valid model for the chosen engine.
                            setGodModel(p.recommendedOrchestratorModel);
                          }}
                          style={{ width: 16, height: 16, flexShrink: 0 }}
                        />
                        <span style={{
                          width: 22, height: 22, flexShrink: 0, display: 'flex',
                          alignItems: 'center', justifyContent: 'center', color: 'var(--cth-ink-900)'
                        }}>
                          <ProviderLogo provider={p.id} size={18} />
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'block', fontFamily: 'var(--cth-font-display)', fontSize: 11 }}>
                            {p.label}
                          </span>
                          {PROVIDER_BLURB_KEYS[p.id] && (
                            <span style={{ display: 'block', fontSize: 11, color: 'var(--cth-ink-500)' }}>
                              {t(PROVIDER_BLURB_KEYS[p.id]!)}
                            </span>
                          )}
                        </span>
                        {(() => {
                          const a = classifyEngineAvailability(engines, p.id);
                          const badge = engineAvailabilityBadge(a);
                          if (!badge) return null;
                          const bad = a.state === 'not-installable';
                          return (
                            <span title={a.path ?? undefined} style={{
                              borderRadius: 'var(--cth-r-md)',
                              fontSize: 10, padding: '1px 5px', lineHeight: '16px',
                              background: a.state === 'installed' ? 'var(--cth-mint-light)' : bad ? 'var(--cth-paper-100)' : 'var(--cth-cream-200)',
                              color: bad ? 'var(--cth-ink-500)' : 'var(--cth-ink-900)',
                              boxShadow: 'inset 0 0 0 1px var(--cth-line-2)',
                              fontFamily: 'var(--cth-font-display)', flexShrink: 0
                            }}>{badge}</span>
                          );
                        })()}
                        {p.id === 'claude' && (
                          <span style={{
                            borderRadius: 'var(--cth-r-md)',
                            fontSize: 10, padding: '1px 5px', lineHeight: '16px',
                            background: 'var(--cth-lemon)',
                            boxShadow: 'inset 0 0 0 1px var(--cth-line-2)',
                            fontFamily: 'var(--cth-font-display)', flexShrink: 0
                          }}>{t('onboarding.orchestrator.recommended')}</span>
                        )}
                      </label>
                    );
                  })}
                  {/* Engines a WORKER can run but Michael cannot (issue #355): shown
                      disabled instead of hidden, so "Copilot is missing" reads as the
                      real constraint — no inbox drain path — not as "unsupported". */}
                  {onboardingEngineChoices().workersOnly.map((p) => (
                    <label key={p.id} aria-disabled title={t('onboarding.orchestrator.workersOnlyHint')} style={{
                      borderRadius: 'var(--cth-r-md)',
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 10px',
                      background: 'var(--cth-paper-100)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-line-2)',
                      cursor: 'not-allowed', opacity: 0.75
                    }}>
                      <input type="radio" name="godProvider" value={p.id} checked={false} disabled
                        style={{ width: 16, height: 16, flexShrink: 0 }} />
                      <span style={{
                        width: 22, height: 22, flexShrink: 0, display: 'flex',
                        alignItems: 'center', justifyContent: 'center', color: 'var(--cth-ink-500)'
                      }}>
                        <ProviderLogo provider={p.id} size={18} />
                      </span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontFamily: 'var(--cth-font-display)', fontSize: 11, color: 'var(--cth-ink-500)' }}>
                          {p.label}
                        </span>
                        <span style={{ display: 'block', fontSize: 11, color: 'var(--cth-ink-500)' }}>
                          {t('onboarding.orchestrator.workersOnlyHint')}
                        </span>
                      </span>
                      <span style={{
                        borderRadius: 'var(--cth-r-md)',
                        fontSize: 10, padding: '1px 5px', lineHeight: '16px',
                        background: 'var(--cth-paper-100)', color: 'var(--cth-ink-500)',
                        boxShadow: 'inset 0 0 0 1px var(--cth-line-2)',
                        fontFamily: 'var(--cth-font-display)', flexShrink: 0
                      }}>{t('onboarding.orchestrator.workersOnly')}</span>
                    </label>
                  ))}
                </div>
                {engineBlocked && (
                  <div style={{
                    borderRadius: 'var(--cth-r-md)',
                    display: 'flex', flexDirection: 'column', gap: 8, padding: 10,
                    background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 2px var(--cth-ink-900)',
                    fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-900)'
                  }}>
                    <span>{engineAvailabilityMessage(selectedEngine, providerPreset(godProvider).label)}</span>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <PixelButton variant="secondary" size="sm" onClick={() => { void probeEngines(); }} disabled={probing}>
                        {probing ? 'checking...' : 'check again'}
                      </PixelButton>
                      {selectedEngine.docsUrl && (
                        <PixelButton variant="ghost" size="sm" onClick={() => { void window.cth.openExternal(selectedEngine.docsUrl!); }}>
                          install instructions
                        </PixelButton>
                      )}
                    </div>
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{t('onboarding.orchestrator.model')}</div>
                  <select
                    value={godModel ?? ''}
                    onChange={(e) => setGodModel(e.target.value || undefined)}
                    className="cth-input"
                    style={inputStyle}
                  >
                    {/* A <select> whose value matches no option shows its FIRST
                        row while the state keeps the other model, so the screen
                        and the saved choice disagree. Always list the selection. */}
                    {(() => {
                      const options = modelsForProvider(godProvider);
                      const listed = options.some((m) => (m.id ?? '') === (godModel ?? ''));
                      return (listed ? options : [{ id: godModel, label: godModel ?? '' }, ...options]).map((m) => (
                        <option key={m.id ?? m.label} value={m.id ?? ''}>{m.label}</option>
                      ));
                    })()}
                  </select>
                  <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                    {t('onboarding.orchestrator.modelNote')}
                  </div>
                </div>

                {/* The plan the office needs to run all day. Said here, before
                    finish, so a smaller plan's usage limit isn't a surprise on
                    the first busy afternoon. */}
                <div style={{
                  borderRadius: 'var(--cth-r-md)',
                  display: 'flex', flexDirection: 'column', gap: 8, padding: 10,
                  background: 'var(--cth-peach-light)', boxShadow: 'inset 0 0 0 2px var(--cth-peach)',
                  fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-700)'
                }}>
                  <span>
                    <Trans i18nKey="onboarding.orchestrator.maxPlan" components={{ strong: <span style={{ color: 'var(--cth-ink-900)' }} /> }}>
                      <strong>You&apos;ll need a Claude Max plan</strong> to keep your office running
                      full time. Smaller plans reach their usage limit during the day, and the
                      office pauses until the limit resets.
                    </Trans>
                  </span>
                  <div>
                    <PixelButton variant="ghost" size="sm" onClick={() => { void window.cth.openExternal(CLAUDE_PLANS_URL); }}>
                      {t('onboarding.orchestrator.seePlans')}
                    </PixelButton>
                  </div>
                </div>
              </>
            )}

            {step === 'team' && (
              <>
                <p style={{ margin: 0, lineHeight: '20px', fontSize: 14, color: 'var(--cth-ink-700)' }}>
                  {businessType === OTHER_BUSINESS
                    ? t('onboarding.team.introOther')
                    : t('onboarding.team.intro', { pack: teamPack?.displayName ?? '' })}
                </p>

                {/* The folder idea, said once, in plain words: each person has a
                    folder; put their documents there; they save their work there. */}
                {folderSuggestions && (
                  <div style={{
                    borderRadius: 'var(--cth-r-md)',
                    display: 'flex', gap: 10, alignItems: 'flex-start', padding: 10,
                    background: 'var(--cth-sky-light)', boxShadow: 'inset 0 0 0 1px var(--cth-line-2)',
                    fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-700)'
                  }}>
                    <span style={{ flexShrink: 0, marginTop: 1 }}><Icon name="folder" /></span>
                    <span>{t('onboarding.team.folderNote', { root: tildePath(folderSuggestions.root) })}</span>
                  </div>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <TeamCard
                    character="michael"
                    name={t('onboarding.team.managerName')}
                    summary={t('onboarding.team.managerSummary')}
                    chips={[{ tone: 'muted', label: t('onboarding.team.alwaysOn') }]}
                    folder={michaelFolderFor(folderSuggestions, folderOverrides)}
                    folderNote={t('onboarding.team.sharedFolder')}
                    displayPath={tildePath}
                    overridden={folderOverrides[OFFICE_KEY] !== undefined}
                    onChangeFolder={() => { void chooseTeamFolder(OFFICE_KEY); }}
                    onUseSuggested={() => resetTeamFolder(OFFICE_KEY)}
                    labels={folderLabels}
                  />
                  {teamAgents.map((a) => (
                    <TeamCard
                      key={a.id}
                      character={a.character}
                      name={`${a.character ? a.character[0].toUpperCase() + a.character.slice(1) : a.id} · ${a.role}`}
                      summary={a.summary}
                      chips={agentChips(a)}
                      picked={!!teamPicked[a.id]}
                      onTogglePicked={() => { setError(undefined); setTeamPicked((p) => ({ ...p, [a.id]: !p[a.id] })); }}
                      folder={folderFor(a, folderSuggestions, folderOverrides)}
                      displayPath={tildePath}
                      overridden={folderOverrides[a.id] !== undefined}
                      onChangeFolder={() => { void chooseTeamFolder(a.id); }}
                      onUseSuggested={() => resetTeamFolder(a.id)}
                      labels={folderLabels}
                    />
                  ))}
                </div>

                <div style={{ fontSize: 14, color: 'var(--cth-ink-500)' }}>
                  {t('onboarding.team.summary', { picked: pickedCount, connect: needed.required.length })}
                </div>
              </>
            )}

            {step === 'ready' && <GetMichaelReady provider={godProvider} onReadyChange={setEngineReady} />}

            {step === 'permissions' && (
              <>
                {/* AUTONOMY — one choice that maps to each engine's flag: autoMode →
                    claude bypassPermissions / codex -a never -s workspace-write
                    (sandbox kept), etc.; off → each engine's ask-first default. */}
                <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 14, fontWeight: 600, color: 'var(--cth-ink-2)' }}>
                  {t('onboarding.permissions.autonomyHead')}
                </div>
                <label style={{
                  borderRadius: 'var(--cth-r-md)',
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: 12,
                  background: autoMode ? 'var(--cth-mint-light)' : 'var(--cth-cream-200)',
                  boxShadow: `inset 0 0 0 2px ${autoMode ? 'var(--cth-mint)' : 'var(--cth-ink-500)'}`,
                  cursor: 'pointer'
                }}>
                  <input
                    type="checkbox"
                    checked={autoMode}
                    onChange={(e) => setAutoMode(e.target.checked)}
                    style={{ width: 18, height: 18, flexShrink: 0 }}
                  />
                  <div>
                    <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 14, fontWeight: 600, lineHeight: '16px' }}>
                      {t('onboarding.permissions.autoLabel')}
                    </div>
                    <div style={{ fontSize: 14, color: 'var(--cth-ink-700)' }}>
                      {autoMode ? t('onboarding.permissions.autoOn') : t('onboarding.permissions.autoOff')}
                    </div>
                  </div>
                </label>
                <div style={{ fontSize: 14, color: 'var(--cth-ink-500)' }}>
                  {t('onboarding.permissions.autoNote')}
                </div>

                <div style={{ height: 1, background: 'var(--cth-ink-300)', margin: '2px 0' }} />

                {/* RELIABILITY — keeping work firing while you're away. */}
                <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 14, fontWeight: 600, color: 'var(--cth-ink-2)' }}>
                  {t('onboarding.permissions.reliabilityHead')}
                </div>
                <p style={{ margin: 0, lineHeight: '20px', fontSize: 14, color: 'var(--cth-ink-700)' }}>
                  {t('onboarding.permissions.reliabilityDesc')}
                </p>

                <ToggleRow
                  icon="clock"
                  label={t('onboarding.permissions.keepAwake')}
                  desc={t('onboarding.permissions.keepAwakeDesc')}
                  on={strongKeepalive}
                  tint="var(--cth-mint-light)"
                  edge="var(--cth-mint)"
                  onChange={toggleStrongKeepalive}
                />

                <ToggleRow
                  icon="bell"
                  label={t('onboarding.permissions.notifications')}
                  desc={t('onboarding.permissions.notificationsDesc', { godName })}
                  on={notifications}
                  tint="var(--cth-peach-light)"
                  edge="var(--cth-peach)"
                  onChange={toggleNotifications}
                />

                {platform !== 'linux' && (
                  <ToggleRow
                    icon="play"
                    label={t('onboarding.permissions.openAtLogin')}
                    desc={t('onboarding.permissions.openAtLoginDesc')}
                    on={openAtLogin}
                    tint="var(--cth-sky-light)"
                    edge="var(--cth-sky)"
                    onChange={toggleOpenAtLogin}
                  />
                )}

                {COLLECT_USAGE_STATS && (
                  <ToggleRow
                    icon="info"
                    label={t('onboarding.permissions.shareStats')}
                    desc={t('onboarding.permissions.shareStatsDesc')}
                    on={shareStats}
                    tint="var(--cth-lemon-light)"
                    edge="var(--cth-lemon)"
                    onChange={() => setShareStats(!shareStats)}
                  />
                )}

                {/* Instruction-only: the OS won't let the app flip its sleep setting
                    itself, so we deep-link the pane where one exists (macOS/Windows)
                    and fall back to text-only guidance on Linux. */}
                <div style={{
                  borderRadius: 'var(--cth-r-md)',
                  display: 'flex', gap: 10, alignItems: 'flex-start', padding: 10,
                  background: 'var(--cth-lemon-light)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-line-2)'
                }}>
                  <span style={{
                    borderRadius: 'var(--cth-r-md)',
                    width: 28, height: 28, flexShrink: 0, display: 'flex',
                    alignItems: 'center', justifyContent: 'center',
                    background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-line-2)'
                  }}>
                    <Icon name="gear" />
                  </span>
                  <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div>
                      <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600, lineHeight: '16px', marginBottom: 3 }}>
                        {t('onboarding.permissions.stayAwake')}
                      </div>
                      <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
                        {t(`onboarding.permissions.stayAwakeDesc${stayAwakeOs === 'mac' ? 'Mac' : stayAwakeOs === 'windows' ? 'Windows' : 'Linux'}`)}
                      </div>
                    </div>
                    {stayAwakeUrl && (
                      <PixelButton variant="secondary" size="sm"
                        onClick={() => openSettings(stayAwakeUrl)}>
                        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                          <Icon name="arrow-right" /> {t(`onboarding.permissions.openBattery${stayAwakeOs === 'mac' ? 'Mac' : 'Windows'}`)}
                        </span>
                      </PixelButton>
                    )}
                  </div>
                </div>
              </>
            )}

            {error && (
              <div style={{
                borderRadius: 'var(--cth-r-md)',
                padding: '6px 10px',
                background: 'var(--cth-coral-light)',
                boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
                fontSize: 13,
                color: 'var(--cth-ink-900)',
                overflowWrap: 'anywhere'
              }}>{error}</div>
            )}

            {/* Footer / nav. It sticks to the window's bottom edge, so Back and
                Next stay in reach on a long step (the Team list runs past a
                900 px window). */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              position: 'sticky', bottom: 0, zIndex: 2, margin: '4px -22px -22px', padding: '12px 22px 16px',
              background: 'var(--cth-card)', borderTop: '1px solid var(--cth-line)'
            }}>
              {step === 'resume' ? <span /> : <Dots step={step} steps={steps} />}
              <div style={{ display: 'flex', gap: 8 }}>
                {step !== 'business' && step !== 'resume' && (
                  <PixelButton
                    variant="ghost"
                    size="md"
                    onClick={() => setStep(resuming && step === 'orchestrator' ? 'resume' : prevStep(step))}
                    disabled={busy}
                  >
                    {t('common.back')}
                  </PixelButton>
                )}
                {step !== lastStep && step !== 'resume' && (
                  <PixelButton
                    variant="primary"
                    size="md"
                    onClick={async () => {
                      // Step 1 needs a name, a location and a business type before
                      // anything else. The button stays clickable so the owner is
                      // TOLD what's missing, rather than facing a grey button.
                      if (step === 'business' && businessGaps.length > 0) {
                        setTriedBusiness(true);
                        return;
                      }
                      if (step === 'team' && !plan.ok) {
                        setError(t('onboarding.team.errNoFolders'));
                        return;
                      }
                      // Validate the home step HERE. Without this the only check
                      // lives in finish(), so an empty field walks you through all
                      // four steps and then bounces you back to step 1 to be told.
                      if (step === 'home' && !home.trim()) {
                        setError(t('onboarding.errPickHome'));
                        return;
                      }
                      // A folder that already holds an office is never set up as a
                      // new one: that would mix a second team into it. Offer to
                      // continue it instead, or ask for another folder.
                      if (step === 'home') {
                        setBusy(true);
                        const f = await window.cth.officeFind(home.trim()).catch(() => null);
                        setBusy(false);
                        // A check that failed says nothing about the folder: stay
                        // here rather than risk setting up a second team in it.
                        if (!f) { setError(t('onboarding.resume.folderCheckFailed')); return; }
                        if (f.hasOffice) {
                          if (f.path && f.record && teamPlanFromRecord(f.record).ok) {
                            setFound({ path: f.path, record: f.record });
                            setError(undefined);
                            setStep('resume');
                          } else {
                            setError(t('onboarding.resume.folderInUse'));
                          }
                          return;
                        }
                      }
                      // Same idea for the engine: refuse here, with the reason on
                      // screen, instead of letting a pick that cannot boot through
                      // to a Michael that never starts.
                      if (step === 'orchestrator' && engineBlocked) {
                        setError(t('onboarding.errEngineNotInstalled', { label: providerPreset(godProvider).label }));
                        return;
                      }
                      setError(undefined);
                      setStep(nextStep(step));
                    }}
                    disabled={busy || (step === 'orchestrator' && engineBlocked)}
                  >
                    {step === 'welcome' ? t('onboarding.team.suggestCta') : t('common.next')}
                  </PixelButton>
                )}
                {step === 'permissions' && lastStep === 'permissions' && (
                  <PixelButton variant="primary" size="md" onClick={finish} disabled={busy}>
                    {busy ? t('common.saving') : t('common.finish')}
                  </PixelButton>
                )}
                {step === 'ready' && !engineReady && (
                  <PixelButton variant="ghost" size="md" onClick={finish} disabled={busy}>
                    {t('engineSetup.setUpLater')}
                  </PixelButton>
                )}
                {step === 'ready' && (
                  <PixelButton variant="primary" size="md" onClick={finish} disabled={busy || !engineReady}>
                    {busy ? t('common.saving') : t('engineSetup.openOffice')}
                  </PixelButton>
                )}
              </div>
            </div>
          </div>
          </div>
        </div>
        {hasStudio && (
          <div className="cth-onboarding-studio cth-onb-studio-in" style={{ gridColumn: 3, gridRow: 1, minWidth: 0, marginInlineStart: 32, minHeight: 480, height: 'calc(100vh - 110px)', position: 'sticky', top: 0, alignSelf: 'start' }}>
            <OnboardingStudio picked={studioPicked.map(toSeat)} unpicked={studioUnpicked.map(toSeat)} businessName={businessName} />
          </div>
        )}
      </div>
    </div>
  );
}

const ORDERED_STEPS = ['business', 'details', 'welcome', 'team', 'home', 'orchestrator', 'permissions', 'ready'] as const;

/** The labelled steps (eight with Claude, whose Ready step sets it up; seven
 *  otherwise): done ones checked, the current one in ink. */
function StepIndicator({ steps, current }: { steps: readonly Step[]; current: number }) {
  const { t } = useTranslation();
  return (
    <ol aria-label={t('onboarding.stepsLabel')} style={{
      margin: '0 auto', padding: '6px 10px', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 8,
      background: 'var(--cth-card)', borderRadius: 999, boxShadow: 'inset 0 0 0 1px var(--cth-line), var(--cth-shadow-sm)'
    }}>
      {steps.map((key, i) => {
        const done = i < current;
        const now = i === current;
        return (
          <li key={key} aria-current={now ? 'step' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {i > 0 && <span aria-hidden="true" style={{ width: 14, height: 1, background: 'var(--cth-line-2)' }} />}
            <span style={{
              width: 22, height: 22, borderRadius: '50%', display: 'grid', placeItems: 'center', flexShrink: 0,
              fontFamily: 'var(--cth-font-mono)', fontSize: 11, fontWeight: 600,
              background: done ? 'var(--cth-green)' : now ? 'var(--cth-ink)' : 'transparent',
              color: done || now ? 'var(--cth-bg)' : 'var(--cth-ink-3)',
              boxShadow: done || now ? 'none' : 'inset 0 0 0 1px var(--cth-line-2)'
            }}>
              {done ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
              ) : i + 1}
            </span>
            <span style={{ fontSize: 12.5, fontWeight: now ? 600 : 500, color: now ? 'var(--cth-ink)' : done ? 'var(--cth-ink-2)' : 'var(--cth-ink-3)', whiteSpace: 'nowrap' }}>
              {t(`onboarding.steps.${key}`)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** One business type on the first onboarding screen (DESIGN.md 7.11). The glyph
 *  is emoji from the pack, NOT an `<Icon>` — see DESIGN.md 10.3 for why. */
function PackTile({ glyph, title, subtitle, selected, missing, onClick }: {
  glyph: string;
  title: string;
  subtitle: string;
  selected: boolean;
  /** No type picked after the owner tried Next: the same coral as a missing field. */
  missing?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      style={{
        borderRadius: 'var(--cth-r-md)',
        textAlign: 'left', cursor: 'pointer', border: 'none',
        padding: 10, display: 'flex', gap: 10, alignItems: 'flex-start',
        // Selection is indigo, as in the hire wizard; green means done or on.
        background: selected ? 'var(--cth-indigo-soft)' : 'var(--cth-card)',
        boxShadow: missing && !selected
          ? 'inset 0 0 0 2px var(--cth-coral-base)'
          : `inset 0 0 0 1px ${selected ? 'var(--cth-indigo)' : 'var(--cth-line-2)'}`
      }}
    >
      <span style={{
        borderRadius: 'var(--cth-r-md)',
        width: 28, height: 28, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--cth-neutral-soft)',
        fontSize: 16, lineHeight: '28px'
      }}>{glyph}</span>
      {/* minWidth:0 lets this flex child shrink below its content width;
          without it the text column refuses to narrow and pushes past the tile. */}
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{
          display: 'block', fontFamily: 'var(--cth-font-ui)',
          fontSize: 14, fontWeight: 600, lineHeight: '20px', color: 'var(--cth-ink)',
          // Pack names are DATA, not copy we control: a bundled or community pack
          // can supply a long token with no space in it ("SaaS/Consulting"), and
          // no browser breaks a line at a slash. Break anywhere rather than let a
          // name overflow the tile — the grid is the first screen an owner sees.
          overflowWrap: 'anywhere'
        }}>{title}</span>
        <span style={{
          display: 'block', fontSize: 14, lineHeight: '20px',
          color: 'var(--cth-ink-2)', overflowWrap: 'anywhere'
        }}>
          {subtitle}
        </span>
      </span>
    </button>
  );
}

type TeamChip = { tone: 'muted' | 'core' | 'need' | 'optional' | 'ok'; label: string };

// Design v2 chips (branding/DESIGN.md 7.25): fill, text, and a dashed edge
// for optional connections.
const CHIP_BG: Record<TeamChip['tone'], string> = {
  muted: 'var(--cth-indigo-soft)',
  core: 'var(--cth-green-soft)',
  need: 'var(--cth-card-2)',
  optional: 'transparent',
  ok: 'transparent'
};
const CHIP_FG: Record<TeamChip['tone'], string> = {
  muted: 'var(--cth-indigo-text)',
  core: 'var(--cth-green-text)',
  need: 'var(--cth-ink)',
  optional: 'var(--cth-ink-2)',
  ok: 'var(--cth-ink-3)'
};

/**
 * One member of the starter team (wireframe screen 2, plus the folder they work
 * in — Decision 47). `picked` undefined means not pickable: Michael, always on.
 * The folder row sits OUTSIDE the label so its buttons aren't nested inside
 * the checkbox's click target.
 */
function TeamCard({
  character, name, summary, chips, picked, onTogglePicked,
  folder, folderNote, displayPath, overridden, onChangeFolder, onUseSuggested, labels
}: {
  character?: string;
  name: string;
  summary: string;
  chips: TeamChip[];
  picked?: boolean;
  onTogglePicked?: () => void;
  folder?: string;
  folderNote?: string;
  displayPath: (p: string) => string;
  overridden: boolean;
  onChangeFolder: () => void;
  onUseSuggested: () => void;
  labels: { worksIn: string; change: string; useSuggested: string };
}) {
  const pickable = picked !== undefined;
  const active = !pickable || picked;
  const isMichael = character === 'michael';
  // The folder row lines up under the text: checkbox + gap + avatar + gap.
  const textIndent = (pickable ? 18 + 12 : 18 + 12) + 36 + 12;
  const [first, ...rest] = name.split(' · ');
  return (
    <div style={{ padding: '12px 4px', borderTop: '1px solid var(--cth-line)', opacity: active ? 1 : 0.55 }}>
      <label style={{ display: 'flex', gap: 12, alignItems: 'flex-start', cursor: pickable ? 'pointer' : 'default' }}>
        {pickable ? (
          <input
            type="checkbox"
            checked={picked}
            onChange={onTogglePicked}
            style={{ width: 18, height: 18, flexShrink: 0, marginTop: 9, accentColor: 'var(--cth-ink)' }}
          />
        ) : (
          <span aria-hidden="true" style={{ width: 18, height: 18, flexShrink: 0, marginTop: 9, display: 'grid', placeItems: 'center', color: 'var(--cth-ink-3)' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
          </span>
        )}
        <PersonAvatar who={{ id: character ?? first, character, name: first, isGod: isMichael }} size={36} />
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline', marginBottom: 2 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--cth-ink)' }}>{first}</span>
            {rest.length > 0 && <span style={{ fontSize: 14, color: 'var(--cth-ink-3)' }}>{rest.join(' · ')}</span>}
          </span>
          <span style={{ display: 'block', fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-2)' }}>{summary}</span>
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 7 }}>
            {chips.map((c) => (
              <span key={c.label} style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                fontSize: 14, fontWeight: 600, lineHeight: '20px', padding: '2px 9px', borderRadius: 999,
                background: CHIP_BG[c.tone], color: CHIP_FG[c.tone],
                boxShadow: c.tone === 'optional' ? 'none' : c.tone === 'need' ? 'inset 0 0 0 1px var(--cth-line-2)' : 'none',
                border: c.tone === 'optional' ? '1px dashed var(--cth-line-2)' : 'none'
              }}>
                {c.tone === 'need' && <i style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--cth-indigo)', display: 'block' }} />}
                {c.label}
              </span>
            ))}
          </span>
        </span>
      </label>

      {active && folder && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
          marginTop: 8, marginInlineStart: textIndent, fontSize: 14, color: 'var(--cth-ink-3)', minWidth: 0
        }}>
          <Icon name="folder" />
          <span>{labels.worksIn}</span>
          <span title={folder} style={{
            fontFamily: 'var(--cth-font-mono)', color: 'var(--cth-ink-2)', minWidth: 0, maxWidth: '100%',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
          }}>{displayPath(folder)}</span>
          {folderNote && <span>{folderNote}</span>}
          <button type="button" onClick={onChangeFolder} style={linkBtn}>{labels.change}</button>
          {overridden && <button type="button" onClick={onUseSuggested} style={linkBtn}>{labels.useSuggested}</button>}
        </div>
      )}
    </div>
  );
}

const linkBtn: React.CSSProperties = {
  padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', textDecoration: 'underline',
  fontFamily: 'var(--cth-font-ui)', fontSize: 14, fontWeight: 600, color: 'var(--cth-indigo-text)'
};

function ToggleRow({ icon, label, desc, on, tint, edge, onChange }: {
  icon: IconName;
  label: string;
  desc: string;
  on: boolean;
  tint: string; // background token when on
  edge: string; // border token when on
  onChange: (v: boolean) => void;
}) {
  return (
    <label style={{
      display: 'flex', gap: 12, alignItems: 'flex-start', padding: 12, borderRadius: 'var(--cth-r-lg)',
      background: on ? 'var(--cth-card-2)' : 'var(--cth-card)',
      boxShadow: `inset 0 0 0 1px ${on ? 'var(--cth-line-2)' : 'var(--cth-line)'}`,
      cursor: 'pointer'
    }} data-tint={tint} data-edge={edge}>
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 18, height: 18, flexShrink: 0, marginTop: 5, accentColor: 'var(--cth-ink)' }}
      />
      <span style={{
        width: 28, height: 28, flexShrink: 0, display: 'flex', borderRadius: 'var(--cth-r-md)',
        alignItems: 'center', justifyContent: 'center',
        background: 'var(--cth-neutral-soft)', color: 'var(--cth-ink-2)'
      }}>
        <Icon name={icon} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600, lineHeight: '16px', marginBottom: 3 }}>
          {label}
        </span>
        <span style={{ display: 'block', fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
          {desc}
        </span>
      </span>
    </label>
  );
}

function Dots({ step, steps }: { step: Step; steps: readonly Step[] }) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {steps.map((s) => (
        <span key={s} style={{
          borderRadius: 'var(--cth-r-md)',
          width: 8, height: 8,
          background: s === step ? 'var(--cth-ink-900)' : 'var(--cth-cream-300)',
          boxShadow: 'inset 0 0 0 1px var(--cth-line-2)'
        }} />
      ))}
    </div>
  );
}

/** Where setup suggests the office lives, and looks for an existing one. */
const DEFAULT_HOME = '~/HarnessAgents';
/** How many "~/HarnessAgents N" names a new office tries before asking the owner to pick. */
const NEW_OFFICE_SUGGESTIONS = 20;

function nextStep(s: Step): Step {
  return s === 'business' ? 'details'
    : s === 'details' ? 'welcome'
    : s === 'welcome' ? 'team'
    : s === 'team' ? 'home'
    : s === 'home' ? 'orchestrator'
    : s === 'orchestrator' ? 'permissions'
    : s === 'permissions' ? 'ready'
    : 'done';
}
function prevStep(s: Step): Step {
  return s === 'ready' ? 'permissions'
    : s === 'permissions' ? 'orchestrator'
    : s === 'orchestrator' ? 'home'
    : s === 'home' ? 'team'
    : s === 'team' ? 'welcome'
    : s === 'welcome' ? 'details'
    : 'business';
}


/** The v2 field (DESIGN.md 7.9): the ring and the indigo focus ring come from
 *  the `cth-input` class every caller sets. */
const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: '7px 10px',
  background: 'var(--cth-card)',
  border: 'none',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 13,
  color: 'var(--cth-ink)'
};
