import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../api';
import { toWallTime } from '../biometrics/time';
import { mediaStreamRegistry } from '../biometrics/mediaStreamRegistry';

export interface RecordingState {
  isActive: boolean;
  isUploading: boolean;
  segmentId: string | null;
  startWallTime: Date | null;
  wallClockOffset: number;
  error: string | null;
}

/**
 * Webcam recorder that streams to MinIO via S3 multipart upload (Q3).
 *
 * The browser captures 1-second media chunks via `MediaRecorder.start(1000)`
 * and accumulates them in a small buffer. Once the buffer crosses
 * `PART_FLUSH_BYTES` (5 MB — the S3 multipart minimum-part-size), it's
 * uploaded as a single Part to a presigned URL. The buffer is then
 * cleared and we keep going.
 *
 * Effect:
 *   • No 50 MB segment cap, no in-memory full-blob accumulation.
 *   • Memory ceiling per recording is ~5–10 MB regardless of session
 *     length (one buffer's worth between flushes).
 *   • Crash bound is the buffer-since-last-part — typically ≤2-3 minutes
 *     of footage. Anything older is durable in MinIO immediately after
 *     each part upload completes.
 *   • The media file in MinIO is finalised by `CompleteMultipartUpload`
 *     when the recorder stops cleanly. On a hard tab close we still
 *     fire-and-forget a complete-multipart with whatever parts we
 *     successfully uploaded; the trailing buffer (~5 MB max) is lost.
 */

// Minimum is technically what S3 spec says (5 MiB except the last part).
// We round to 5 MB for simplicity; final part may be smaller.
const PART_FLUSH_BYTES = 5 * 1024 * 1024;
// Hard ceiling on a single MediaRecorder run, just so a misconfigured
// browser doesn't accidentally accumulate forever. Multipart uploads
// support up to 10 000 parts × 5 GB → effectively unlimited; this bound
// is for sanity, not correctness.
const HARD_CEILING_PARTS = 9_900;

function getPreferredMimeType(): string {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const mt of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mt)) return mt;
  }
  return 'video/webm';
}

interface UploadedPart {
  partNumber: number;
  etag: string;
  sizeBytes: number;
}

