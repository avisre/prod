# Trial lifecycle email policy (support-only)

This document supersedes the 8 July personal-Gmail outreach draft. Customer
messages must be sent only through `support@stockportfolio.pro`, with SMTP
credentials kept in Render secrets. Never send a cold bulk campaign or
retroactively email every expired trial.

## Approved, idempotent stages

- Welcome and activation guidance after signup.
- Trial ending in two days.
- Trial expired.
- AppSumo activation.
- Honest-review request only after meaningful usage; never incentivize a review.

Each stage has an opt-out check and a persisted sent marker, so retries cannot
double-send. A failed SMTP connection must not prevent the expiration sweep from
marking an eligible no-card trial expired.

## Support-safe templates

**Welcome — subject:** Welcome to StockPortfolio.pro

Hi [name],\n\nWelcome. Start with one company question, open the cited filing
evidence, and reply to this email if anything blocks you.\n\n— StockPortfolio.pro
Support

**Two days left — subject:** Two days left in your StockPortfolio.pro trial

Hi [name],\n\nYour trial ends on [date]. If you have not yet checked a source-backed
answer, reply with a company and question and we will point you to the fastest
workflow.\n\n— StockPortfolio.pro Support

**Expired — subject:** Your StockPortfolio.pro trial has ended

Hi [name],\n\nYour no-card trial ended on [date]. Your account remains available for
sign-in; upgrade details are here: [AppSumo link]. Reply if you need help or do
not want further lifecycle mail.\n\n— StockPortfolio.pro Support

**AppSumo activation — subject:** Your StockPortfolio.pro access is ready

Hi [name],\n\nYour AppSumo access is active. Ask one question, inspect its cited source,
and reply if you would like onboarding help.\n\n— StockPortfolio.pro Support

**Review request — subject:** Would you share an honest AppSumo review?

Hi [name],\n\nIf you have used StockPortfolio.pro enough to form an opinion, an honest
review is helpful. Please mention what you researched, whether the source trail
helped, and what still needs work: [review link].\n\n— StockPortfolio.pro Support
