'use strict';

// Share only work that is currently running. Completed values and their TTLs
// still belong to the caller's existing cache; rejected work is never retained.
module.exports = function createSingleFlight() {
    const pending = new Map();
    return function singleFlight(key, load) {
        if (pending.has(key)) return pending.get(key);
        const job = Promise.resolve().then(load).finally(() => {
            if (pending.get(key) === job) pending.delete(key);
        });
        pending.set(key, job);
        return job;
    };
};
