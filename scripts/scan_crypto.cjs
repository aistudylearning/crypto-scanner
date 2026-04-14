const https = require('https'); 
const fs = require('fs');
const { execSync } = require('child_process');
const { RSI, BollingerBands, MACD, OBV, VWAP } = require('technicalindicators');

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

// ─── Technical Indicators using technicalindicators library ───────────────

function isOBVRising(closes, volumes, lookback = 5) {
  if (closes.length < lookback * 2 + 1 || volumes.length < lookback * 2 + 1) return false;
  
  const obvResult = OBV.calculate({
    close: closes,
    volume: volumes
  });
  
  if (obvResult.length < lookback * 2) return false;
  
  const recent = obvResult.slice(-lookback).reduce((a, b) => a + b, 0) / lookback;
  const prior = obvResult.slice(-lookback * 2, -lookback).reduce((a, b) => a + b, 0) / lookback;
  return recent > prior;
}

function isPriceBelowVWAP(closes, highs, lows, volumes) {
  if (closes.length === 0) return false;
  
  const vwapResult = VWAP.calculate({
    high: highs,
    low: lows,
    close: closes,
    volume: volumes
  });
  
  if (vwapResult.length === 0) return false;
  
  const currentVWAP = vwapResult[vwapResult.length - 1];
  const currentClose = closes[closes.length - 1];
  
  return currentClose < currentVWAP;
}

function isBollingerSqueeze(closes, period = 14, lookback = 5) {
  if (closes.length < period + lookback) return false;

  function getBandWidth(slice) {
    const bbResult = BollingerBands.calculate({
      period: period,
      values: slice,
      stdDev: 2
    });
    
    if (bbResult.length === 0) return null;
    
    const lastBB = bbResult[bbResult.length - 1];
    const width = (lastBB.upper - lastBB.lower) / lastBB.middle;
    return width;
  }

  const currentWidth = getBandWidth(closes.slice(-period));
  if (currentWidth === null) return false;
  
  let isNarrowest = true;
  for (let i = 1; i <= lookback; i++) {
    const prevWidth = getBandWidth(closes.slice(-period - i, -i));
    if (prevWidth === null || prevWidth <= currentWidth) {
      isNarrowest = false;
      break;
    }
  }
  return isNarrowest;
}

function isMACDBullishCross(closes) {
  if (closes.length < 35) return false; // Need at least 26 + 9 periods
  
  const macdResult = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });
  
  if (macdResult.length < 2) return false;
  
  const prev = macdResult[macdResult.length - 2];
  const curr = macdResult[macdResult.length - 1];
  
  // Bullish cross: MACD line crosses above signal line
  return prev.MACD < prev.signal && curr.MACD >= curr.signal;
}

// ─── Scoring ──────────────────────────────────────────────────────────────

function scoreAsset({ closes, highs, lows, volumes }) {
  let score = 0;
  const signals = [];

  // Calculate RSI using technicalindicators library
  const rsiResult = RSI.calculate({
    values: closes,
    period: 14
  });
  
  const rsi = rsiResult.length > 0 ? rsiResult[rsiResult.length - 1] : 50;
  
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
          `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=40`
        );
        if (klines.length < 35) continue;

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
            Generated by OpenClaw Trading Bot · Using technicalindicators library
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
