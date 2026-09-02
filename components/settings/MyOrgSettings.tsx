"use client";
/**
 * "Organisatie"-tab voor eigenaren en beheerders van een organisatie: de leden
 * van de EIGEN organisatie(s) bekijken, toevoegen (op e-mailadres, elk domein),
 * van rol veranderen en verwijderen. Geen organisaties aanmaken/verwijderen —
 * dat blijft superadmin-werk (OrgsSettings).
 *
 * Rolregels (server-side afgedwongen in org-access.ts, hier alleen gespiegeld
 * in de UI): een beheerder kan geen eigenaren aanmaken of aanraken; de laatste
 * eigenaar kan nooit weg.
 */
import { useCallback, useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

export interface MyOrg {
  id: string;
  name: string;
  type: 'intern' | 'klant';
  domain: string | null;
  role: 'eigenaar' | 'beheerder' | 'lid';
  canCreateProjects?: boolean;
  hasClaudeCredential?: boolean;
  memberCount: number;
  projectCount: number;
}

interface OrgMemberRow {
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
  role: 'eigenaar' | 'beheerder' | 'lid';
  isActive: boolean;
}

interface InviteRow {
  id: string;
  email: string;
  role: 'eigenaar' | 'beheerder' | 'lid';
  invitedBy: string | null;
  expiresAt: string;
  status: 'open' | 'verlopen' | 'ingetrokken';
}

interface AuditRow {
  id: string;
  action: string;
  actorEmail: string | null;
  meta: Record<string, unknown> | null;
  at: string;
}

const ACTION_LABEL: Record<string, string> = {
  'org.member.added': 'lid toegevoegd',
  'org.member.role_changed': 'rol gewijzigd',
  'org.member.removed': 'lid verwijderd',
  'org.invite.created': 'uitnodiging verstuurd',
  'org.invite.revoked': 'uitnodiging ingetrokken',
  'org.invite.accepted': 'uitnodiging geaccepteerd',
  'org.claude_credential.set': 'Claude-token ingesteld',
  'org.claude_credential.removed': 'Claude-token verwijderd',
  'project.org_changed': 'project verplaatst naar organisatie',
  'org.created': 'organisatie aangemaakt',
  'org.updated': 'organisatie gewijzigd',
  'project.visibility_changed': 'projectzichtbaarheid gewijzigd',
  'project.member.added': 'projectlid toegevoegd',
  'project.member.role_changed': 'projectrol gewijzigd',
  'project.member.removed': 'projectlid verwijderd',
};

function describeMeta(meta: Record<string, unknown> | null): string {
  if (!meta) return '';
  const parts: string[] = [];
  if (typeof meta.email === 'string') parts.push(meta.email);
  if (typeof meta.from === 'string' && typeof meta.role === 'string') parts.push(`${meta.from} → ${meta.role}`);
  else if (typeof meta.role === 'string') parts.push(String(meta.role));
  if (typeof meta.visibility === 'string') parts.push(String(meta.visibility));
  if (typeof meta.name === 'string') parts.push(String(meta.name));
  return parts.join(' · ');
}

interface Props {
  orgs: MyOrg[];
  currentUserId: string;
  onToast: (message: string, type: 'success' | 'error') => void;
}

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-white/8 bg-white dark:bg-white/6 text-sm text-gray-800 dark:text-gray-100 focus:outline-hidden focus:ring-2 focus:ring-gray-200';
const pillSelectCls =
  'px-2.5 py-1.5 text-xs font-medium border border-gray-200 dark:border-white/8 rounded-full bg-white dark:bg-white/6 text-gray-700 dark:text-gray-200 focus:outline-hidden focus:ring-0 disabled:opacity-50 cursor-pointer';

const ROLE_LABEL: Record<OrgMemberRow['role'], string> = { eigenaar: 'Eigenaar', beheerder: 'Beheerder', lid: 'Lid' };

function OrgPanel({ org, currentUserId, onToast }: { org: MyOrg; currentUserId: string; onToast: Props['onToast'] }) {
  const [members, setMembers] = useState<OrgMemberRow[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  const [showAudit, setShowAudit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'beheerder' | 'lid'>('lid');
  const [cred, setCred] = useState<{ label: string; kind: string; since: string } | null | undefined>(undefined);
  const [credLabel, setCredLabel] = useState('');
  const [credToken, setCredToken] = useState('');

  const canManage = org.role === 'eigenaar' || org.role === 'beheerder';
  const isOwner = org.role === 'eigenaar';
  const ownerCount = members.filter((m) => m.role === 'eigenaar').length;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [mRes, iRes] = await Promise.all([
        fetch(`${API_BASE}/api/orgs/${org.id}/members`),
        fetch(`${API_BASE}/api/orgs/${org.id}/invites`),
      ]);
      const mJson = await mRes.json();
      if (!mRes.ok || !mJson.success) throw new Error(mJson.message || 'Leden laden mislukt');
      setMembers(mJson.data as OrgMemberRow[]);
      const iJson = await iRes.json().catch(() => null);
      setInvites(iRes.ok && iJson?.success ? (iJson.data as InviteRow[]) : []);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Leden laden mislukt', 'error');
    } finally {
      setLoading(false);
    }
  }, [org.id, onToast]);

  useEffect(() => { load(); }, [load]);

  const loadCred = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/orgs/${org.id}/claude-credential`);
      const json = await res.json().catch(() => null);
      setCred(res.ok && json?.success ? json.data : null);
    } catch { setCred(null); }
  }, [org.id]);
  useEffect(() => { loadCred(); }, [loadCred]);

  const saveCred = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/orgs/${org.id}/claude-credential`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: credLabel, token: credToken }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || 'Opslaan mislukt');
      onToast(`Claude-token voor ${org.name} opgeslagen`, 'success');
      setCredLabel(''); setCredToken('');
      await loadCred();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Opslaan mislukt', 'error');
    } finally { setBusy(false); }
  };

  const removeCred = async () => {
    if (!window.confirm(`Claude-token van ${org.name} verwijderen?`)) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/orgs/${org.id}/claude-credential`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || 'Verwijderen mislukt');
      onToast('Claude-token verwijderd', 'success');
      await loadCred();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Verwijderen mislukt', 'error');
    } finally { setBusy(false); }
  };

  const call = async (url: string, init: RequestInit, okMessage: string | null) => {
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}${url}`, { headers: { 'Content-Type': 'application/json' }, ...init });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || 'Actie mislukt');
      if (okMessage) onToast(okMessage, 'success');
      await load();
      return true;
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Actie mislukt', 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addMember = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/orgs/${org.id}/members`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || 'Actie mislukt');
      onToast(json.data?.invited
        ? (json.data?.emailSent
            ? `Uitnodiging gemaild naar ${email.trim()} — 14 dagen geldig`
            : `${email.trim()} uitgenodigd (14 dagen geldig) — er is geen e-mail verstuurd, laat de persoon zelf inloggen`)
        : `${email.trim()} toegevoegd aan ${org.name}`, 'success');
      setEmail(''); setRole('lid');
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Actie mislukt', 'error');
    } finally {
      setBusy(false);
    }
  };

  const revokeInvite = (i: InviteRow) =>
    call(`/api/orgs/${org.id}/invites/${i.id}`, { method: 'DELETE' }, `Uitnodiging voor ${i.email} ingetrokken`);

  const loadAudit = async () => {
    setShowAudit((v) => !v);
    if (audit) return;
    try {
      const res = await fetch(`${API_BASE}/api/orgs/${org.id}/audit?limit=50`);
      const json = await res.json();
      setAudit(res.ok && json.success ? (json.data as AuditRow[]) : []);
    } catch {
      setAudit([]);
    }
  };

  const changeRole = (m: OrgMemberRow, next: string) =>
    call(`/api/orgs/${org.id}/members/${m.userId}`, { method: 'PATCH', body: JSON.stringify({ role: next }) }, null);

  const remove = (m: OrgMemberRow) => {
    const self = m.userId === currentUserId;
    if (!window.confirm(self
      ? `Jezelf uit ${org.name} verwijderen? Je verliest de toegang tot de projecten van deze organisatie.`
      : `${m.name || m.email} uit ${org.name} verwijderen?`)) return;
    return call(`/api/orgs/${org.id}/members/${m.userId}`, { method: 'DELETE' }, `${m.email} uit ${org.name} gehaald`);
  };

  /** Mag de ingelogde gebruiker deze rij aanpassen? Spiegelt canActorSetRole. */
  const rowLocked = (m: OrgMemberRow) => {
    if (!canManage) return true;
    if (!isOwner && m.role === 'eigenaar') return true; // beheerder raakt geen eigenaar aan
    if (m.role === 'eigenaar' && ownerCount <= 1) return true; // laatste eigenaar
    return false;
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-white/8 overflow-hidden">
      <div className="flex items-center gap-3 p-4 bg-gray-50 dark:bg-white/3">
        <div className="w-9 h-9 rounded-lg bg-gray-200 dark:bg-white/6 flex items-center justify-center text-sm font-semibold text-gray-600 dark:text-gray-300 shrink-0">
          {org.name.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-50 truncate">{org.name}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {org.memberCount} {org.memberCount === 1 ? 'lid' : 'leden'} · {org.projectCount} {org.projectCount === 1 ? 'project' : 'projecten'}
            {org.domain ? ` · ${org.domain}` : ''}
          </p>
        </div>
        <span className="text-[11px] font-medium text-gray-600 dark:text-gray-300 bg-gray-200 dark:bg-white/8 px-2 py-0.5 rounded-full">
          jij: {ROLE_LABEL[org.role]}
        </span>
      </div>

      <div className="p-4 space-y-3">
        {loading ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">Leden laden…</p>
        ) : (
          <ul className="space-y-2">
            {members.map((m) => {
              const locked = rowLocked(m);
              return (
                <li key={m.userId} className="flex items-center gap-3">
                  {m.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={m.image} alt="" className="w-7 h-7 rounded-full" />
                  ) : (
                    <div className="w-7 h-7 rounded-full bg-gray-200 dark:bg-white/6 flex items-center justify-center text-xs font-medium text-gray-600 dark:text-gray-300">
                      {(m.name || m.email).charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-800 dark:text-gray-100 truncate">
                      {m.name || m.email}
                      {m.userId === currentUserId && <span className="ml-2 text-[11px] text-gray-500 dark:text-gray-400">(jij)</span>}
                      {!m.isActive && <span className="ml-2 text-[11px] font-medium text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded-sm">gedeactiveerd</span>}
                    </p>
                    {m.name && <p className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{m.email}</p>}
                  </div>
                  {canManage ? (
                    <>
                      <select value={m.role} disabled={busy || locked}
                        title={locked ? (m.role === 'eigenaar' && ownerCount <= 1 ? 'Laatste eigenaar — wijs eerst een andere eigenaar aan' : 'Alleen een eigenaar kan eigenaren wijzigen') : undefined}
                        onChange={(e) => changeRole(m, e.target.value)} className={pillSelectCls}>
                        {isOwner && <option value="eigenaar">Eigenaar</option>}
                        {!isOwner && m.role === 'eigenaar' && <option value="eigenaar">Eigenaar</option>}
                        <option value="beheerder">Beheerder</option>
                        <option value="lid">Lid</option>
                      </select>
                      <button onClick={() => remove(m)} disabled={busy || locked}
                        className="px-2.5 py-1.5 text-xs font-medium border border-red-200 rounded-full bg-white dark:bg-white/3 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40">
                        Verwijderen
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-gray-500 dark:text-gray-400">{ROLE_LABEL[m.role]}</span>
                  )}
                </li>
              );
            })}
            {members.length === 0 && <li className="text-sm text-gray-500 dark:text-gray-400">Nog geen leden.</li>}
          </ul>
        )}

        {invites.filter((i) => i.status === 'open').length > 0 && (
          <div className="pt-2">
            <p className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-2">Openstaande uitnodigingen</p>
            <ul className="space-y-2">
              {invites.filter((i) => i.status === 'open').map((i) => (
                <li key={i.id} className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-full border border-dashed border-gray-300 dark:border-white/15 flex items-center justify-center text-xs text-gray-500">✉</div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-800 dark:text-gray-100 truncate">{i.email}</p>
                    <p className="text-[11px] text-gray-500 dark:text-gray-400">
                      {ROLE_LABEL[i.role]} · verloopt {new Date(i.expiresAt).toLocaleDateString('nl-NL')}{i.invitedBy ? ` · door ${i.invitedBy}` : ''}
                    </p>
                  </div>
                  {canManage && (
                    <button onClick={() => revokeInvite(i)} disabled={busy || (!isOwner && i.role === 'eigenaar')}
                      className="px-2.5 py-1.5 text-xs font-medium border border-gray-200 dark:border-white/8 rounded-full bg-white dark:bg-white/3 text-gray-600 dark:text-gray-300 hover:bg-gray-50 transition-colors disabled:opacity-40">
                      Intrekken
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {canManage && (
          <div className="rounded-xl border border-gray-200 dark:border-white/8 divide-y divide-gray-200 dark:divide-white/8">
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-50">Nieuwe projecten aanmaken</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">Deze instelling beheert New Story per organisatie.</p>
              </div>
              <span className={`shrink-0 text-[11px] font-medium px-2 py-0.5 rounded-full ${org.canCreateProjects === false ? 'text-amber-800 bg-amber-100 dark:text-amber-200 dark:bg-amber-500/20' : 'text-green-700 bg-green-100 dark:text-green-300 dark:bg-green-500/20'}`}>
                {org.canCreateProjects === false ? 'Niet toegestaan' : 'Toegestaan'}
              </span>
            </div>
            {isOwner && (
              <div className="px-4 py-3 space-y-2">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-50">Claude-token van de organisatie</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Hierop draait de AI-assistent voor de projecten van {org.name}. Plak een OAuth-token uit <code>claude setup-token</code> of een API-sleutel (sk-ant-api…).
                    </p>
                  </div>
                  {cred === undefined ? null : cred ? (
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[11px] font-medium text-green-700 dark:text-green-300 bg-green-100 dark:bg-green-500/20 px-2 py-0.5 rounded-full">
                        {cred.label} · {cred.kind === 'api-key' ? 'API-sleutel' : 'OAuth-token'}
                      </span>
                      <button onClick={removeCred} disabled={busy}
                        className="px-2.5 py-1.5 text-xs font-medium border border-red-200 rounded-full bg-white dark:bg-white/3 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40">
                        Verwijderen
                      </button>
                    </div>
                  ) : (
                    <span className="shrink-0 text-[11px] font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-white/8 px-2 py-0.5 rounded-full">nog niet ingesteld</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <input type="text" value={credLabel} onChange={(e) => setCredLabel(e.target.value)} placeholder="Label" className={`${inputCls} w-40! shrink-0`} />
                  <input type="password" value={credToken} onChange={(e) => setCredToken(e.target.value)} placeholder="sk-ant-oat… of sk-ant-api…" className={`${inputCls} flex-1 min-w-0 font-mono`} autoComplete="off" />
                  <button onClick={saveCred} disabled={busy || !credToken.trim()}
                    className="px-4 py-2 text-sm font-medium bg-brand-500 hover:bg-brand-600 text-white rounded-lg transition-colors disabled:opacity-50">
                    {cred ? 'Vervangen' : 'Instellen'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {canManage && (
          <div className="pt-2">
            <p className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-2">Lid toevoegen</p>
            <div className="flex gap-2">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addMember(); }}
                placeholder="persoon@bedrijf.nl" className={`${inputCls} flex-1 min-w-0`} />
              <select value={role} onChange={(e) => setRole(e.target.value as 'beheerder' | 'lid')} className={`${inputCls} w-36! shrink-0`}>
                <option value="lid">Lid</option>
                <option value="beheerder">Beheerder</option>
              </select>
              <button onClick={addMember} disabled={busy || !email.trim()}
                className="px-4 py-2 text-sm font-medium bg-brand-500 hover:bg-brand-600 text-white rounded-lg transition-colors disabled:opacity-50">
                Toevoegen
              </button>
            </div>
            <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-2">
              Een bestaande gebruiker wordt direct lid; een nieuw adres krijgt een uitnodiging (14 dagen geldig) en
              kan dan via Google inloggen. Nieuwe leden zien alleen de projecten van {org.name}.
              {isOwner ? ' Een extra eigenaar wijs je aan via het rol-menu bij een bestaand lid.' : ''}
            </p>
          </div>
        )}

        {canManage && (
          <div className="pt-2">
            <button onClick={loadAudit} className="text-xs font-medium text-gray-600 dark:text-gray-300 hover:underline">
              {showAudit ? 'Logboek verbergen' : 'Logboek tonen'}
            </button>
            {showAudit && (
              <ul className="mt-2 space-y-1 max-h-64 overflow-y-auto pr-1">
                {audit === null ? (
                  <li className="text-xs text-gray-500">Laden…</li>
                ) : audit.length === 0 ? (
                  <li className="text-xs text-gray-500">Nog geen gebeurtenissen.</li>
                ) : audit.map((e) => (
                  <li key={e.id} className="text-[11px] text-gray-600 dark:text-gray-300 flex gap-2">
                    <span className="text-gray-400 shrink-0 tabular-nums">{new Date(e.at).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' })}</span>
                    <span className="truncate">
                      <span className="font-medium">{ACTION_LABEL[e.action] ?? e.action}</span>
                      {describeMeta(e.meta) ? ` · ${describeMeta(e.meta)}` : ''}
                      {e.actorEmail ? ` · door ${e.actorEmail}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function MyOrgSettings({ orgs, currentUserId, onToast }: Props) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-50">Organisatie</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          De leden van je organisatie. Eigenaren en beheerders kunnen leden toevoegen, van rol
          veranderen en verwijderen; leden zien alleen wie er meedoet.
        </p>
      </div>
      {orgs.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">Je bent nog geen lid van een organisatie.</p>
      ) : (
        orgs.map((org) => <OrgPanel key={org.id} org={org} currentUserId={currentUserId} onToast={onToast} />)
      )}
    </div>
  );
}
