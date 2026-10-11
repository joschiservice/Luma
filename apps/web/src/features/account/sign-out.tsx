import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { EntryFrame } from '../../kit/identity/common';
import { auth, clearPrivate } from '../../kit/identity/data';

/** Ends the session, clears private query data, and returns the user to sign-in. */
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
    <EntryFrame>
      <section className="status-panel">
        <h1>
          {failed
            ? m.identity_sign_out_failed_title()
            : m.identity_sign_out_pending_title()}
        </h1>
        <p role="status">
          {failed
            ? m.identity_sign_out_failed_body()
            : m.identity_sign_out_pending_body()}
        </p>
        {failed ? (
          <Button disabled={pending} onClick={() => void signOut()}>
            {m.identity_sign_out_retry()}
          </Button>
        ) : null}
      </section>
    </EntryFrame>
  );
}
