import { database, signup, startApi } from './helpers.mjs';

/** Creates an isolated procurement workspace using the production HTTP composition. */
export async function procurementFixture(t, origin) {
  const db = await database(t);
  await db.migrate();
  await db.owner.query(
    `GRANT luma_identity,luma_connectors,luma_case_reader,luma_desk TO "${new URL(db.runtimeUrl).username}"`,
  );
  const api = await startApi(t, db, origin);
  const owner = await signup(api, 'procurement-owner');
  const org = (
    await api.request('/v1/organizations', {
      cookie: owner.cookie,
      method: 'POST',
      status: 201,
      body: {
        name: 'Northstar Operations',
        slug: 'procurement',
        dataRegion: 'EU',
      },
    })
  ).body;

  return {
    db,
    api,
    owner,
    org,
    root: `/v1/organizations/${org.id}/procurement`,
  };
}
