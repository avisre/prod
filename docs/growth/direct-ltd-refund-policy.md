# Direct lifetime deal — refund policy

This is the customer-facing refund policy text for the lifetime deal bought
**directly from StockPortfolio.pro** at [/lifetime](https://www.stockportfolio.pro/lifetime).

## The policy

> If you bought your StockPortfolio.pro lifetime plan directly from us at
> stockportfolio.pro/lifetime, you can request a full refund within **30 days**
> of purchase, no questions asked. Email support@stockportfolio.pro with the
> email address you purchased under and we'll process it.
>
> This is a separate policy from AppSumo's. If you bought this deal **on
> AppSumo**, your purchase is covered by **AppSumo's own 60-day refund
> policy**, and refunds for that purchase must go through AppSumo's refund
> process (AppSumo account → Orders), not us — we cannot issue a refund for
> an AppSumo-billed purchase.

## Where this appears

- `/lifetime` page footer note ([frontend-v2/lifetime.html](../../frontend-v2/lifetime.html)),
  with the number pulled live from `/api/lifetime/config` so it can never
  drift from the actual `DIRECT_LTD_REFUND_DAYS` value.
- Stripe Checkout submit-button copy for every direct LTD tier.
- The post-purchase confirmation email (`appsumo_onboarding` template,
  direct-channel branch), which also explicitly tells AppSumo buyers to use
  AppSumo's process instead.

## Config

`DIRECT_LTD_REFUND_DAYS` (env var, default `30`) is the single source of
truth for the window length. Read via `direct-ltd.js`'s `refundDays()`.

## How a refund is actually processed

Run the admin script:

```
node scripts/refund-direct-ltd.js --user <userId> [--dry-run] [--force]
```

It refuses to run against an AppSumo-channel purchase, checks the purchase
date against the refund window (use `--force` only for an approved
exception), issues the Stripe refund, and revokes the lifetime grant.
