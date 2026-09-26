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

export type DeliveryState = 'queued' | 'sent' | 'failed' | 'cancelled';

export interface WorkspaceInvitation {
  id: string;
  email: string;
  role: 'admin' | 'member';
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
