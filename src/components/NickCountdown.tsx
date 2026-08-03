import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// The moment this first went live for Nick is stored once in localStorage, so the
// clock keeps counting down to the SAME target across reloads. Target = start + 2y 7m 31d.
const START_KEY = 'nick-countdown-start-v1';

function computeTarget(): Date {
  let iso = localStorage.getItem(START_KEY);
  if (!iso) {
    iso = new Date().toISOString();
    localStorage.setItem(START_KEY, iso);
  }
  const t = new Date(iso);
  t.setFullYear(t.getFullYear() + 2);
  t.setMonth(t.getMonth() + 7);
  t.setDate(t.getDate() + 31);
  return t;
}

// Calendar-correct breakdown from now to target: years, months, days, then h/m/s.
function breakdown(now: Date, target: Date) {
  if (now >= target) return { y: 0, mo: 0, d: 0, h: 0, mi: 0, s: 0 };
  let y = target.getFullYear() - now.getFullYear();
  let mo = target.getMonth() - now.getMonth();
  let d = target.getDate() - now.getDate();
  let h = target.getHours() - now.getHours();
  let mi = target.getMinutes() - now.getMinutes();
  let s = target.getSeconds() - now.getSeconds();
  if (s < 0) { s += 60; mi--; }
  if (mi < 0) { mi += 60; h--; }
  if (h < 0) { h += 24; d--; }
  if (d < 0) { d += new Date(target.getFullYear(), target.getMonth(), 0).getDate(); mo--; }
  if (mo < 0) { mo += 12; y--; }
  return { y, mo, d, h, mi, s };
}

const pad = (n: number) => String(n).padStart(2, '0');

const NAVY = '#0a1930';
const GOLD = '#c9a227';

export function NickCountdown({ collapsed }: { collapsed: boolean }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [target] = useState(() => computeTarget());

  // Tick every second only while the screen is open.
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open]);

  const b = breakdown(new Date(now), target);
  const done = target.getTime() <= now;

  // One straight row of split-flap units. Each digit is its own card; a digit only
  // re-mounts (and re-plays the flip) when its value actually changes, like a real
  // flip clock. Years lead the row instead of days.
  const units: { v: string; label: string }[] = [
    { v: pad(b.y), label: 'Years' },
    { v: pad(b.mo), label: 'Months' },
    { v: pad(b.d), label: 'Days' },
    { v: pad(b.h), label: 'Hours' },
    { v: pad(b.mi), label: 'Minutes' },
    { v: pad(b.s), label: 'Seconds' },
  ];

  return (
    <div className="px-2 pb-1">
      {/* The button — sidebar style, matching the others */}
      <button
        onClick={() => setOpen(true)}
        title="Countdown"
        className="w-full flex items-center gap-3 px-4 py-3 text-sm rounded-lg transition-all text-blue-200 hover:text-white hover:bg-white/5"
      >
        <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        {!collapsed && <span className="font-medium">Countdown</span>}
      </button>

      {/* Full-screen countdown — white overlay, dark split-flap cards in one row. */}
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-white"
            onClick={() => setOpen(false)}
          >
            <style>{`
              @keyframes nickflip {
                0%   { transform: rotateX(-85deg); opacity: .2; }
                55%  { opacity: 1; }
                100% { transform: rotateX(0deg); opacity: 1; }
              }
              .nick-flip {
                position: relative; display: flex; align-items: center; justify-content: center;
                width: 2.75rem; height: 3.75rem; border-radius: .5rem;
                background: linear-gradient(#3a3a40, #202024);
                color: #f6f5f1; font-weight: 800; font-variant-numeric: tabular-nums;
                font-size: 2.25rem; line-height: 1; transform-origin: center;
                box-shadow: 0 8px 16px rgba(10,25,48,.28), inset 0 1px 0 rgba(255,255,255,.07);
                animation: nickflip .45s cubic-bezier(.2,.7,.2,1);
              }
              .nick-flip::after {
                content: ""; position: absolute; left: 0; right: 0; top: 50%; height: 1px;
                background: rgba(0,0,0,.5); box-shadow: 0 1px 0 rgba(255,255,255,.05);
              }
              @media (min-width: 640px) {
                .nick-flip { width: 3.5rem; height: 4.75rem; font-size: 3rem; }
              }
            `}</style>

            <div className="relative px-6 text-center" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="absolute -top-8 right-0 text-2xl transition-colors"
                style={{ color: `${NAVY}66` }}
              >
                ✕
              </button>

              <div className="text-4xl sm:text-6xl font-black tracking-tight" style={{ color: NAVY }}>
                Nick's Retirement
              </div>
              <div className="mx-auto mt-5 mb-2 h-[3px] w-24 rounded-full" style={{ backgroundColor: GOLD }} />
              <div className="mb-12 text-xs sm:text-sm uppercase tracking-[0.35em]" style={{ color: `${NAVY}80` }}>
                Time Remaining
              </div>

              {done ? (
                <div className="text-5xl font-black" style={{ color: NAVY }}>Time's up. Enjoy retirement.</div>
              ) : (
                <div
                  className="flex items-start justify-center gap-3 sm:gap-5 overflow-x-auto"
                  style={{ perspective: '800px' }}
                >
                  {units.map((u) => (
                    <div key={u.label} className="flex flex-col items-center gap-2 flex-shrink-0">
                      <div className="flex gap-1">
                        {u.v.split('').map((ch, di) => (
                          <div key={`${di}-${ch}`} className="nick-flip">{ch}</div>
                        ))}
                      </div>
                      <span
                        className="text-[10px] sm:text-xs uppercase tracking-[0.25em]"
                        style={{ color: `${NAVY}99` }}
                      >
                        {u.label}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-12 text-sm" style={{ color: `${NAVY}66` }}>
                Target:{' '}
                {target.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
