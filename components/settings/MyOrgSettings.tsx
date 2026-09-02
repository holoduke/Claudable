"use client";
/**
 * "Organisation" tab for owners, admins and members of an organisation: see the
 * members of YOUR organisation(s); owners and admins add people (by e-mail, any
 * domain), change roles and remove them; owners manage the org's Claude token.
 * Creating/deleting organisations stays superadmin work (OrgsSettings).
 *
 * Role rules are enforced server-side (org-access.ts) and only mirrored here:
 * an admin never creates or touches an owner; the last owner can never leave.
 */
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/contexts/I18nContext';
import { DATE_LOCALE } from '@/lib/i18n/config';

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

interface Props {
  orgs: MyOrg[];
  currentUserId: string;
  onToast: (message: string, type: 'success' | 'error') => void;
}

type RoleKey = 'role.eigenaar' | 'role.beheerder' | 'role.lid';
type AuditKey = `audit.${string}`;

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-white/8 bg-white dark:bg-white/6 text-sm text-gray-800 dark:text-gray-100 focus:outline-hidden focus:ring-2 focus:ring-gray-200';
const pillSelectCls =
  'px-2.5 py-1.5 text-xs font-medium border border-gray-200 dark:border-white/8 rounded-full bg-white dark:bg-white/6 text-gray-700 dark:text-gray-200 focus:outline-hidden focus:ring-0 disabled:opacity-50 cursor-pointer';

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

