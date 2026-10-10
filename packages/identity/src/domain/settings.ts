import type { RoleReference } from './roles.js';

export interface WorkspaceSettings {
  name: string;
  slug: string;
  dataRegion: string;
  timezone: string;
  revision: number;
  alwaysRequireApproval: boolean;
  policyRevision: number;
}

export interface NotificationPreferences {
  issues: boolean;
  connections: boolean;
  revision: number;
}

/** One module on a member's Home, in display order. */
export interface HomeModule {
  id: string;
  size: 'half' | 'full';
}

/** A workspace page pinned to a member's sidebar. */
export interface PinnedPage {
  path: string;
  label: string;
}

/** A member's personal arrangement of one workspace. */
export interface WorkspaceLayout {
  /** Null means the member uses the default Home. */
  home: HomeModule[] | null;
  pinned: PinnedPage[];
  revision: number;
}

export type DeliveryState = 'queued' | 'sent' | 'failed' | 'cancelled';

export interface WorkspaceInvitation {
  id: string;
  email: string;
  role: RoleReference & { archived: boolean };
  status: 'pending' | 'expired' | 'accepted' | 'revoked';
  expiresAt: string;
  createdAt: string;
  delivery: DeliveryState;
  generation: number;
}

export interface SettingsSnapshot {
  workspace: WorkspaceSettings;
  preferences: NotificationPreferences;
  deliveryAvailable: boolean;
  lastTest: { id: string; state: DeliveryState } | null;
}

/** How long Luma support access lasts once allowed, in hours. */
export type SupportAccessDuration = 24 | 72 | 168;

/** A pending request from Luma support to allow access. */
export interface SupportAccessRequest {
  id: string;
  reason: string;
  durationHours: SupportAccessDuration;
  requestedAt: string;
  expiresAt: string;
}

/** Whether, and until when, Luma support may open read-only views of the workspace. */
export interface SupportAccess {
  allowedUntil: string | null;
  changedAt: string | null;
  revision: number;
  requests: SupportAccessRequest[];
}
