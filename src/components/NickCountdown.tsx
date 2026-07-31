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
// Borrows down the chain so each field stays in range (days uses the real length
// of the month we borrow from).
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

  // Big primary unit — years / months / days.
  const Big = ({ value, label }: { value: number; label: string }) => (
    <div className="flex flex-col items-center">
      <span className="tabular-nums font-black leading-none text-6xl sm:text-8xl" style={{ color: NAVY }}>
        {value}
      </span>
      <span className="mt-3 text-[10px] sm:text-xs uppercase tracking-[0.3em]" style={{ color: `${NAVY}80` }}>
        {label}
      </span>
    </div>
  );
  // Smaller secondary unit — hours / minutes / seconds.
  const Small = ({ value, label }: { value: string; label: string }) => (
    <div className="flex flex-col items-center">
      <span className="tabular-nums font-bold leading-none text-3xl sm:text-5xl" style={{ color: `${NAVY}cc` }}>
        {value}
      </span>
      <span className="mt-2 text-[9px] sm:text-[11px] uppercase tracking-[0.25em]" style={{ color: `${NAVY}66` }}>
        {label}
      </span>
    </div>
  );

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

      {/* The full-screen countdown — rendered via a portal to document.body so it
          fills the WHOLE screen. Solid white, MAC navy + gold. */}
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-white"
            onClick={() => setOpen(false)}
          >
            <div className="relative px-8 text-center" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="absolute -top-6 right-0 text-2xl transition-colors"
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
                <>
                  {/* Primary: years / months / days */}
                  <div className="flex items-start justify-center gap-10 sm:gap-20">
                    <Big value={b.y} label={b.y === 1 ? 'Year' : 'Years'} />
                    <Big value={b.mo} label={b.mo === 1 ? 'Month' : 'Months'} />
                    <Big value={b.d} label={b.d === 1 ? 'Day' : 'Days'} />
                  </div>

                  {/* Secondary: hours / minutes / seconds */}
                  <div className="mt-12 flex items-start justify-center gap-8 sm:gap-14">
                    <Small value={pad(b.h)} label="Hours" />
                    <Small value={pad(b.mi)} label="Minutes" />
                    <Small value={pad(b.s)} label="Seconds" />
                  </div>
                </>
              )}

              <div className="mt-14 text-sm" style={{ color: `${NAVY}66` }}>
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
