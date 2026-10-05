'use strict';

/**
 * One income-statement period repaired into absolute, chartable figures.
 *
 * Exists because three consumers each needed the same repairs and only one of
 * them had it: toolGetFinancials (ai-chat.js) carried the logic inline, the
 * dossier payload carried only MARGINS and no absolute dollars at all, and the
 * Normal-mode "where the money goes" band silently rendered empty for years
 * because it read grossProfit/costOfRevenue off rows that never had them.
 *
 * The repairs, all of which are load-bearing against real filings:
 *
 *   A filed 0 means "not disclosed", not "zero". XOM stores the literal string
 *   "0" for costOfRevenue, grossProfit, operatingExpenses and incomeTaxExpense.
 *   Treating that as a real zero claims a 100% gross margin. Every field that
 *   cannot legitimately be zero for an operating company goes through present().
 *
 *   Gross profit and cost of revenue each imply the other given revenue, so one
 *   missing side is recoverable. Only ~6 of 8 sampled tickers file both.
 *
 *   Tax is recoverable as incomeBeforeTax - netIncome when that is positive.
 *
 *   Banks (JPM) file revenue, tax and net income and nothing else — no COGS, no
 *   gross profit, no operating income. That is not an error and must not be
 *   repaired into one: the fields stay null and the caller renders a shorter
 *   flow. `derived` names every field computed rather than filed, so a chart can
 *   mark them and a reader is never shown an inference as a filed figure.
 *
 * NOT DERIVED, DELIBERATELY: operating expenses are never reconstructed by
 * summing R&D + SG&A. The component list in this source is demonstrably
 * incomplete — ZTS FY2025 files SG&A 2,378M with R&D empty and operatingExpenses
 * "0", so the sum understates opex by the whole R&D line and would have implied
 * an operating income of 4,423M against an actual ~3,582M (pre-tax 3,360M plus
 * 222M interest). A 25% overstatement, presented as fact. Only exact arithmetic
 * is allowed here: each of operatingIncome and operatingExpenses may be derived
 * from the other because gross profit ties them, and nothing else.
 *
 * `operatingAndOtherCosts` is the honest substitute when neither is filed:
 * grossProfit - incomeBeforeTax is exact by construction, and R&D/SG&A are
 * carried alongside as known *components* of it rather than as its total.
 */

function num(v) {
    if (v === null || v === undefined || v === '' || v === 'None') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// Zero is indistinguishable from absent in this source, and for these line
// items absent is overwhelmingly the truth. Revenue and netIncome are NOT run
// through this — a company really can post zero revenue or break exactly even.
function present(v) {
    const n = num(v);
    return n === 0 ? null : n;
}

function repairIncome(report) {
    if (!report) return null;
    const derived = [];
    const disclosed = field => report._sources?.[field]?.length ? num(report[field]) : present(report[field]);

    const revenue = num(report.totalRevenue);
    let grossProfit = disclosed('grossProfit');
    let costOfRevenue = disclosed('costOfRevenue');
    if (costOfRevenue === null) costOfRevenue = disclosed('costofGoodsAndServicesSold');

    if (revenue !== null) {
        if (grossProfit === null && costOfRevenue !== null) { grossProfit = revenue - costOfRevenue; derived.push('grossProfit'); }
        else if (costOfRevenue === null && grossProfit !== null) { costOfRevenue = revenue - grossProfit; derived.push('costOfRevenue'); }
    }

    const researchAndDevelopment = disclosed('researchAndDevelopment');
    const sellingGeneralAndAdministrative = disclosed('sellingGeneralAndAdministrative');

    // Gross profit ties these two, so either recovers the other exactly. Never
    // build opex from its components — see the note above.
    let operatingExpenses = disclosed('operatingExpenses');
    let operatingIncome = disclosed('operatingIncome');
    if (grossProfit !== null) {
        if (operatingExpenses === null && operatingIncome !== null) { operatingExpenses = grossProfit - operatingIncome; derived.push('operatingExpenses'); }
        else if (operatingIncome === null && operatingExpenses !== null) { operatingIncome = grossProfit - operatingExpenses; derived.push('operatingIncome'); }
    }

    const incomeBeforeTax = num(report.incomeBeforeTax);
    const netIncome = num(report.netIncome);
    let tax = disclosed('incomeTaxExpense');
    if (tax === null && incomeBeforeTax !== null && netIncome !== null && incomeBeforeTax - netIncome > 0) {
        tax = incomeBeforeTax - netIncome;
        derived.push('tax');
    }

    let interestExpense = disclosed('interestExpense');
    if (interestExpense === null) interestExpense = disclosed('interestAndDebtExpense');

    return {
        periodEnd: report.fiscalDateEnding || null,
        fy: String(report.fiscalDateEnding || '').slice(0, 4) || null,
        currency: String(report.reportedCurrency || 'USD').toUpperCase(),
        revenue,
        costOfRevenue,
        grossProfit,
        researchAndDevelopment,
        sellingGeneralAndAdministrative,
        operatingExpenses,
        operatingIncome,
        interestExpense,
        incomeBeforeTax,
        tax,
        netIncome,
        // Exact by construction whenever both ends are filed: everything between
        // gross profit and pre-tax income, whether or not the filer broke it out.
        operatingAndOtherCosts: (grossProfit !== null && incomeBeforeTax !== null)
            ? grossProfit - incomeBeforeTax
            : null,
        derived
    };
}

module.exports = { repairIncome, num, present };
