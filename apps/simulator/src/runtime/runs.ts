import {
  type MerchantProfile,
  merchantProfile,
  merchantProfiles,
} from '@luma/simulator-commerce';
import type { ChaosProfile } from '@luma/simulator-core';
import type { PoolClient } from 'pg';

import type { EngineState, HealthWindow } from '../engine/world.js';

/** A run's row in `sim_runs`. */
export interface RunRecord {
  id: string;
  seed: number;
  profileName: string;
  profile: MerchantProfile;
  chaos: ChaosProfile;
  status: 'provisioning' | 'ready' | 'failed';
  progress: { step: string; done: number; total: number } | null;
  error: string | null;
  /** Simulation time in epoch milliseconds. */
  now: number;
  running: boolean;
  speed: number;
  /** Real time of the last clock update. */
  wallAt: number;
  health: Record<string, HealthWindow>;
  state: EngineState & { startedAt: number; startRunning?: boolean };
  createdAt: number;
}

interface Row {
  id: string;
  seed: string;
  profile_name: string;
  /** Runs stored before profiles had a region lack `company`, `currency` and taxes. */
  profile:
    | MerchantProfile
    | { company?: undefined; erp?: MerchantProfile['erp'] | undefined };
  chaos: ChaosProfile;
  status: RunRecord['status'];
  progress: RunRecord['progress'];
  error: string | null;
  now: string;
  running: boolean;
  speed: number;
  wall_at: string;
  health: RunRecord['health'];
  state: RunRecord['state'];
  created_at: string;
}

/**
 * A stored run's profile. Runs created before profiles carried their region stored a preset
 * with its ERP; those presets generate the same world today, so the current preset replaces
 * them.
 */
function storedProfile(row: Row): MerchantProfile {
  if (row.profile.company) return row.profile;
  if (!Object.hasOwn(merchantProfiles, row.profile_name))
    throw new Error(`Run ${row.id} uses unknown profile ${row.profile_name}`);
  const profile = merchantProfile(
    row.profile_name as keyof typeof merchantProfiles,
  );

  return { ...profile, erp: row.profile.erp ?? 'jtl' };
}

const fromRow = (row: Row): RunRecord => ({
  id: row.id,
  seed: Number(row.seed),
  profileName: row.profile_name,
  profile: storedProfile(row),
  chaos: row.chaos,
  status: row.status,
  progress: row.progress,
  error: row.error,
  now: Number(row.now),
  running: row.running,
  speed: row.speed,
  wallAt: Number(row.wall_at),
  health: row.health,
  state: row.state,
  createdAt: Number(row.created_at),
});

type Queryable = Pick<PoolClient, 'query'>;

/** Reads one run; `lock` takes its row lock for the rest of the transaction. */
export async function readRun(db: Queryable, id: string, lock = false) {
  const { rows } = await db.query<Row>(
    `SELECT * FROM sim_runs WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );

  return rows[0] ? fromRow(rows[0]) : undefined;
}

/** Lists runs in creation order. */
export async function listRuns(db: Queryable) {
  const { rows } = await db.query<Row>(
    'SELECT * FROM sim_runs ORDER BY created_at, id',
  );

  return rows.map(fromRow);
}

/** Inserts a new run; rejects an existing ID. */
export async function insertRun(db: Queryable, run: RunRecord) {
  const { rowCount } = await db.query(
    `INSERT INTO sim_runs (id, seed, profile_name, profile, chaos, status, progress, error, now,
       running, speed, wall_at, health, state, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (id) DO NOTHING`,
    [
      run.id,
      run.seed,
      run.profileName,
      run.profile,
      run.chaos,
      run.status,
      run.progress,
      run.error,
      run.now,
      run.running,
      run.speed,
      run.wallAt,
      run.health,
      run.state,
      run.createdAt,
    ],
  );
  if (!rowCount) throw new Error('Run already exists');
}

/** Saves a run's mutable fields. */
export async function saveRun(db: Queryable, run: RunRecord) {
  await db.query(
    `UPDATE sim_runs SET chaos = $2, status = $3, progress = $4, error = $5, now = $6,
       running = $7, speed = $8, wall_at = $9, health = $10, state = $11
     WHERE id = $1`,
    [
      run.id,
      run.chaos,
      run.status,
      run.progress,
      run.error,
      run.now,
      run.running,
      run.speed,
      run.wallAt,
      run.health,
      run.state,
    ],
  );
}

/** Updates provisioning progress outside the provisioning transaction, so readers see it. */
export async function saveProgress(
  db: Queryable,
  id: string,
  progress: RunRecord['progress'],
) {
  await db.query('UPDATE sim_runs SET progress = $2 WHERE id = $1', [
    id,
    progress,
  ]);
}

/** Simulation time a running clock has reached at real time `wall`, without advancing it. */
export function currentTime(run: RunRecord, wall = Date.now()) {
  return run.running && run.status === 'ready'
    ? run.now + Math.max(0, wall - run.wallAt) * run.speed
    : run.now;
}
