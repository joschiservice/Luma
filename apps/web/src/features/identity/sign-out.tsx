import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@luma/ui/button';
import { auth, clearPrivate } from './data';
import { Brand } from './common';
export function SignOut() {
  const client = useQueryClient();
  const started = useRef(false);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  async function signOut() {
    setPending(true);
    setFailed(false);
    await clearPrivate(client);
    try {
      const result = await auth.signOut();
      if (result.error) throw new Error('Sign-out failed');
      window.location.replace('/sign-in');
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void signOut();
    // The initial revocation runs once; retries require a deliberate click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <main className="status-page">
      <Brand />
      <h1>{failed ? 'Sign-out not confirmed' : 'Signing out…'}</h1>
      <p role="status">
        {failed
          ? 'Your session may still be active. Check your connection and retry sign-out.'
          : 'Revoking your session.'}
      </p>
      {failed ? (
        <Button disabled={pending} onClick={() => void signOut()}>
          Retry sign-out
        </Button>
      ) : null}
    </main>
  );
}
