import { useMemo } from 'react';
import type { CSSProperties } from 'react';

const CONFETTI_COLORS = ['#ef4444', '#f59e0b', '#fbbf24', '#ffffff'];
const CONFETTI_COUNT = 18;

interface ConfettiPiece {
  left: number;
  color: string;
  delay: number;
  duration: number;
  drift: number;
  rotate: number;
  width: number;
  height: number;
}

interface TaskCelebrationOverlayProps {
  active: boolean;
}

export function TaskCelebrationOverlay({ active }: TaskCelebrationOverlayProps) {
  const pieces = useMemo<ConfettiPiece[]>(
    () =>
      Array.from({ length: CONFETTI_COUNT }, (_, i): ConfettiPiece => ({
        left: 4 + ((i * 41 + 7) % 92),
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        delay: (i % 6) * 0.12,
        duration: 1.5 + (i % 5) * 0.15,
        drift: ((i % 7) - 3) * 36,
        rotate: 360 + (i % 4) * 180,
        width: 7 + (i % 3) * 3,
        height: 10 + (i % 3) * 4,
      })),
    [],
  );

  if (!active) return null;

  return (
    <div
      className="pointer-events-none fixed inset-0 z-50 overflow-hidden"
      aria-hidden="true"
    >
      {pieces.map((piece: ConfettiPiece, i: number) => (
        <span
          key={i}
          className="task-confetti-piece"
          style={
            {
              left: `${piece.left}%`,
              backgroundColor: piece.color,
              width: `${piece.width}px`,
              height: `${piece.height}px`,
              animationDelay: `${piece.delay}s`,
              animationDuration: `${piece.duration}s`,
              '--confetti-x': `${piece.drift}px`,
              '--confetti-r': `${piece.rotate}deg`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
