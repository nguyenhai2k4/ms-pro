import type { Organization, User } from '@projectapp/shared-types';
import { create } from 'zustand';

/**
 * Client session state (Zustand per the locked stack). Server data belongs in TanStack Query, not
 * here — duplicating server state in a client store is how the two drift, and with a
 * server-authoritative schedule (ADR-002) that drift is a correctness bug rather than a
 * refresh annoyance.
 */
interface SessionState {
  token: string | null;
  user: User | null;
  organization: Organization | null;
  signIn: (token: string, user: User, organization: Organization) => void;
  signOut: () => void;
}

const TOKEN_STORAGE_KEY = 'projectapp.session.token';

export const useSessionStore = create<SessionState>((set) => ({
  token: typeof localStorage === 'undefined' ? null : localStorage.getItem(TOKEN_STORAGE_KEY),
  user: null,
  organization: null,
  signIn: (token, user, organization) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(TOKEN_STORAGE_KEY, token);
    set({ token, user, organization });
  },
  signOut: () => {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(TOKEN_STORAGE_KEY);
    set({ token: null, user: null, organization: null });
  },
}));
