import { randomUUID } from 'node:crypto';

import { createIdentity } from '@luma/identity/composition';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { assertCellRegion } from '../cell-region.js';
import { createMigratedDatabase } from '../test-support/database.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  'regional identity and immutable cell placement',
  () => {
    it.each(['AU', 'EU'] as const)(
      'provisions %s, rejects mismatch and records signup choice before workspace creation',
      async (region) => {
        const database = await createMigratedDatabase(databaseUrl!, region);
        const other = region === 'AU' ? 'EU' : 'AU';
        const login = `region_${randomUUID().replaceAll('-', '')}`;
        const password = randomUUID();
        const connection = new URL(databaseUrl!);
        const databaseName = (
          await database.owner.query<{ name: string }>(
            'SELECT current_database() AS name',
          )
        ).rows[0]!.name;
        connection.pathname = `/${databaseName}`;
        const origin = 'https://au.app.example.test';
        let identity: ReturnType<typeof createIdentity> | undefined;
        let runtime: Pool | undefined;
        try {
          await database.owner.query(
            `CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
          );
          await database.owner.query(`GRANT luma_identity TO "${login}"`);
          connection.username = login;
          connection.password = password;
          runtime = new Pool({ connectionString: connection.toString() });
          await expect(
            assertCellRegion(runtime, region),
          ).resolves.toBeUndefined();
          await expect(assertCellRegion(runtime, other)).rejects.toThrow(
            'LUMA_REGION',
          );
          await expect(
            runtime.query('UPDATE luma_cell_region SET region=$1', [other]),
          ).rejects.toMatchObject({ code: '42501' });
          await expect(
            runtime.query('SELECT luma_provision_cell_region($1)', [other]),
          ).rejects.toMatchObject({ code: '42501' });
          await expect(
            database.owner.query('UPDATE luma_cell_region SET region=$1', [
              other,
            ]),
          ).rejects.toMatchObject({ code: '55000' });
          identity = createIdentity({
            databaseUrl: connection.toString(),
            secret: 'regional-identity-test-secret-at-least-32-characters',
            baseURL: origin,
            trustedOrigins: [origin],
            passkeyRpId: 'app.example.test',
            region,
            enabledRegions: [region],
          });
          const signup = (dataRegion: string | undefined) =>
            identity!.handler(
              new Request(`${origin}/auth/sign-up/email`, {
                method: 'POST',
                headers: { origin, 'content-type': 'application/json' },
                body: JSON.stringify({
                  name: 'Regional owner',
                  email: 'owner@example.test',
                  password: 'a-long-regional-password',
                  ...(dataRegion ? { dataRegion } : {}),
                }),
              }),
            );
          expect((await signup(undefined)).status).toBe(422);
          expect((await signup(other)).status).toBe(422);
          expect(
            (await database.owner.query('SELECT id FROM users')).rowCount,
          ).toBe(0);
          const registered = await signup(region);
          expect(registered.status, await registered.clone().text()).toBe(200);
          expect(registered.headers.getSetCookie()).toEqual([]);
          // The emailed confirmation link would set this before the first sign-in.
          await database.owner.query(
            "UPDATE users SET email_verified=true WHERE email='owner@example.test'",
          );
          const signedIn = await identity.handler(
            new Request(`${origin}/auth/sign-in/email`, {
              method: 'POST',
              headers: { origin, 'content-type': 'application/json' },
              body: JSON.stringify({
                email: 'owner@example.test',
                password: 'a-long-regional-password',
              }),
            }),
          );
          expect(signedIn.status, await signedIn.clone().text()).toBe(200);
          const cookies = signedIn.headers.getSetCookie();
          expect(cookies.length).toBeGreaterThan(0);
          for (const cookie of cookies) {
            expect(cookie).not.toMatch(/;\s*Domain=/i);
            expect(cookie).toMatch(/;\s*Secure/i);
          }
          const cookie = cookies.map((value) => value.split(';')[0]).join('; ');
          const evidence = await database.owner.query<{
            user_id: string;
            confirmed_by: string;
            region: string;
            confirmed_at: Date;
          }>(
            'SELECT user_id,confirmed_by,region,confirmed_at FROM signup_region_confirmations',
          );
          expect(evidence.rows).toHaveLength(1);
          expect(evidence.rows[0]).toMatchObject({
            region,
            confirmed_by: evidence.rows[0]!.user_id,
            confirmed_at: expect.any(Date),
          });
          const workspace = await identity.service.createOrganization(
            { cookie },
            {
              name: 'Regional workspace',
              slug: 'regional-workspace',
              dataRegion: region,
            },
          );
          expect(workspace.dataRegion).toBe(region);
          const context = await identity.service.resolveTenant(
            { cookie },
            workspace.id,
            'region-test',
          );
          expect(context.dataRegion).toBe(region);
          expect(await identity.settings.get(context)).toMatchObject({
            workspace: { dataRegion: region },
          });
          const refreshed = await Promise.all(
            Array.from({ length: 20 }, () =>
              identity!.service.refreshContext(context),
            ),
          );
          expect(refreshed.every((value) => value.dataRegion === region)).toBe(
            true,
          );
          await expect(
            runtime.query(
              'UPDATE organizations SET data_region=$1 WHERE id=$2',
              [other, workspace.id],
            ),
          ).rejects.toMatchObject({ code: '42501' });
          const options = await identity.handler(
            new Request(`${origin}/auth/passkey/generate-register-options`, {
              headers: { cookie, origin },
            }),
          );
          expect(options.status, await options.clone().text()).toBe(200);
          expect(await options.json()).toMatchObject({
            rp: { id: 'app.example.test' },
          });
          const foreignId = randomUUID();
          await database.owner.query(
            "INSERT INTO organizations(id,name,slug,data_region,status,created_at) VALUES($1,'Foreign','foreign',$2,'active',now())",
            [foreignId, other],
          );
          await expect(
            identity.service.resolveWorkflowContext(
              evidence.rows[0]!.user_id,
              foreignId,
              'foreign-region',
            ),
          ).rejects.toMatchObject({
            statusCode: 503,
            code: 'REGION_UNAVAILABLE',
          });
          const definitions = await database.owner.query<{
            definition: string;
          }>(
            "SELECT prosrc AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'",
          );
          expect(
            definitions.rows.some((row) =>
              /data_region\s*=\s*'EU'/.test(row.definition),
            ),
          ).toBe(false);
          await database.owner.query(
            "INSERT INTO users(id,name,email,email_verified,created_at,updated_at) SELECT gen_random_uuid(),'Directory person',n||'@directory.example.test',true,now(),now() FROM generate_series(1,10000)n",
          );
          await database.owner.query('VACUUM ANALYZE users');
          const plan = await database.owner.query<{ 'QUERY PLAN': string }>(
            "EXPLAIN SELECT id FROM users WHERE email ILIKE '%937@directory%'",
          );
          expect(
            plan.rows.map((row) => row['QUERY PLAN']).join('\n'),
          ).toContain('users_staff_email_trgm');
        } finally {
          await identity?.close();
          await runtime?.end();
          await database.drop();
          const admin = new Pool({ connectionString: databaseUrl });
          await admin.query(`DROP ROLE IF EXISTS "${login}"`);
          await admin.end();
        }
      },
      60_000,
    );
  },
);
