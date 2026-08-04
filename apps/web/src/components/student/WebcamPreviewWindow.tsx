import { useState, useRef, useEffect, useCallback } from 'react';
import { Minimize2, Maximize2, X, Video } from 'lucide-react';
import { mediaStreamRegistry } from '../../lib/biometrics/mediaStreamRegistry';

interface WebcamPreviewWindowProps {
  faceDetected: boolean;
}

export function WebcamPreviewWindow({ faceDetected }: WebcamPreviewWindowProps) {
  const [isOpen, setIsOpen] = useState(true);
  const [isMinimized, setIsMinimized] = useState(false);
  const [hasStream, setHasStream] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null,
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 16, y: 64 });

  const attachStream = useCallback(() => {
    const stream =
      mediaStreamRegistry.get('webgazer') ??
      mediaStreamRegistry.get('recording') ??
      mediaStreamRegistry.get('pupil-size');
    if (stream && videoRef.current) {
      if (videoRef.current.srcObject !== stream) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      }
      setHasStream(true);
    } else {
      setHasStream(false);
      if (videoRef.current) videoRef.current.srcObject = null;
    }
  }, []);

  // Re-attach stream when component becomes visible
  useEffect(() => {
    if (!isOpen || isMinimized) return;
    const t = setTimeout(attachStream, 50);
    return () => clearTimeout(t);
  }, [isOpen, isMinimized, attachStream]);

  // Subscribe to stream registry changes
  useEffect(() => {
    attachStream();
    const unsub = mediaStreamRegistry.subscribe(attachStream);
    return unsub;
  }, [attachStream]);

  // Drag handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('button')) return;
      dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };

      const handleMouseMove = (e: MouseEvent) => {
        if (!dragRef.current) return;
        const dx = e.clientX - dragRef.current.startX;
        const dy = e.clientY - dragRef.current.startY;
        const newX = Math.max(0, Math.min(window.innerWidth - 200, dragRef.current.origX + dx));
        const newY = Math.max(0, Math.min(window.innerHeight - 40, dragRef.current.origY + dy));
        setPos({ x: newX, y: newY });
      };

      const handleMouseUp = () => {
        dragRef.current = null;
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [pos],
  );

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-4 left-4 z-[100] flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gray-800 text-white text-xs shadow-lg hover:bg-gray-700 transition-colors"
        title="Show webcam preview"
      >
        <Video size={14} />
        Preview
      </button>
    );
  }

  return (
    <div
      ref={containerRef}
      className="fixed z-[100] shadow-2xl rounded-lg overflow-hidden bg-gray-900 border border-gray-700"
      style={{ left: pos.x, top: pos.y, width: isMinimized ? 200 : 240 }}
    >
      {/* Title bar */}
      <div
        className="flex items-center justify-between px-2 py-1 bg-gray-800 cursor-move select-none"
        onMouseDown={handleMouseDown}
      >
        <span className="text-[10px] text-gray-300 font-medium flex items-center gap-1">
          <Video size={10} />
          Webcam Preview
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setIsMinimized(!isMinimized)}
            className="p-0.5 text-gray-400 hover:text-white transition-colors"
            title={isMinimized ? 'Expand' : 'Minimize'}
          >
            {isMinimized ? <Maximize2 size={10} /> : <Minimize2 size={10} />}
          </button>
          <button
            onClick={() => setIsOpen(false)}
            className="p-0.5 text-gray-400 hover:text-red-400 transition-colors"
            title="Close preview"
          >
            <X size={10} />
          </button>
        </div>
      </div>

      {/* Video area */}
      {!isMinimized && (
        <div className="relative bg-black" style={{ aspectRatio: '4/3' }}>
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover"
            style={{ transform: 'scaleX(-1)' }}
          />
          {!hasStream && (
            <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-xs">
              No active webcam
            </div>
          )}
          {hasStream && (
            <div className="absolute bottom-1 left-1 flex items-center gap-1">
              <span
                className={`w-1.5 h-1.5 rounded-full animate-pulse ${faceDetected ? 'bg-green-500' : 'bg-red-500'}`}
              />
              <span className="text-[9px] text-white/70">
                {faceDetected ? 'Face detected' : 'No face'}
              </span>
            </div>
          )}
          {/* Face detection border indicator */}
          {hasStream && faceDetected && (
            <div className="absolute inset-2 border-2 border-green-500/50 rounded pointer-events-none" />
          )}
        </div>
      )}
    </div>
  );
}