export function useWebcamRecording(
  courseId: string,
  sessionId: string,
  wallClockOffset: number,
  isEnabled: boolean,
  hasConsent: boolean,
  onRecordingActiveChange?: (active: boolean) => void,
): RecordingState {
  const [isActive, setIsActive] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [segmentId, setSegmentId] = useState<string | null>(null);
  const [startWallTime, setStartWallTime] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const segmentIndexRef = useRef(0);
  const segmentIdRef = useRef<string | null>(null);
  const segmentStartTimeRef = useRef<number>(0);
  const mimeTypeRef = useRef<string>('video/webm');

  // Multipart state.
  const partBufferRef = useRef<Blob[]>([]);
  const partBufferBytesRef = useRef(0);
  const partsRef = useRef<UploadedPart[]>([]);
  const nextPartNumberRef = useRef(1);
  // Serialize part uploads to keep PartNumber order stable. MediaRecorder
  // can fire `dataavailable` faster than the network finishes a PUT, so
  // we chain part flushes through a single promise.
  const flushChainRef = useRef<Promise<void>>(Promise.resolve());

  const toWall = useCallback(
    (perfNow: number) => toWallTime(wallClockOffset)(perfNow),
    [wallClockOffset],
  );

  // ─── Part flush ───────────────────────────────────────────────────────

  const flushPart = useCallback(async (final: boolean): Promise<void> => {
    const sid = segmentIdRef.current;
    if (!sid) return;
    if (partBufferRef.current.length === 0) return;
    if (!final && partBufferBytesRef.current < PART_FLUSH_BYTES) return;

    // Splice the buffer into a single blob; reset state for next part.
    const partNumber = nextPartNumberRef.current;
    nextPartNumberRef.current = partNumber + 1;
    if (partNumber > HARD_CEILING_PARTS) {
      // Should never hit in normal use — multipart caps at 10000 parts.
      // Stop accepting new chunks; the recorder stop path will finalize
      // whatever's already uploaded.
      console.warn('[Recording] Hit multipart part-count ceiling; refusing new parts');
      return;
    }
    const chunks = partBufferRef.current;
    const bytes = partBufferBytesRef.current;
    partBufferRef.current = [];
    partBufferBytesRef.current = 0;
    const blob = new Blob(chunks, { type: mimeTypeRef.current });

    setIsUploading(true);
    try {
      // 1. Get a presigned UploadPart URL.
      const { uploadUrl } = await api.post<{ uploadUrl: string }>(
        `/recording/segments/${sid}/part-url`,
        { partNumber },
      );

      // 2. PUT the part directly to MinIO.
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        body: blob,
        // No Content-Type header — multipart UploadPart doesn't require it
        // and setting it can break the signed URL on some MinIO versions.
      });
      if (!res.ok) {
        throw new Error(`UploadPart returned ${res.status} ${res.statusText}`);
      }
      const etag = res.headers.get('etag') || res.headers.get('ETag');
      if (!etag) {
        // MinIO normally returns ETag; if it doesn't (CORS or weird
        // proxy), we have to abort because CompleteMultipartUpload
        // requires the ETag. Surface as a recording error.
        throw new Error('UploadPart response missing ETag header');
      }
      partsRef.current.push({
        partNumber,
        etag: etag.replace(/^"|"$/g, ''),
        sizeBytes: bytes,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Part upload failed';
      console.error('[Recording] Part upload failed:', msg, err);
      setError(msg);
      throw err;
    } finally {
      setIsUploading(false);
    }
  }, []);

  // Wraps flushPart so concurrent calls serialize, and so a queued
  // flush doesn't interleave with another caller's flush.
  const queueFlush = useCallback(
    (final: boolean): Promise<void> => {
      const next = flushChainRef.current.then(() => flushPart(final).catch(() => {}));
      flushChainRef.current = next;
      return next;
    },
    [flushPart],
  );

  // ─── Recorder lifecycle ───────────────────────────────────────────────

  const startRecording = useCallback(async () => {
    if (!isEnabled || !hasConsent || !courseId || !sessionId) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, frameRate: 15 },
        audio: false,
      });
      streamRef.current = stream;
      mediaStreamRegistry.register('recording', stream);

      const mimeType = getPreferredMimeType();
      mimeTypeRef.current = mimeType;
      const startWall = toWall(performance.now());

      // Reset multipart state for the new segment.
      partBufferRef.current = [];
      partBufferBytesRef.current = 0;
      partsRef.current = [];
      nextPartNumberRef.current = 1;
      flushChainRef.current = Promise.resolve();

      // Initiate multipart upload server-side.
      const { segmentId: sid } = await api.post<{
        segmentId: string;
        uploadId: string;
        minioKey: string;
      }>('/recording/segments/initiate-multipart', {
        sessionId,
        courseId,
        startWallTime: startWall,
        segmentIndex: segmentIndexRef.current,
        mimeType,
      });

      segmentIdRef.current = sid;
      setSegmentId(sid);
      setStartWallTime(new Date(startWall));
      segmentStartTimeRef.current = Date.now();

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size === 0) return;
        partBufferRef.current.push(e.data);
        partBufferBytesRef.current += e.data.size;
        if (partBufferBytesRef.current >= PART_FLUSH_BYTES) {
          // Flush — non-final.
          void queueFlush(false);
        }
      };

      recorder.onstop = async () => {
        const sidAtStop = segmentIdRef.current;
        const startTime = segmentStartTimeRef.current;
        if (!sidAtStop) return;

        // Drain whatever's still in the buffer as the final part.
        try {
          await queueFlush(true);
        } catch {
          // The flush already logged; we still want to attempt complete
          // with whatever parts succeeded.
        }
        // Wait for any in-flight flush to settle.
        try {
          await flushChainRef.current;
        } catch {
          /* swallowed */
        }

        const parts = partsRef.current;
        if (parts.length === 0) {
          // No parts uploaded — abort and bail. This happens if the
          // recorder stopped before the first 5 MB chunk landed.
          try {
            await api.post(`/recording/segments/${sidAtStop}/abort-multipart`, {
              error: 'No parts uploaded before stop',
            });
          } catch {
            /* best effort */
          }
        } else {
          try {
            await api.post(`/recording/segments/${sidAtStop}/complete-multipart`, {
              parts,
              endWallTime: new Date().toISOString(),
              durationMs: Date.now() - startTime,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Complete failed';
            console.error('[Recording] complete-multipart failed:', msg, err);
            setError(msg);
            try {
              await api.post(`/recording/segments/${sidAtStop}/abort-multipart`, {
                error: msg,
              });
            } catch {
              /* best effort */
            }
          }
        }

        // If this was an auto-rotate (e.g. visibilitychange came back),
        // start a fresh segment.
        if (streamRef.current?.active) {
          segmentIndexRef.current += 1;
          startRecording();
        }
      };

      recorder.start(1000); // 1-second time slices
      setIsActive(true);
      setError(null);
      onRecordingActiveChange?.(true);
      console.log('[Recording] Started multipart segment', sid);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start recording';
      console.error('[Recording] Start failed:', err);
      setError(msg);
      setIsActive(false);
      onRecordingActiveChange?.(false);
    }
  }, [courseId, sessionId, isEnabled, hasConsent, toWall, queueFlush, onRecordingActiveChange]);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    mediaStreamRegistry.unregister('recording');
    setIsActive(false);
    onRecordingActiveChange?.(false);
  }, [onRecordingActiveChange]);

  // Start recording on mount if enabled + consent.
  useEffect(() => {
    if (isEnabled && hasConsent) {
      startRecording();
    }
    return () => {
      stopRecording();
    };
  }, [isEnabled, hasConsent]); // eslint-disable-line react-hooks/exhaustive-deps

  // Visibility / unload handlers.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stopRecording();
      } else if (isEnabled && hasConsent) {
        startRecording();
      }
    };

    const handleBeforeUnload = () => {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        // Synchronously stop the recorder so onstop fires; the async
        // complete-multipart inside onstop runs as a keepalive fetch.
        recorder.stop();
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());

      const sid = segmentIdRef.current;
      if (sid && partsRef.current.length > 0) {
        const token = localStorage.getItem('token');
        // Best-effort completion using whatever parts we've already
        // successfully uploaded. The trailing buffer (≤5 MB) is lost
        // — that's the bounded crash window the multipart design
        // exists to keep small.
        fetch(`/api/recording/segments/${sid}/complete-multipart`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            parts: partsRef.current,
            endWallTime: new Date().toISOString(),
            durationMs: Date.now() - segmentStartTimeRef.current,
          }),
          keepalive: true,
        }).catch(() => {});
      } else if (sid) {
        // Nothing uploaded yet; abort to clean up the MinIO multipart.
        const token = localStorage.getItem('token');
        fetch(`/api/recording/segments/${sid}/abort-multipart`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ error: 'unload before first part' }),
          keepalive: true,
        }).catch(() => {});
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handleBeforeUnload);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handleBeforeUnload);
    };
  }, [isEnabled, hasConsent, startRecording, stopRecording]);

  return {
    isActive,
    isUploading,
    segmentId,
    startWallTime,
    wallClockOffset,
    error,
  };
}
