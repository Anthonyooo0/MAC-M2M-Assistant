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

const pad = (n: number) => String(n).padStart(2, '0');

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

  const remaining = Math.max(0, target.getTime() - now);
  const days = Math.floor(remaining / 86_400_000);
  const hours = Math.floor((remaining % 86_400_000) / 3_600_000);
  const mins = Math.floor((remaining % 3_600_000) / 60_000);
  const secs = Math.floor((remaining % 60_000) / 1_000);

  const Unit = ({ value, label, big = false }: { value: string; label: string; big?: boolean }) => (
    <div className="flex flex-col items-center">
      <span
        className={`tabular-nums font-bold text-white leading-none drop-shadow-[0_0_26px_rgba(147,197,253,0.4)] ${
          big ? 'text-6xl sm:text-8xl' : 'text-4xl sm:text-6xl'
        }`}
      >
        {value}
      </span>
      <span className="mt-2 text-[10px] sm:text-xs uppercase tracking-[0.25em] text-blue-200/50">{label}</span>
    </div>
  );
  const Sep = () => <span className="text-4xl sm:text-6xl font-bold text-white/20 pb-6 select-none">:</span>;

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

      {/* The full-screen countdown — rendered via a portal to document.body so it's
          centered on the WHOLE screen, not trapped inside the sidebar. MAC navy. */}
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-gradient-to-br from-[#0a1930]/97 to-[#16345c]/97 backdrop-blur-md"
            onClick={() => setOpen(false)}
          >
            <div className="relative px-8 text-center" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="absolute -top-12 right-0 text-3xl text-white/50 hover:text-white transition-colors"
              >
                ✕
              </button>

              <div className="mb-2 text-3xl sm:text-5xl font-bold tracking-tight text-white">Nick's Retirement</div>
              <div className="mb-10 text-xs sm:text-sm uppercase tracking-[0.35em] text-blue-200/70">Time Remaining</div>

              <div className="flex items-end justify-center gap-3 sm:gap-8 font-mono">
                <Unit value={String(days)} label="Days" big />
                <Sep />
                <Unit value={pad(hours)} label="Hours" />
                <Sep />
                <Unit value={pad(mins)} label="Minutes" />
                <Sep />
                <Unit value={pad(secs)} label="Seconds" />
              </div>

              <div className="mt-10 text-sm text-blue-200/50">
                Target:{' '}
                {target.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}
              </div>
              {remaining === 0 && <div className="mt-4 text-2xl font-bold text-white">Time's up.</div>}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
