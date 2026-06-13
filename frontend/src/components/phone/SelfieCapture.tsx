"use client";

import { useRef, useState, useCallback, useEffect } from "react";

interface SelfieCaptureProps {
  onCapture: (base64: string) => void;
}

export default function SelfieCapture({ onCapture }: SelfieCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [captured, setCaptured] = useState<string | null>(null);
  const [cameraAvailable, setCameraAvailable] = useState(true);
  const [cameraStarted, setCameraStarted] = useState(false);

  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: 512, height: 512 },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setCameraStarted(true);
    } catch {
      setCameraAvailable(false);
    }
  }, []);

  useEffect(() => {
    startCamera();
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [startCamera]);

  const resizeToSquare = useCallback((source: HTMLVideoElement | HTMLImageElement): string => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext("2d")!;

    // Center-crop to square
    const sw = "videoWidth" in source ? source.videoWidth : source.naturalWidth;
    const sh = "videoHeight" in source ? source.videoHeight : source.naturalHeight;
    const size = Math.min(sw, sh);
    const sx = (sw - size) / 2;
    const sy = (sh - size) / 2;

    ctx.drawImage(source, sx, sy, size, size, 0, 0, 512, 512);
    return canvas.toDataURL("image/jpeg", 0.8).split(",")[1];
  }, []);

  const takePhoto = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const base64 = resizeToSquare(video);
    setCaptured(`data:image/jpeg;base64,${base64}`);
    onCapture(base64);
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }, [resizeToSquare, onCapture]);

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const img = new Image();
      img.onload = () => {
        const base64 = resizeToSquare(img);
        setCaptured(`data:image/jpeg;base64,${base64}`);
        onCapture(base64);
      };
      img.src = URL.createObjectURL(file);
    },
    [resizeToSquare, onCapture]
  );

  const retake = useCallback(() => {
    setCaptured(null);
    startCamera();
  }, [startCamera]);

  if (captured) {
    return (
      <div className="flex flex-col items-center gap-2">
        <div className="w-28 h-28 rounded-full overflow-hidden border-2 border-zinc-200">
          <img
            src={captured}
            alt="Selfie preview"
            className="w-full h-full object-cover"
          />
        </div>
        <button
          onClick={retake}
          className="text-xs text-zinc-500 underline"
        >
          Retake
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2">
      {cameraAvailable && cameraStarted ? (
        <>
          <div className="w-28 h-28 rounded-full overflow-hidden border-2 border-zinc-200">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover scale-x-[-1]"
            />
          </div>
          <button
            onClick={takePhoto}
            className="rounded-full bg-zinc-900 text-white px-5 py-1.5 text-xs font-semibold"
          >
            Take Photo
          </button>
        </>
      ) : (
        <>
          <div className="w-28 h-28 rounded-full bg-zinc-100 flex items-center justify-center border-2 border-dashed border-zinc-300">
            <span className="text-zinc-400 text-2xl">📷</span>
          </div>
          <label className="rounded-full bg-zinc-900 text-white px-5 py-1.5 text-xs font-semibold cursor-pointer">
            Choose Photo
            <input
              type="file"
              accept="image/*"
              capture="user"
              onChange={handleFileUpload}
              className="hidden"
            />
          </label>
        </>
      )}
    </div>
  );
}
