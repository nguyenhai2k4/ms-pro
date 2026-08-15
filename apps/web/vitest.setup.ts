import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library registers auto-cleanup only when vitest runs with `globals: true`. We run with
// explicit imports, so cleanup is wired here — without it, renders accumulate across tests and a
// "there should be no button" assertion fails against a button left over from a previous test.
afterEach(() => {
  cleanup();
});
