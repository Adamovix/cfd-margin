# cfd-margin — Margin call map

A one-page site that shows **on the price chart where a CFD position gets margin-called**.
Type your deposit, investment and leverage, or just **drag the line** on the chart.

- Orange line = margin call, red dashed line = stop-out, grey dotted line = your open price.
- Lock **Deposit** or **Investment**. Dragging the line changes the other one.
- Long and short positions.
- Prices: VIX (spot), VIX futures (front month, which is what XTB's "VIX" CFD follows), S&P 500.
  "Other" lets you type any price.
- Settings are saved in the URL (bookmark or share a setup) and in your browser.
  There is no backend.

## Turn on GitHub Pages (one time)

1. Merge this into `main`.
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Open the **Actions** tab and run **Deploy site with fresh prices** (or push to `main`).

The site will be at `https://<user>.github.io/cfd-margin/`.

## Where the prices come from

Cboe publishes free delayed quotes, but only lets browsers on cboe.com read them (CORS).
So the page can't fetch them itself. Instead the workflow in
`.github/workflows/pages.yml` runs `scripts/fetch-data.mjs` and publishes the data next to
the page:

- every 15 min on weekdays, 12:00–22:00 UTC (US trading hours), plus once after the futures settle;
- the open page checks for new data every 2 minutes.

So prices are **15 min delayed by Cboe, plus up to ~15–20 min until the next run**.
VIX futures are end-of-day settlement prices. You can always type the price from your
broker into **Open price**.

> GitHub turns off scheduled workflows in public repos after 60 days without any commits.
> If prices stop updating, re-enable the workflow in the Actions tab.

To add an instrument, add an entry to `INSTRUMENTS` in `scripts/fetch-data.mjs`.
It works for any symbol with history on Cboe's delayed quotes.

## The math

```
account balance  = deposit + investment
units            = investment × leverage / open price
equity(P)        = balance ± units × (P − open price)        (+ long, − short)
used margin(P)   = units × P / leverage                      (recalculated at the current price, like XTB)
margin level(P)  = equity(P) / used margin(P)
```

The margin call price is the `P` where the margin level equals your margin call %.
Same for stop-out. Code: `js/margin.js`, tests: `tests/margin.test.mjs`.

**Not included:** other positions on the same account, swaps/overnight fees, spread,
currency moves (USD instrument on a PLN account), rollover gaps, and price gaps
(price can jump past the line).

Check your broker's actual levels. XTB documents a stop-out at 50 % for most accounts;
the margin call level depends on the XTB entity.

## Run locally

```bash
npm run data     # downloads prices into ./data
npm run serve    # http://localhost:8000
npm test         # margin math tests
```

Chart: [TradingView Lightweight Charts™](https://github.com/tradingview/lightweight-charts)
(Apache 2.0, vendored in `vendor/`). Not financial advice.
