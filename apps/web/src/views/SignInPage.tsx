import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { ApiClient } from '../api/client.js';
import { useSessionStore } from '../store/session.js';

/**
 * FR-AUTH-01: email/password sign-in and registration.
 *
 * FR-AUTH-02 (Google/Microsoft) is not offered here because the managed provider is not
 * configured in P0 — an OAuth button that fails on click is worse than no button, so the
 * limitation is visible in the UI instead.
 */
export interface SignInPageProps {
  readonly api: ApiClient;
}

export function SignInPage({ api }: SignInPageProps): JSX.Element {
  const signIn = useSessionStore((state) => state.signIn);
  const [mode, setMode] = useState<'sign-in' | 'register'>('sign-in');
  const [name, setName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const submit = useMutation({
    mutationFn: async () => {
      return mode === 'sign-in'
        ? api.login({ email, password })
        : api.register({ name, email, password, organizationName });
    },
    onSuccess: (session) => {
      signIn(session.token, session.user, session.organization);
    },
  });

  return (
    <main>
      <h1>ProjectApp</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit.mutate();
        }}
      >
        <fieldset>
          <legend>{mode === 'sign-in' ? 'Sign in' : 'Create an account'}</legend>

          {mode === 'register' ? (
            <>
              <label htmlFor="name">Your name</label>
              <input
                id="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />

              <label htmlFor="organizationName">Organization name</label>
              <input
                id="organizationName"
                value={organizationName}
                onChange={(event) => setOrganizationName(event.target.value)}
                required
              />
            </>
          ) : null}

          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />

          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={12}
          />

          <button type="submit" disabled={submit.isPending}>
            {mode === 'sign-in' ? 'Sign in' : 'Create account'}
          </button>
        </fieldset>
      </form>

      {submit.isError ? <p role="alert">{(submit.error as Error).message}</p> : null}

      <button type="button" onClick={() => setMode(mode === 'sign-in' ? 'register' : 'sign-in')}>
        {mode === 'sign-in' ? 'Create an account instead' : 'I already have an account'}
      </button>

      <p>Single sign-on and social login arrive after MVP (FR-AUTH-07, FR-ACL-06).</p>
    </main>
  );
}
