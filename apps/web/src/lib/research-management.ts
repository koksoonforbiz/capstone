import { api } from './api';

/**
 * Stage-6 mutation API client for the retrospective tracing teacher portal.
 * Thin wrapper around `api.*` so callers don't have to remember the URLs.
 */

export type AuditEntry = {
  id: string;
  action: string;
  actor: { id: string; name: string } | null;
  payload: unknown;
  createdAt: string;
};

export type ExportFile = {
  modality: string;
  key: string;
  signedUrl: string;
  rowCount: number;
  format: 'csv' | 'jsonl';
};

export type ExportManifest = {
  exportId: string;
  episodeId: string;
  format: 'csv' | 'jsonl';
  modalities: string[];
  includeVideo: boolean;
  createdAt: string;
  createdBy: { id: string; name: string | null };
  files: ExportFile[];
  videoManifestKey?: string;
  videoManifestSignedUrl?: string;
};

export type ExportSummary = {
  exportId: string;
  createdAt: string;
  format: 'csv' | 'jsonl';
  modalities: string[];
  includeVideo: boolean;
  fileCount: number;
  manifestSignedUrl: string;
};

export const researchMgmt = {
  merge: (input: { episodeIds: string[]; primaryId?: string; reason?: string }) =>
    api.post<{ episodeId: string }>('/research/episodes/merge', input),

  split: (episodeId: string, input: { splitAtSessionId: string; reason?: string }) =>
    api.post<{ primaryId: string; newEpisodeId: string }>(
      `/research/episodes/${episodeId}/split`,
      input,
    ),

  detachSession: (
    episodeId: string,
    input: { sessionId: string; targetEpisodeId?: string; reason?: string },
  ) =>
    api.post<{ sourceEpisodeId: string; targetEpisodeId: string }>(
      `/research/episodes/${episodeId}/detach-session`,
      input,
    ),

  annotate: (episodeId: string, notes: string) =>
    api.post<{ id: string; notes: string }>(`/research/episodes/${episodeId}/annotate`, { notes }),

  getAudit: (episodeId: string) => api.get<AuditEntry[]>(`/research/episodes/${episodeId}/audit`),

  createExport: (
    episodeId: string,
    input: { modalities: string[]; format: 'csv' | 'jsonl'; includeVideo: boolean },
  ) => api.post<ExportManifest>(`/research/episodes/${episodeId}/export`, input),

  listExports: (episodeId: string) =>
    api.get<ExportSummary[]>(`/research/episodes/${episodeId}/exports`),
};

/** Human-readable summary of an audit row's payload. */
export function summarizeAudit(entry: AuditEntry): string {
  const p = (entry.payload ?? {}) as Record<string, unknown>;
  switch (entry.action) {
    case 'created':
      return 'Episode created';
    case 'merged': {
      const sources = Array.isArray(p.mergedFromIds) ? p.mergedFromIds.length : 0;
      const sessions = Array.isArray(p.sessionIds) ? p.sessionIds.length : 0;
      const reason = typeof p.reason === 'string' && p.reason ? ` — ${p.reason}` : '';
      return `Merged from ${sources} episode${sources === 1 ? '' : 's'} containing ${sessions} session${sessions === 1 ? '' : 's'}${reason}`;
    }
    case 'merged_into': {
      const target = typeof p.targetEpisodeId === 'string' ? p.targetEpisodeId.slice(0, 8) : '?';
      return `Merged into ${target}`;
    }
    case 'split': {
      const target = typeof p.newEpisodeId === 'string' ? p.newEpisodeId.slice(0, 8) : '?';
      const moved = Array.isArray(p.movedSessionIds) ? p.movedSessionIds.length : 0;
      const reason = typeof p.reason === 'string' && p.reason ? ` — ${p.reason}` : '';
      return `Split off ${moved} session${moved === 1 ? '' : 's'} into new episode ${target}${reason}`;
    }
    case 'created_from_split': {
      const source = typeof p.sourceEpisodeId === 'string' ? p.sourceEpisodeId.slice(0, 8) : '?';
      return `Created by split from ${source}`;
    }
    case 'session_attached': {
      const sid = typeof p.sessionId === 'string' ? p.sessionId.slice(0, 8) : '?';
      const src = typeof p.sourceEpisodeId === 'string' ? p.sourceEpisodeId.slice(0, 8) : '?';
      return `Attached session ${sid} from ${src}`;
    }
    case 'session_detached': {
      const sid = typeof p.sessionId === 'string' ? p.sessionId.slice(0, 8) : '?';
      const tgt = typeof p.targetEpisodeId === 'string' ? p.targetEpisodeId.slice(0, 8) : '?';
      return `Detached session ${sid} → ${tgt}`;
    }
    case 'annotated': {
      const len = typeof p.length === 'number' ? p.length : 0;
      return `Notes updated (${len} chars)`;
    }
    default:
      return entry.action;
  }
}