function OrgPanel({ org, currentUserId, onToast }: { org: MyOrg; currentUserId: string; onToast: Props['onToast'] }) {
  const { t, locale } = useI18n();
  const dateLocale = DATE_LOCALE[locale];
  const roleLabel = (r: string) => t(`role.${r}` as RoleKey);
  const count = (n: number, kind: 'members' | 'projects') => (n === 1 ? t(`common.${kind}.one`) : t(`common.${kind}.other`, { count: n }));
  const auditLabel = (action: string) => {
    const key = `audit.${action}` as AuditKey;
    const label = t(key as 'audit.org.member.added');
    return label === key ? action : label;
  };

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

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const [mRes, iRes] = await Promise.all([
        fetch(`${API_BASE}/api/orgs/${org.id}/members`),
        fetch(`${API_BASE}/api/orgs/${org.id}/invites`),
      ]);
      const mJson = await mRes.json();
      if (!mRes.ok || !mJson.success) throw new Error(mJson.message || t('org.loadMembersFailed'));
      setMembers(mJson.data as OrgMemberRow[]);
      const iJson = await iRes.json().catch(() => null);
      setInvites(iRes.ok && iJson?.success ? (iJson.data as InviteRow[]) : []);
    } catch (err) {
      onToast(err instanceof Error ? err.message : t('org.loadMembersFailed'), 'error');
    } finally {
      setLoading(false);
    }
  }, [org.id, onToast, t]);

  useEffect(() => { void load(); }, [load]);

  const loadCred = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/orgs/${org.id}/claude-credential`);
      const json = await res.json().catch(() => null);
      setCred(res.ok && json?.success ? json.data : null);
    } catch { setCred(null); }
  }, [org.id]);
  useEffect(() => { void loadCred(); }, [loadCred]);

  /** Shared request pattern: error → toast, success → silent refresh (no remount, no scroll jump). */
  const call = async (url: string, init: RequestInit, okMessage: string | null) => {
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}${url}`, { headers: { 'Content-Type': 'application/json' }, ...init });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || t('common.actionFailed'));
      if (okMessage) onToast(okMessage, 'success');
      await load({ silent: true });
      return true;
    } catch (err) {
      onToast(err instanceof Error ? err.message : t('common.actionFailed'), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveCred = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/orgs/${org.id}/claude-credential`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: credLabel, token: credToken }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || t('common.actionFailed'));
      onToast(t('org.credential.saved', { org: org.name }), 'success');
      setCredLabel(''); setCredToken('');
      await loadCred();
    } catch (err) {
      onToast(err instanceof Error ? err.message : t('common.actionFailed'), 'error');
    } finally { setBusy(false); }
  };

  const removeCred = async () => {
    if (!window.confirm(t('org.credential.confirmRemove', { org: org.name }))) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/orgs/${org.id}/claude-credential`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || t('common.actionFailed'));
      onToast(t('org.credential.removed'), 'success');
      await loadCred();
    } catch (err) {
      onToast(err instanceof Error ? err.message : t('common.actionFailed'), 'error');
    } finally { setBusy(false); }
  };

  const addMember = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/orgs/${org.id}/members`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || t('common.actionFailed'));
      const addr = email.trim();
      onToast(json.data?.invited
        ? (json.data?.emailSent ? t('org.toast.invited', { email: addr }) : t('org.toast.invitedNoMail', { email: addr }))
        : t('org.toast.added', { email: addr, org: org.name }), 'success');
      setEmail(''); setRole('lid');
      await load({ silent: true });
    } catch (err) {
      onToast(err instanceof Error ? err.message : t('common.actionFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const revokeInvite = (i: InviteRow) =>
    call(`/api/orgs/${org.id}/invites/${i.id}`, { method: 'DELETE' }, t('org.toast.inviteRevoked', { email: i.email }));

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
      ? t('org.confirm.removeSelf', { org: org.name })
      : t('org.confirm.removeMember', { name: m.name || m.email, org: org.name }))) return;
    return call(`/api/orgs/${org.id}/members/${m.userId}`, { method: 'DELETE' }, t('org.toast.removed', { email: m.email, org: org.name }));
  };

  /** May the signed-in user change this row? Mirrors canActorSetRole. */
  const rowLocked = (m: OrgMemberRow) => {
    if (!canManage) return true;
    if (!isOwner && m.role === 'eigenaar') return true; // an admin never touches an owner
    if (m.role === 'eigenaar' && ownerCount <= 1) return true; // last owner
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
            {count(org.memberCount, 'members')} · {count(org.projectCount, 'projects')}
            {org.domain ? ` · ${org.domain}` : ''}
          </p>
        </div>
        <span className="text-[11px] font-medium text-gray-600 dark:text-gray-300 bg-gray-200 dark:bg-white/8 px-2 py-0.5 rounded-full">
          {t('org.yourRole', { role: roleLabel(org.role) })}
        </span>
      </div>

      <div className="p-4 space-y-3">
        {loading ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('org.loadingMembers')}</p>
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
                      {m.userId === currentUserId && <span className="ml-2 text-[11px] text-gray-500 dark:text-gray-400">{t('common.you')}</span>}
                      {!m.isActive && <span className="ml-2 text-[11px] font-medium text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded-sm">{t('common.deactivated')}</span>}
                    </p>
                    {m.name && <p className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{m.email}</p>}
                  </div>
                  {canManage ? (
                    <>
                      <select value={m.role} disabled={busy || locked}
                        title={locked ? (m.role === 'eigenaar' && ownerCount <= 1 ? t('org.lastOwnerHint') : t('org.onlyOwnerChangesOwners')) : undefined}
                        onChange={(e) => changeRole(m, e.target.value)} className={pillSelectCls}>
                        {(isOwner || m.role === 'eigenaar') && <option value="eigenaar">{t('role.eigenaar')}</option>}
                        <option value="beheerder">{t('role.beheerder')}</option>
                        <option value="lid">{t('role.lid')}</option>
                      </select>
                      <button onClick={() => remove(m)} disabled={busy || locked}
                        className="px-2.5 py-1.5 text-xs font-medium border border-red-200 rounded-full bg-white dark:bg-white/3 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40">
                        {t('common.remove')}
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-gray-500 dark:text-gray-400">{roleLabel(m.role)}</span>
                  )}
                </li>
              );
            })}
            {members.length === 0 && <li className="text-sm text-gray-500 dark:text-gray-400">{t('org.noMembers')}</li>}
          </ul>
        )}

        {invites.filter((i) => i.status === 'open').length > 0 && (
          <div className="pt-2">
            <p className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-2">{t('org.pendingInvites')}</p>
            <ul className="space-y-2">
              {invites.filter((i) => i.status === 'open').map((i) => (
                <li key={i.id} className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-full border border-dashed border-gray-300 dark:border-white/15 flex items-center justify-center text-xs text-gray-500">✉</div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-800 dark:text-gray-100 truncate">{i.email}</p>
                    <p className="text-[11px] text-gray-500 dark:text-gray-400">
                      {t('org.inviteExpires', { role: roleLabel(i.role), date: new Date(i.expiresAt).toLocaleDateString(dateLocale) })}
                      {i.invitedBy ? ` · ${t('common.by', { name: i.invitedBy })}` : ''}
                    </p>
                  </div>
                  {canManage && (
                    <button onClick={() => revokeInvite(i)} disabled={busy || (!isOwner && i.role === 'eigenaar')}
                      className="px-2.5 py-1.5 text-xs font-medium border border-gray-200 dark:border-white/8 rounded-full bg-white dark:bg-white/3 text-gray-600 dark:text-gray-300 hover:bg-gray-50 transition-colors disabled:opacity-40">
                      {t('common.revoke')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {canManage && (org.canCreateProjects !== false || isOwner) && (
          <div className="rounded-xl border border-gray-200 dark:border-white/8 divide-y divide-gray-200 dark:divide-white/8">
            {org.canCreateProjects !== false && (
              <div className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-50">{t('org.createProjects')}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{t('org.createProjects.managedBy')}</p>
                </div>
                <span className="shrink-0 text-[11px] font-medium px-2 py-0.5 rounded-full text-green-700 bg-green-100 dark:text-green-300 dark:bg-green-500/20">{t('org.createProjects.allowed')}</span>
              </div>
            )}
            {isOwner && (
              <div className="px-4 py-3 space-y-2">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-50">{t('org.credential.title')}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">{t('org.credential.desc', { org: org.name })}</p>
                  </div>
                  {cred === undefined ? null : cred ? (
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[11px] font-medium text-green-700 dark:text-green-300 bg-green-100 dark:bg-green-500/20 px-2 py-0.5 rounded-full">
                        {cred.label} · {cred.kind === 'api-key' ? t('org.credential.apiKey') : t('org.credential.oauth')}
                      </span>
                      <button onClick={removeCred} disabled={busy}
                        className="px-2.5 py-1.5 text-xs font-medium border border-red-200 rounded-full bg-white dark:bg-white/3 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40">
                        {t('common.remove')}
                      </button>
                    </div>
                  ) : (
                    <span className="shrink-0 text-[11px] font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-white/8 px-2 py-0.5 rounded-full">{t('org.credential.notSet')}</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <input type="text" value={credLabel} onChange={(e) => setCredLabel(e.target.value)} placeholder={t('common.label')} className={`${inputCls} w-40! shrink-0`} />
                  <input type="password" value={credToken} onChange={(e) => setCredToken(e.target.value)} placeholder={t('org.credential.tokenPlaceholder')} className={`${inputCls} flex-1 min-w-0 font-mono`} autoComplete="off" />
                  <button onClick={saveCred} disabled={busy || !credToken.trim()}
                    className="px-4 py-2 text-sm font-medium bg-brand-500 hover:bg-brand-600 text-white rounded-lg transition-colors disabled:opacity-50">
                    {cred ? t('common.replace') : t('common.set')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {canManage && (
          <div className="pt-2">
            <p className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-2">{t('org.addMember')}</p>
            <div className="flex gap-2">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addMember(); }}
                placeholder={t('org.emailPlaceholder')} className={`${inputCls} flex-1 min-w-0`} />
              <select value={role} onChange={(e) => setRole(e.target.value as 'beheerder' | 'lid')} className={`${inputCls} w-40! shrink-0`}>
                <option value="lid">{t('role.lid')}</option>
                <option value="beheerder">{t('role.beheerder')}</option>
              </select>
              <button onClick={addMember} disabled={busy || !email.trim()}
                className="px-4 py-2 text-sm font-medium bg-brand-500 hover:bg-brand-600 text-white rounded-lg transition-colors disabled:opacity-50">
                {t('common.add')}
              </button>
            </div>
            <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-2">
              {t('org.addMemberHint', { org: org.name })}{isOwner ? ` ${t('org.addOwnerHint')}` : ''}
            </p>
          </div>
        )}

        {canManage && (
          <div className="pt-2">
            <button onClick={loadAudit} className="text-xs font-medium text-gray-600 dark:text-gray-300 hover:underline">
              {showAudit ? t('org.audit.hide') : t('org.audit.show')}
            </button>
            {showAudit && (
              <ul className="mt-2 space-y-1 max-h-64 overflow-y-auto pr-1">
                {audit === null ? (
                  <li className="text-xs text-gray-500">{t('common.loading')}</li>
                ) : audit.length === 0 ? (
                  <li className="text-xs text-gray-500">{t('org.audit.empty')}</li>
                ) : audit.map((e) => (
                  <li key={e.id} className="text-[11px] text-gray-600 dark:text-gray-300 flex gap-2">
                    <span className="text-gray-400 shrink-0 tabular-nums">{new Date(e.at).toLocaleString(dateLocale, { dateStyle: 'short', timeStyle: 'short' })}</span>
                    <span className="truncate">
                      <span className="font-medium">{auditLabel(e.action)}</span>
                      {describeMeta(e.meta) ? ` · ${describeMeta(e.meta)}` : ''}
                      {e.actorEmail ? ` · ${t('common.by', { name: e.actorEmail })}` : ''}
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
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-50">{t('org.title')}</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('org.intro')}</p>
      </div>
      {orgs.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('org.noneYet')}</p>
      ) : (
        orgs.map((org) => <OrgPanel key={org.id} org={org} currentUserId={currentUserId} onToast={onToast} />)
      )}
    </div>
  );
}
