import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../api';
import { mediaStreamRegistry } from '../biometrics/mediaStreamRegistry';

/**
 * Load WebGazer.js dynamically via script tag.
 * Falls back gracefully if the script cannot be loaded.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadWebgazerScript(): Promise<any | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((window as any).webgazer) return Promise.resolve((window as any).webgazer);

  return new Promise((resolve) => {
    const existing = document.querySelector('script[data-webgazer]');
    if (existing) {
      existing.addEventListener('load', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        resolve((window as any).webgazer ?? null);
      });
      existing.addEventListener('error', () => resolve(null));
      return;
    }

    const script = document.createElement('script');
    script.src = '/webgazer.js';
    script.setAttribute('data-webgazer', 'true');
    script.async = true;
    script.onload = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolve((window as any).webgazer ?? null);
    };
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
}

interface WebgazerConfig {
  isEnabled: boolean;
  calibrationOnNewSession: boolean;
  inactivityTimeoutSecs: number;
  recalibrationEnabled: boolean;
}

interface GazeReading {
  timestamp: string;
  gazeX: number;
  gazeY: number;
  confidence: number | null;
  pageUrl: string;
}

export function useWebgazer(
  courseId: string,
  sessionId: string,
  wallClockOffset: number,
): {
  isActive: boolean;
  isCalibrating: boolean;
  needsCalibration: boolean;
  faceDetected: boolean;
  triggerCalibration: () => void;
  completeCalibration: () => void;
  skipCalibration: () => void;
  trainOnPoint: (screenX: number, screenY: number) => void;
  getCurrentPrediction: () => Promise<{ x: number; y: number } | null>;
  latestGaze: { x: number; y: number } | null;
  config: WebgazerConfig | null;
} {
  const [isActive, setIsActive] = useState(false);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [needsCalibration, setNeedsCalibration] = useState(false);
  const [faceDetected, setFaceDetected] = useState(false);
  const [latestGaze, setLatestGaze] = useState<{ x: number; y: number } | null>(null);
  const [config, setConfig] = useState<WebgazerConfig | null>(null);

  const bufferRef = useRef<GazeReading[]>([]);
  const flushIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastGazeTimeRef = useRef(0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webgazerRef = useRef<any>(null);

  const toWallTime = useCallback(
    (perfNow: number) => new Date(perfNow + wallClockOffset).toISOString(),
    [wallClockOffset],
  );

  const flushBuffer = useCallback(async () => {
    const readings = bufferRef.current.splice(0, bufferRef.current.length);
    if (readings.length === 0) return;
    try {
      await api.post('/webgazer/logs', { sessionId, courseId, readings });
      console.log('[WebGazer] Flushed', readings.length, 'gaze readings');
    } catch (err) {
      console.error('[WebGazer] Flush failed:', err);
      bufferRef.current.unshift(...readings);
    }
  }, [sessionId, courseId]);

  const resetInactivityTimer = useCallback(() => {
    if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    if (!config?.recalibrationEnabled) return;

    inactivityTimerRef.current = setTimeout(
      () => {
        setNeedsCalibration(true);
      },
      (config?.inactivityTimeoutSecs ?? 300) * 1000,
    );
  }, [config]);

  const triggerCalibration = useCallback(() => {
    setIsCalibrating(true);
    setNeedsCalibration(false);
  }, []);

  const completeCalibration = useCallback(() => {
    setIsCalibrating(false);
    setNeedsCalibration(false);
  }, []);

  const skipCalibration = useCallback(() => {
    setIsCalibrating(false);
    setNeedsCalibration(false);
  }, []);

  const trainOnPoint = useCallback((screenX: number, screenY: number) => {
    try {
      webgazerRef.current?.recordScreenPosition(screenX, screenY, 'click');
    } catch {
      // WebGazer may not be ready yet
    }
  }, []);

  const getCurrentPrediction = useCallback(
    (): Promise<{ x: number; y: number } | null> =>
      new Promise((resolve) => {
        try {
          const wg = webgazerRef.current;
          if (!wg) return resolve(null);
          wg.getCurrentPrediction()
            .then((pred: { x: number; y: number } | null) => resolve(pred))
            .catch(() => resolve(null));
        } catch {
          resolve(null);
        }
      }),
    [],
  );

  useEffect(() => {
    if (!courseId || !sessionId) return;

    let cancelled = false;

    async function start() {
      try {
        const cfg = await api.get<WebgazerConfig>(`/webgazer/config/${courseId}`);
        console.log('[WebGazer] Config loaded:', cfg);
        if (!cfg.isEnabled || cancelled) return;
        setConfig(cfg);

        const loadedWg = await loadWebgazerScript();
        if (!loadedWg || cancelled) return;
        webgazerRef.current = loadedWg;

        const wg = webgazerRef.current;

        // Initialize WebGazer following the reference implementation:
        // Chain all config calls BEFORE .begin(), use 'TFFacemesh' tracker
        await wg
          .setRegression('ridge')
          .setTracker('TFFacemesh')
          .showVideo(false)
          .showFaceOverlay(false)
          .showFaceFeedbackBox(false)
          .saveDataAcrossSessions(false)
          .begin();

        if (cancelled) {
          wg.end();
          return;
        }

        // Force-hide any WebGazer DOM elements it may have created
        wg.showVideo(false);

        console.log('[WebGazer] Initialized successfully');

        // Try to register WebGazer's internal video stream for the preview window
        try {
          const videoFeed = document.getElementById('webgazerVideoFeed') as HTMLVideoElement | null;
          const stream = videoFeed?.srcObject as MediaStream | null;
          if (stream) {
            mediaStreamRegistry.register('webgazer', stream);
            console.log('[WebGazer] Registered video stream');
          }
        } catch {
          // Video element may not exist
        }

        // Remove WebGazer's video container from the DOM entirely
        const wgContainer = document.getElementById('webgazerVideoContainer');
        if (wgContainer) wgContainer.remove();
        const wgGazeDot = document.getElementById('webgazerGazeDot');
        if (wgGazeDot) wgGazeDot.remove();

        // Gaze listener: data=null means no face detected
        wg.setGazeListener(
          (data: { x: number; y: number; confidence?: number } | null, _timestamp: number) => {
            if (!data) {
              setFaceDetected(false);
              return;
            }

            setFaceDetected(true);

            const now = performance.now();
            if (now - lastGazeTimeRef.current < 200) return;
            lastGazeTimeRef.current = now;

            setLatestGaze({ x: data.x, y: data.y });
            bufferRef.current.push({
              timestamp: toWallTime(now),
              gazeX: data.x,
              gazeY: data.y,
              confidence: data.confidence ?? null,
              pageUrl: window.location.pathname,
            });

            if (bufferRef.current.length >= 300) {
              flushBuffer();
            }
          },
        );

        setIsActive(true);
        console.log('[WebGazer] Active, calibrationOnNewSession:', cfg.calibrationOnNewSession);

        if (cfg.calibrationOnNewSession) {
          console.log('[WebGazer] Triggering calibration for new session');
          setNeedsCalibration(true);
        }

        flushIntervalRef.current = setInterval(flushBuffer, 30000);

        const resetTimer = () => resetInactivityTimer();
        for (const event of ['mousemove', 'keydown', 'scroll', 'click']) {
          document.addEventListener(event, resetTimer);
        }
        resetTimer();
      } catch (err) {
        console.error('[WebGazer] Initialization failed:', err);
        setIsActive(false);
      }
    }

    start();

    return () => {
      cancelled = true;
      if (flushIntervalRef.current) clearInterval(flushIntervalRef.current);
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
      flushBuffer();

      try {
        webgazerRef.current?.end();
      } catch {
        // WebGazer may throw on cleanup
      }
      mediaStreamRegistry.unregister('webgazer');
      setIsActive(false);
    };
  }, [courseId, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clean up on logout
  useEffect(() => {
    const handleLogout = () => {
      if (flushIntervalRef.current) clearInterval(flushIntervalRef.current);
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
      flushBuffer();
      try {
        webgazerRef.current?.end();
      } catch {
        // WebGazer may throw on cleanup
      }
      mediaStreamRegistry.unregister('webgazer');
      setIsActive(false);
    };
    window.addEventListener('ats:logout', handleLogout);
    return () => window.removeEventListener('ats:logout', handleLogout);
  }, [flushBuffer]);

  // sendBeacon on unload
  useEffect(() => {
    const handleUnload = () => {
      const readings = bufferRef.current.splice(0, bufferRef.current.length);
      if (readings.length > 0) {
        navigator.sendBeacon(
          '/api/webgazer/logs',
          new Blob([JSON.stringify({ sessionId, courseId, readings })], {
            type: 'application/json',
          }),
        );
      }
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, [sessionId, courseId]);

  return {
    isActive,
    isCalibrating,
    needsCalibration,
    faceDetected,
    triggerCalibration,
    completeCalibration,
    skipCalibration,
    trainOnPoint,
    getCurrentPrediction,
    latestGaze,
    config,
  };
}
