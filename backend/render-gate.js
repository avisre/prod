'use strict';
// Caps how many expensive page renders run at once; the rest wait their turn.
//
// A /stocks/:ticker render loads the company's evidence payload (tens of MB of heap) and holds it while
// it awaits the quote. Nothing limited how many ran together: a burst of uncached stock pages filled
// the 512 MB Starter instance's ~259 MB heap and the process aborted (exit 134 five times between
// 2026-11-14 and 11-17, 888 requests answered 502). Measured locally on the same 0.5 CPU / 512 MB:
// 16 renders at once died with "JavaScript heap out of memory"; 2 at once already gave 1.9 pages/s
// against 2.0 at 4, because the CPU is the ceiling either way. A waiting request holds almost nothing,
// so it queues instead of being refused, up to a bounded queue and a bounded wait.
function createGate({ max = 2, queueMax = 40, waitMs = 20000 } = {}) {
    let active = 0;
    const queue = [];
    const counts = { queued: 0, shed: 0, timedOut: 0 };

    function releaser() {
        let done = false;
        return () => {
            if (done) return;
            done = true;
            const next = queue.shift();
            // Hand the slot straight to the next waiter, so `active` never dips and lets a newcomer jump the queue.
            if (next) { clearTimeout(next.timer); next.resolve(releaser()); } else active -= 1;
        };
    }

    // Resolves to a release function once a slot is free, or to null when the queue is full or the wait ran out.
    function acquire() {
        if (active < max) { active += 1; return Promise.resolve(releaser()); }
        if (queue.length >= queueMax) { counts.shed += 1; return Promise.resolve(null); }
        counts.queued += 1;
        return new Promise((resolve) => {
            const entry = { resolve };
            entry.timer = setTimeout(() => {
                const at = queue.indexOf(entry);
                if (at >= 0) queue.splice(at, 1);
                counts.timedOut += 1;
                resolve(null);
            }, waitMs);
            queue.push(entry);
        });
    }

    return {
        acquire,
        busy: () => active >= max,
        stats: () => ({ active, waiting: queue.length, ...counts })
    };
}

module.exports = { createGate };
