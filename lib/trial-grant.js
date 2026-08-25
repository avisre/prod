'use strict';

// Single source of truth for "does this pre-grant open the gate right now".
//
// Deliberately pure and date-driven: access ends at expiresAt, read live off
// the record. No cron run is required for a grant to stop working, so a job
// that fails to run cannot silently extend anyone's free access. An explicit
// revokedAt also closes the gate immediately, for taking a grant back early.

function isGrantActive(grant, feature, now = Date.now()) {
    if (!grant || grant.feature !== feature) return false;
    if (grant.revokedAt) return false;
    if (!grant.expiresAt) return false;
    return new Date(grant.expiresAt).getTime() > now;
}

function hasActiveTrialGrant(user, feature, now = Date.now()) {
    const grants = (user && user.trialGrant) || [];
    return grants.some((g) => isGrantActive(g, feature, now));
}

module.exports = { isGrantActive, hasActiveTrialGrant };
