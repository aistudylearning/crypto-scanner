const https = require('https'); const fs = require('fs');
const { execSync } = require('child_process');

const EMAIL_TO = 'ai.study.learning@gmail.com';


// ─── Scoring thresholds ────────────────────────────────────────────────────
// Score breakdown (max 9):
//   TA  – RSI < 25 (+1), Bollinger squeeze (+1), MACD bullish cross (+1)
//   Vol – OBV rising (+2), price below VWAP (+1)
//   FA  – (crypto: no macro feed, reserved for future Reddit/X NLP)
//
// Score ≥ 4 → send email
// Score 3   → log only
// Score 1-2 → skip

const SCORE_EMAIL_THRESHOLD = 4;
const SCORE_LOG_THRESHOLD = 3;
const RSI_OVERSOLD = 25;
const TOP_N_PAIRS = 50;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Node.js' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ─── Technical Indicators ─────────────────────────────────────────────────

/**
 * Standard 14-period RSI using simple average (Wilder's first-period method).
 * Requires at least 15 closes.
 */
function calculateRSI(closes) {
  if (closes.length < 15) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i < 15; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / 14;
  const avgLoss = losses / 14;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

/**
 * On-Balance Volume (OBV).
 * Returns true if OBV has been rising over the last `lookback` periods —
 * a sign of accumulation even while price is low.
 */
function isOBVRising(closes, volumes, lookback = 5) {
  if (closes.length < lookback + 1 || volumes.length < lookback + 1) return false;
  const obv = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1])      obv.push(obv[i - 1] + volumes[i]);
    else if (closes[i] < closes[i - 1]) obv.push(obv[i - 1] - volumes[i]);
    else                                 obv.push(obv[i - 1]);
  }
  // Compare average of last `lookback` periods vs the period before
  const recent = obv.slice(-lookback).reduce((a, b) => a + b, 0) / lookback;
  const prior  = obv.slice(-lookback * 2, -lookback).reduce((a, b) => a + b, 0) / lookback;
  return recent > prior;
}

/**
 * Volume-Weighted Average Price (VWAP) over all provided candles.
 * Returns true if the current (last) close is below VWAP.
 */
function isPriceBelowVWAP(closes, highs, lows, volumes) {
  let cumTPV = 0, cumVol = 0;
  for (let i = 0; i < closes.length; i++) {
    const typicalPrice = (highs[i] + lows[i] + closes[i]) / 3;
    cumTPV += typicalPrice * volumes[i];
    cumVol += volumes[i];
  }
  if (cumVol === 0) return false;
  const vwap = cumTPV / cumVol;
  return closes[closes.length - 1] < vwap;
}

/**
 * Bollinger Band squeeze detector.
 * A squeeze means the band width is at its narrowest in `lookback` periods —
 * a sign that a large move is imminent. Combine with RSI < 25 for high quality.
 */
function isBollingerSqueeze(closes, period = 14, lookback = 5) {
  if (closes.length < period + lookback) return false;

  function bandWidth(slice) {
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
    const stdDev = Math.sqrt(variance);
    return (stdDev * 2) / mean; // normalised width
  }

  const currentWidth = bandWidth(closes.slice(-period));
  let isNarrowest = true;
  for (let i = 1; i <= lookback; i++) {
    const prevWidth = bandWidth(closes.slice(-period - i, -i));
    if (prevWidth <= currentWidth) { isNarrowest = false; break; }
  }
  return isNarrowest;
}

/**
 * Simple MACD bullish crossover detector.
 * Returns true if the MACD line just crossed above the signal line.
 */
function isMACDBullishCross(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return false;

  function ema(data, period) {
    const k = 2 / (period + 1);
    let result = data[0];
    for (let i = 1; i < data.length; i++) {
      result = data[i] * k + result * (1 - k);
    }
    return result;
  }

  // Build MACD line over last (signal + 1) points so we can compare prev vs current
  const macdLine = [];
  for (let i = closes.length - signal - 1; i < closes.length; i++) {
    const slice = closes.slice(0, i + 1);
    macdLine.push(ema(slice.slice(-slow), fast) - ema(slice.slice(-slow), slow));
  }

  const signalLine = macdLine.slice(-signal).reduce((a, b) => a + b, 0) / signal;
  const prevMACD   = macdLine[macdLine.length - 2];
  const currMACD   = macdLine[macdLine.length - 1];

  return prevMACD < signalLine && currMACD >= signalLine;
}

// ─── Scoring ──────────────────────────────────────────────────────────────

