import { writeFile } from 'node:fs/promises';

import { createSecretCipher } from '@luma/connections/composition';
import { Pool } from 'pg';

const [command, app, eventKey, argument] = process.argv.slice(2);
if (
  !['list', 'export', 'complete'].includes(command) ||
  !app ||
  (command !== 'list' && (!/^[a-f0-9]{64}$/.test(eventKey ?? '') || !argument))
) {
  throw new Error(
    'Usage: privacy.mjs list <environment:clientId> | export <app> <event-key> <private-file> | complete <app> <event-key> <evidence-reference>',
  );
}
if (!process.env.SHOPIFY_PRIVACY_DATABASE_URL)
  throw new Error(
    'Set SHOPIFY_PRIVACY_DATABASE_URL to an authorized operator database connection',
  );
const pool = new Pool({
  connectionString: process.env.SHOPIFY_PRIVACY_DATABASE_URL,
});
try {
  if (command === 'list') {
    const result = await pool.query(
      'SELECT event_key,topic,received_at,due_at,due_at < now() AS overdue FROM shopify_privacy_requests WHERE app=$1 AND completed_at IS NULL ORDER BY due_at',
      [app],
    );
    console.log(JSON.stringify(result.rows, null, 2));
  } else if (command === 'export') {
    const result = await pool.query(
      'SELECT topic,payload FROM shopify_privacy_requests WHERE app=$1 AND event_key=$2 AND completed_at IS NULL',
      [app, eventKey],
    );
    if (!result.rows[0]) throw new Error('Pending request not found');
    const keys = new Map(
      Object.entries(JSON.parse(process.env.CONNECTIONS_KEYS ?? '{}')).map(
        ([id, value]) => [id, Buffer.from(value, 'base64')],
      ),
    );
    const cipher = createSecretCipher(
      process.env.CONNECTIONS_ACTIVE_KEY_ID,
      keys,
    );
    const decrypted = cipher.open(
      result.rows[0].payload,
      JSON.stringify(['shopify-privacy', app, eventKey]),
    );
    await writeFile(
      argument,
      JSON.stringify(
        { topic: result.rows[0].topic, request: decrypted.request },
        null,
        2,
      ),
      { mode: 0o600, flag: 'wx' },
    );
    console.log(
      'Request exported to the private file. Fulfillment is still pending.',
    );
  } else {
    if (!argument.trim() || argument.length > 1000)
      throw new Error(
        'Provide a completion evidence reference (maximum 1000 characters)',
      );
    const result = await pool.query(
      'UPDATE shopify_privacy_requests SET completed_at=now(),payload=NULL,evidence=$3 WHERE app=$1 AND event_key=$2 AND completed_at IS NULL',
      [app, eventKey, argument],
    );
    if (!result.rowCount) throw new Error('Pending request not found');
    console.log('Completion recorded; encrypted request erased.');
  }
} finally {
  await pool.end();
}
