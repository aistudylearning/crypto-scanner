---
name: crypto-scanner
description: A scanner that checks Binance for assets meeting specific criteria (like RSI < 30 on 1m timeframe) and alerts via email.
---

# Crypto Scanner

This skill runs a Node.js script that connects to the public Binance API, fetches the top 50 USDT pairs by volume, calculates the 1-minute RSI for each, and alerts `family.denhaag@gmail.com` if any asset is below 30 (oversold).

## Usage
Run the following script:

```bash
node D:\dev\OpenClaw\config\.openclaw\workspace\skills\crypto-scanner\scripts\scan_crypto.js
```