function scoreAsset({ closes, highs, lows, volumes }) {
  let score = 0;
  const signals = [];

  const rsi = calculateRSI(closes);
  if (rsi < RSI_OVERSOLD) {
    score += 1;
    signals.push(`RSI ${rsi.toFixed(1)} (oversold)`);
  }

  if (isBollingerSqueeze(closes)) {
    score += 1;
    signals.push('Bollinger squeeze (breakout imminent)');
  }

  if (isMACDBullishCross(closes)) {
    score += 1;
    signals.push('MACD bullish crossover');
  }

  if (isOBVRising(closes, volumes)) {
    score += 2; // worth double — OBV rising + low RSI = accumulation
    signals.push('OBV rising (accumulation)');
  }

  if (isPriceBelowVWAP(closes, highs, lows, volumes)) {
    score += 1;
    signals.push('Price below VWAP (undervalued vs. session avg)');
  }

  return { score, rsi, signals };
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function run() {
  try {
    console.log(`Fetching top ${TOP_N_PAIRS} USDT pairs by 24h volume from Binance...`);
    const tickers = await fetchJson('https://api.binance.com/api/v3/ticker/24hr');
    const usdtPairs = tickers
      .filter(t => t.symbol.endsWith('USDT'))
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, TOP_N_PAIRS)
      .map(t => t.symbol);

    const strongSignals = []; // score >= SCORE_EMAIL_THRESHOLD
    const weakSignals   = []; // score === SCORE_LOG_THRESHOLD

    for (const symbol of usdtPairs) {
      try {
        // Fetch 30 candles so MACD and Bollinger lookbacks have enough data
        const klines = await fetchJson(
          `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=30`
        );
        if (klines.length < 27) continue;

        const closes  = klines.map(k => parseFloat(k[4]));
        const highs   = klines.map(k => parseFloat(k[2]));
        const lows    = klines.map(k => parseFloat(k[3]));
        const volumes = klines.map(k => parseFloat(k[5]));

        const { score, rsi, signals } = scoreAsset({ closes, highs, lows, volumes });
        const price = closes[closes.length - 1];

        if (score >= SCORE_EMAIL_THRESHOLD) {
          strongSignals.push({ symbol, score, rsi: rsi.toFixed(2), price, signals });
          console.log(`STRONG SIGNAL [${score}/9]: ${symbol}  RSI=${rsi.toFixed(1)}`);
        } else if (score === SCORE_LOG_THRESHOLD) {
          weakSignals.push({ symbol, score, rsi: rsi.toFixed(2), price, signals });
          console.log(`Weak signal  [${score}/9]: ${symbol}  RSI=${rsi.toFixed(1)}`);
        }
      } catch (e) {
        console.error(`Error fetching ${symbol}:`, e.message);
      }
    }

    console.log(`\nWeak signals (logged only): ${weakSignals.length}`);

    if (strongSignals.length > 0) {
      console.log(`Found ${strongSignals.length} strong signals. Formatting HTML...`);

      const htmlRows = strongSignals.map(asset => {
        const scoreColor = asset.score >= 6 ? '#d32f2f' : '#f57c00';
        const signalList = asset.signals.map(s => `<li style="margin:2px 0;">${s}</li>`).join('');
        return `<tr>
          <td style="padding:10px;border-bottom:1px solid #eee;">
            <a href="https://www.tradingview.com/chart/?symbol=BINANCE:${asset.symbol}"
               target="_blank" style="color:#1976d2;text-decoration:none;">
              <strong>${asset.symbol}</strong>
            </a>
          </td>
          <td style="padding:10px;border-bottom:1px solid #eee;color:${scoreColor};font-weight:bold;font-size:18px;">
            ${asset.score}/9
          </td>
          <td style="padding:10px;border-bottom:1px solid #eee;color:#f57c00;font-weight:bold;">
            ${asset.rsi}
          </td>
          <td style="padding:10px;border-bottom:1px solid #eee;">$${asset.price}</td>
          <td style="padding:10px;border-bottom:1px solid #eee;font-size:12px;color:#555;">
            <ul style="margin:0;padding-left:16px;">${signalList}</ul>
          </td>
        </tr>`;
      }).join('');

      const htmlBody = `
        <div style="font-family:Arial,sans-serif;color:#333;max-width:750px;margin:0 auto;border:1px solid #ddd;padding:20px;border-radius:8px;">
          <h2 style="color:#d32f2f;margin-top:0;">Crypto Alert: ${strongSignals.length} Strong Signals (score ≥ ${SCORE_EMAIL_THRESHOLD}/9)</h2>
          <p style="font-size:13px;color:#555;">
            Multi-indicator composite scoring: RSI + OBV + VWAP + Bollinger squeeze + MACD crossover.<br>
            Only assets scoring ≥ ${SCORE_EMAIL_THRESHOLD}/9 are included. Higher score = more indicators aligned.
          </p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
              <tr style="background:#f8f9fa;text-align:left;">
                <th style="padding:10px;border-bottom:2px solid #ddd;">Pair</th>
                <th style="padding:10px;border-bottom:2px solid #ddd;">Score</th>
                <th style="padding:10px;border-bottom:2px solid #ddd;">RSI (1h)</th>
                <th style="padding:10px;border-bottom:2px solid #ddd;">Price</th>
                <th style="padding:10px;border-bottom:2px solid #ddd;">Signals fired</th>
              </tr>
            </thead>
            <tbody>${htmlRows}</tbody>
          </table>
          <p style="font-size:11px;color:#999;margin-top:24px;text-align:center;">
            Generated by OpenClaw Trading Bot · Composite scoring v2
          </p>
        </div>
      `.replace(/\n/g, ' ');

      console.log('Sending email alert...');
      const subjectTag = strongSignals.some(a => a.score >= 6) ? '🔴' : '🟠';
      const GOG_COMMAND = '/home/cuong/.local/bin/gog mail send';
      const tempBodyFile = '/tmp/cb.html';
      fs.writeFileSync(tempBodyFile, htmlBody);
      const cmd = `${GOG_COMMAND} --to "${EMAIL_TO}" --subject "${subjectTag} Crypto Alert: ${strongSignals.length} Strong Signals (score ≥ ${SCORE_EMAIL_THRESHOLD}/9)" --body-file "${tempBodyFile}"`;
      try {
          execSync(cmd, { stdio: 'inherit' });
      } finally {
          if (fs.existsSync(tempBodyFile)) fs.unlinkSync(tempBodyFile);
      }
    } else {
      console.log('No strong signals this hour (all assets scored below threshold).');
    }
  } catch (e) {
    console.error('Fatal error:', e);
  }
}

run();
