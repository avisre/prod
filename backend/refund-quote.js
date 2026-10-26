'use strict';

// The 7-day initial-payment refund, priced (owner decision 2026-10-26).
//
// Monthly ($79.99, the lowest plan) keeps a full refund. Every plan priced
// above it (Annual, Pro, Desk, Dev) refunds the payment minus the credits the
// account spent since paying, charged at the top-up rate ($14.99 per 150
// credits). Without this, a yearly buyer could spend a month of credits, or
// two when the window crosses the 1st, and take the whole payment back while
// Stripe keeps its fee.
//
// Only credits from the plan allowance count. Spend beyond it came out of
// top-up packs the customer bought separately, and those are not refunded, so
// charging for them again would bill the same credits twice.
//
// Whether a payment is priced this way is decided once, when it is recorded
// (initialRefundDeductsUsage), so a customer who paid under the full-refund
// terms keeps them.

function deductsUsage(planPrice, lowestPlanPrice) {
    const price = Number(planPrice);
    const lowest = Number(lowestPlanPrice);
    return Number.isFinite(price) && Number.isFinite(lowest) && price > lowest;
}

// spentByMonth: [{ month: 'YYYY-MM', spent }] for spend since the payment.
// monthlyAllowance: the plan's credits per month.
// topupPriceMinor / topupCredits: the top-up pack, e.g. 1499 / 150.
function quote({ paidMinor, spentByMonth, monthlyAllowance, topupPriceMinor, topupCredits }) {
    const paid = Math.max(0, Math.round(Number(paidMinor) || 0));
    const cap = Math.max(0, Number(monthlyAllowance) || 0);
    const creditsUsed = (Array.isArray(spentByMonth) ? spentByMonth : [])
        .reduce((sum, row) => sum + Math.min(Math.max(0, Number(row && row.spent) || 0), cap), 0);
    const perCredit = Number(topupCredits) > 0 ? Number(topupPriceMinor) / Number(topupCredits) : 0;
    const deductionMinor = Math.min(paid, Math.round(creditsUsed * perCredit));
    return { paidMinor: paid, creditsUsed, deductionMinor, refundMinor: paid - deductionMinor };
}

module.exports = { deductsUsage, quote };
