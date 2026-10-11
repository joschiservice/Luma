import type { InstalledConnection, SecretCipher } from '@luma/connections';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';

interface Row {
  tenant: string;
  document: InstalledConnection;
  secret: string | null;
}

/**
 * An in-memory stand-in for the tables Gmail authorization touches. Tenant scoping mimics row
 * level security: queries only see rows of the transaction's tenant.
 */
export function createFakeDatabase() {
  const connections = new Map<string, Row>();
  const states: {
    tenant: string;
    digest: string;
    actor: string;
    session: string;
    app: string;
    label: string;
    expires: Date;
  }[] = [];
  const bindings: { tenant: string; app: string; email: string; id: string }[] =
    [];
  const events: { event: string; status: string }[] = [];
  const queries: string[] = [];

  const database: TenantDatabase = {
    async transaction(tenant, operation) {
      const tx: SqlTransaction = {
        async query(sql: string, params: unknown[] = []) {
          queries.push(sql);
          const ok = <T>(rows: T[]) => ({ rows, rowCount: rows.length });
          if (
            sql.startsWith(
              'DELETE FROM gmail_oauth_states WHERE tenant_id=$1 AND (',
            )
          ) {
            for (let i = states.length - 1; i >= 0; i--)
              if (
                states[i]!.tenant === tenant &&
                (states[i]!.expires < new Date() ||
                  (states[i]!.actor === params[1] &&
                    states[i]!.session === params[2] &&
                    states[i]!.app === params[3]))
              )
                states.splice(i, 1);

            return ok([]);
          }
          if (sql.startsWith('INSERT INTO gmail_oauth_states')) {
            const [, digest, actor, session, app, label, , expires] =
              params as [
                string,
                string,
                string,
                string,
                string,
                string,
                string | null,
                Date,
              ];
            states.push({
              tenant,
              digest,
              actor,
              session,
              app,
              label,
              expires,
            });

            return ok([]);
          }
          if (
            sql.startsWith(
              'DELETE FROM gmail_oauth_states WHERE tenant_id=$1 AND digest',
            )
          ) {
            const index = states.findIndex(
              (s) =>
                s.tenant === tenant &&
                s.digest === params[1] &&
                s.actor === params[2] &&
                s.session === params[3] &&
                s.app === params[4] &&
                s.expires > (params[5] as Date),
            );
            if (index < 0) return ok([]);
            const [state] = states.splice(index, 1);

            return ok([{ label: state!.label }]);
          }
          if (sql.includes('FROM workspace_apps'))
            return ok([{ app_id: 'gmail' }]);
          if (sql.startsWith('INSERT INTO gmail_mailbox_bindings')) {
            if (
              !bindings.some(
                (b) => b.app === params[1] && b.email === params[2],
              )
            )
              bindings.push({
                tenant,
                app: params[1] as string,
                email: params[2] as string,
                id: params[3] as string,
              });

            return ok([]);
          }
          if (
            sql.startsWith('SELECT connection_id FROM gmail_mailbox_bindings')
          )
            return ok(
              bindings
                .filter(
                  (b) =>
                    b.tenant === tenant &&
                    b.app === params[1] &&
                    b.email === params[2],
                )
                .map((b) => ({ connection_id: b.id })),
            );
          if (
            sql.startsWith(
              'SELECT document FROM connector_installations WHERE tenant_id=$1 ORDER BY',
            )
          )
            return ok(
              [...connections.values()]
                .filter((r) => r.tenant === tenant)
                .map((r) => ({ document: structuredClone(r.document) })),
            );
          if (
            sql.startsWith(
              'SELECT document,secret FROM connector_installations',
            ) ||
            sql.startsWith(
              'SELECT document FROM connector_installations WHERE tenant_id=$1 AND id=$2',
            )
          ) {
            const row = connections.get(params[1] as string);

            return ok(
              row && row.tenant === tenant
                ? [
                    {
                      document: structuredClone(row.document),
                      secret: row.secret,
                    },
                  ]
                : [],
            );
          }
          if (sql.startsWith('INSERT INTO connector_installations')) {
            const [, id, , document, secret] = params as [
              string,
              string,
              number,
              InstalledConnection,
              string | null,
            ];
            if (connections.has(id)) return ok([]);
            connections.set(id, {
              tenant,
              document: structuredClone(document),
              secret,
            });

            return ok([{ id }]);
          }
          if (sql.startsWith('UPDATE connector_installations')) {
            const [, id, , document, secret, expected] = params as [
              string,
              string,
              number,
              InstalledConnection,
              string | null,
              number,
            ];
            const row = connections.get(id);
            if (
              !row ||
              row.tenant !== tenant ||
              row.document.version !== expected
            )
              return ok([]);
            connections.set(id, {
              tenant,
              document: structuredClone(document),
              secret,
            });

            return ok([{ id }]);
          }
          if (sql.startsWith('INSERT INTO connector_lifecycle_events')) {
            events.push({
              event: params[3] as string,
              status: params[5] as string,
            });

            return ok([]);
          }

          return ok([]);
        },
      } as SqlTransaction;

      return operation(tx);
    },
  };

  return { database, connections, states, bindings, events, queries };
}

/** A reversible stand-in for the connection cipher that still checks the binding. */
export const fakeCipher: SecretCipher = {
  seal: (value, binding) => JSON.stringify({ binding, value }),
  open: (sealed, binding) => {
    const parsed = JSON.parse(sealed) as { binding: string; value: unknown };
    if (parsed.binding !== binding) throw new Error('Binding mismatch');

    return parsed.value as ReturnType<SecretCipher['open']>;
  },
};
